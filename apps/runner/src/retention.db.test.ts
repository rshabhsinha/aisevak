import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = "/tmp/aisevak-retention-test"; });
import { createPool, runMigrations, type DbPool } from "@aisevak/core";
import { sweepRetention, type RetentionPolicy } from "./retention.js";

// The retention sweep against a real Postgres: what expires, what is archived
// and purged, and what is protected. Runs when AISEVAK_TEST_DATABASE_URL points
// at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

const POLICY: RetentionPolicy = { retentionDays: 30, archivePurgeDays: 7, scratchDays: 7, budgetMs: 60_000, batchSize: 2 };
const DAY = 86_400_000;

describe.skipIf(!databaseUrl)("retention sweep against Postgres", () => {
  let pool: DbPool;
  let root: string;
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const exists = async (table: string, id: string) => (await q(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).length > 0;

  beforeAll(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool);
    root = await realpath(await mkdtemp(join(tmpdir(), "aisevak-retention-")));
  });
  afterAll(async () => {
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function agent() {
    const [row] = await q("INSERT INTO agents (name, description, model, instructions) VALUES ($1,'a','gpt-test','x') RETURNING id", [`Retention-${randomUUID().slice(0, 8)}`]);
    return row.id as string;
  }
  async function task(agentId: string, status: string, updatedDaysAgo: number) {
    const [row] = await q(
      `INSERT INTO tasks (title, agent_id, status, work_scope, work_key, work_fingerprint, updated_at)
       VALUES ('T', $1, $2, 'test', $3, 'f', $4) RETURNING id`,
      [agentId, status, `retention-${randomUUID()}`, ago(updatedDaysAgo)]
    );
    return row.id as string;
  }
  async function thread(agentId: string, options: { taskId?: string | null; activeDaysAgo: number; home?: string }) {
    const [row] = await q(
      `INSERT INTO agent_threads (agent_id, task_id, provider_instance_id, model, title, cwd, runtime_home, created_at, updated_at, last_activity_at)
       SELECT $1, $2, id, 'gpt-test', 't', '/tmp', $3, $4, $4, $4 FROM provider_instances LIMIT 1 RETURNING id`,
      [agentId, options.taskId ?? null, options.home ?? `/tmp/${randomUUID()}`, ago(options.activeDaysAgo)]
    );
    return row.id as string;
  }
  async function dispatcherRun(threadId: string | null, status: string, finishedDaysAgo: number, taskId: string | null = null) {
    const [row] = await q(
      `INSERT INTO dispatcher_runs (task_id, agent_thread_id, scope, status, cwd, codex_home, model, prompt, queued_at, finished_at, updated_at)
       VALUES ($1, $2, 'coordination', $3, '/tmp', '/tmp', 'gpt-test', 'p', $4, $4, $4) RETURNING id`,
      [taskId, threadId, status, ago(finishedDaysAgo)]
    );
    await q("INSERT INTO dispatcher_run_events (dispatcher_run_id, seq, event_type, payload) VALUES ($1, 1, 'item', '{}'::jsonb)", [row.id]);
    return row.id as string;
  }

  it("expires old finished runs with their events, and keeps recent and active ones", async () => {
    const old = await dispatcherRun(null, "succeeded", 40);
    const recent = await dispatcherRun(null, "failed", 5);
    const active = await dispatcherRun(null, "running", 40);
    await sweepRetention(pool, root, POLICY);
    expect(await exists("dispatcher_runs", old)).toBe(false);
    expect(await q("SELECT 1 FROM dispatcher_run_events WHERE dispatcher_run_id = $1", [old])).toEqual([]);
    expect(await exists("dispatcher_runs", recent)).toBe(true);
    expect(await exists("dispatcher_runs", active)).toBe(true);
  });

  it("deletes finished tasks past the window, but not open ones or ones with an uncleaned worktree", async () => {
    const agentId = await agent();
    const done = await task(agentId, "completed", 40);
    const doneThread = await thread(agentId, { taskId: done, activeDaysAgo: 40 });
    const open = await task(agentId, "open", 40);
    const withWorktree = await task(agentId, "completed", 40);
    const [session] = await q("INSERT INTO task_sessions (task_id, agent_snapshot, codex_home) VALUES ($1, '{}'::jsonb, '/tmp') RETURNING id", [withWorktree]);
    await q(
      `INSERT INTO task_runs (task_id, task_session_id, run_kind, status, cwd, model, prompt, workspace_mode, workspace_source, worktree_path, branch, finished_at, updated_at)
       VALUES ($1, $2, 'worker', 'succeeded', '/tmp', 'gpt-test', 'p', 'git_worktree', 'github', $3, 'agent/x', $4, $4)`,
      [withWorktree, session.id, `/srv/worktrees/${randomUUID()}`, ago(40)]
    );
    await sweepRetention(pool, root, POLICY);
    expect(await exists("tasks", done)).toBe(false);
    expect(await exists("agent_threads", doneThread)).toBe(false);
    expect(await exists("tasks", open)).toBe(true);
    // Its run holds the only record of a checkout still on disk.
    expect(await exists("tasks", withWorktree)).toBe(true);
    expect(await q("SELECT 1 FROM task_runs WHERE task_id = $1", [withWorktree])).toHaveLength(1);
  });

  it("archives chats idle for the window, except ones in use or a schedule runs into", async () => {
    const agentId = await agent();
    const idle = await thread(agentId, { activeDaysAgo: 40 });
    const busy = await thread(agentId, { activeDaysAgo: 40 });
    await dispatcherRun(busy, "succeeded", 2);
    const scheduled = await thread(agentId, { activeDaysAgo: 40 });
    await q(
      `INSERT INTO schedules (title, prompt, agent_id, schedule_kind, next_run_at, interval_seconds, enabled, last_agent_thread_id)
       VALUES ('S', 'p', $1, 'interval', now(), 3600, true, $2)`,
      [agentId, scheduled]
    );
    const fresh = await thread(agentId, { activeDaysAgo: 1 });
    await sweepRetention(pool, root, POLICY);
    const state = async (id: string) => (await q("SELECT archived_at IS NOT NULL AS archived, cleanup_state FROM agent_threads WHERE id = $1", [id]))[0];
    expect(await state(idle)).toEqual({ archived: true, cleanup_state: "pending" });
    expect((await state(busy)).archived).toBe(false);
    expect((await state(scheduled)).archived).toBe(false);
    expect((await state(fresh)).archived).toBe(false);
  });

  it("purges archived chats after the grace period once their harness is cleared", async () => {
    const agentId = await agent();
    const home = join(root, "codex-homes", `purge-${randomUUID()}`);
    const purged = await thread(agentId, { activeDaysAgo: 3, home });
    // Recent run: only the purge removes it, not run expiry.
    const run = await dispatcherRun(purged, "succeeded", 3);
    await q("UPDATE agent_threads SET archived_at = $2, cleanup_state = 'done' WHERE id = $1", [purged, ago(8)]);
    const graced = await thread(agentId, { activeDaysAgo: 3 });
    await q("UPDATE agent_threads SET archived_at = $2, cleanup_state = 'done' WHERE id = $1", [graced, ago(2)]);
    const uncleared = await thread(agentId, { activeDaysAgo: 3 });
    await q("UPDATE agent_threads SET archived_at = $2, cleanup_state = 'pending' WHERE id = $1", [uncleared, ago(8)]);
    await mkdir(home, { recursive: true });

    await sweepRetention(pool, root, POLICY);
    expect(await exists("agent_threads", purged)).toBe(false);
    expect(await exists("dispatcher_runs", run)).toBe(false);
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await exists("agent_threads", graced)).toBe(true);
    expect(await exists("agent_threads", uncleared)).toBe(true);
  });

  it("removes stale unreferenced homes and scratch, keeping referenced and recently used ones", async () => {
    const agentId = await agent();
    const homes = join(root, "codex-homes");
    const orphan = join(homes, `orphan-${randomUUID()}`);
    const referenced = join(homes, `chat-${randomUUID()}`);
    const recentlyUsed = join(homes, `orphan-recent-${randomUUID()}`);
    const scratch = join(root, "tmp", "TASK-1");
    const liveScratch = join(root, "tmp", "TASK-2");
    for (const dir of [orphan, referenced, recentlyUsed, scratch, liveScratch]) await mkdir(join(dir, "nested"), { recursive: true });
    await thread(agentId, { activeDaysAgo: 1, home: referenced });
    const old = new Date(Date.now() - 20 * DAY);
    for (const dir of [orphan, referenced, recentlyUsed, scratch, liveScratch]) {
      await utimes(join(dir, "nested"), old, old);
      await utimes(dir, old, old);
    }
    // Work deep inside an old-looking entry keeps it.
    await writeFile(join(liveScratch, "nested", "notes.md"), "in progress");
    // A run that used this home last week (its directory time looks old).
    await q(
      `INSERT INTO dispatcher_runs (scope, status, cwd, codex_home, model, prompt, finished_at, updated_at)
       VALUES ('coordination', 'succeeded', '/tmp', $1, 'gpt-test', 'p', now(), now())`,
      [recentlyUsed]
    );

    // An agent left part of this scratch read-only (as npm package contents are).
    await mkdir(join(scratch, "nested", "package", "lib"), { recursive: true });
    await chmod(join(scratch, "nested", "package"), 0o555);
    await utimes(join(scratch, "nested", "package"), old, old);
    await utimes(join(scratch, "nested"), old, old);
    await utimes(scratch, old, old);

    await sweepRetention(pool, root, POLICY);
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(referenced)).isDirectory()).toBe(true);
    expect((await stat(recentlyUsed)).isDirectory()).toBe(true);
    expect((await stat(liveScratch)).isDirectory()).toBe(true);
  });

  it("never archives a chat whose task is still being worked on", async () => {
    const agentId = await agent();
    const openTask = await task(agentId, "needs_attention", 40);
    const chat = await thread(agentId, { taskId: openTask, activeDaysAgo: 40 });
    const doneTask = await task(agentId, "completed", 1);
    const doneChat = await thread(agentId, { taskId: doneTask, activeDaysAgo: 40 });
    await sweepRetention(pool, root, POLICY);
    const archived = async (id: string) => (await q("SELECT archived_at IS NOT NULL AS archived FROM agent_threads WHERE id = $1", [id]))[0].archived;
    expect(await archived(chat)).toBe(false);
    expect(await archived(doneChat)).toBe(true);
  });

  it("keeps a long-finished task whose chat was used recently", async () => {
    const agentId = await agent();
    const finished = await task(agentId, "completed", 60);
    const chat = await thread(agentId, { taskId: finished, activeDaysAgo: 60 });
    // A message turn on the finished task's chat does not touch tasks.updated_at.
    await dispatcherRun(chat, "succeeded", 1, finished);
    await sweepRetention(pool, root, POLICY);
    expect(await exists("tasks", finished)).toBe(true);
    expect(await exists("agent_threads", chat)).toBe(true);
  });

  it("keeps open requests, open assignments' messages and open tasks' conversations", async () => {
    const agentId = await agent();
    const coordination = async (taskId: string | null) => (await q(
      "INSERT INTO coordination_threads (title, task_id, last_activity_at) VALUES ('C', $1, $2) RETURNING id", [taskId, ago(40)]))[0].id as string;
    const message = async (threadId: string, extra: string = "") => (await q(
      `INSERT INTO thread_messages (thread_id, sender_agent_id, body, created_at${extra ? ", request_state" : ""})
       VALUES ($1, $2, 'm', $3${extra ? ", $4" : ""}) RETURNING id`,
      extra ? [threadId, agentId, ago(40), extra] : [threadId, agentId, ago(40)]))[0].id as string;
    const quiet = await coordination(null);
    const expired = await message(quiet);
    const openRequest = await message(quiet, "open");
    const assigned = await message(quiet);
    const openTask = await task(agentId, "open", 40);
    await q(
      `INSERT INTO task_assignments (task_id, assignment_key, assigned_agent_id, status, instructions, fingerprint, request_message_id)
       VALUES ($1, 'key', $2, 'running', 'do it', 'f', $3)`,
      [openTask, agentId, assigned]
    );
    const working = await coordination(openTask);
    const conversation = await message(working);
    await sweepRetention(pool, root, POLICY);
    expect(await exists("thread_messages", expired)).toBe(false);
    expect(await exists("thread_messages", openRequest)).toBe(true);
    expect(await exists("thread_messages", assigned)).toBe(true);
    expect(await exists("thread_messages", conversation)).toBe(true);
    // The quiet thread still holds an open request, so it stays too.
    expect(await exists("coordination_threads", quiet)).toBe(true);
  });

  it("clears a run with more events than one delete statement takes", async () => {
    const run = await dispatcherRun(null, "succeeded", 40);
    await q(
      `INSERT INTO dispatcher_run_events (dispatcher_run_id, seq, event_type, payload)
       SELECT $1, seq, 'item', '{}'::jsonb FROM generate_series(2, 12001) seq`,
      [run]
    );
    const result = await sweepRetention(pool, root, POLICY);
    expect(result.errors).toEqual([]);
    expect(await exists("dispatcher_runs", run)).toBe(false);
    expect(await q("SELECT 1 FROM dispatcher_run_events WHERE dispatcher_run_id = $1 LIMIT 1", [run])).toEqual([]);
  });

  it("keeps each report's newest revisions and drops older full copies", async () => {
    const agentId = await agent();
    const [report] = await q(
      "INSERT INTO reports (title, description, status, author_agent_id, current_revision) VALUES ('Backlog', 'd', 'published', $1, 25) RETURNING id",
      [agentId]
    );
    await q(
      `INSERT INTO report_versions (report_id, revision, markdown, created_by_agent_id)
       SELECT $1, revision, 'copy ' || revision, $2 FROM generate_series(1, 25) revision`,
      [report.id, agentId]
    );
    await sweepRetention(pool, root, POLICY);
    const kept = (await q("SELECT revision FROM report_versions WHERE report_id = $1 ORDER BY revision", [report.id])).map((row) => row.revision);
    expect(kept).toEqual(Array.from({ length: 20 }, (_, index) => index + 6));
  });

  it("does nothing when retention is disabled", async () => {
    const old = await dispatcherRun(null, "succeeded", 400);
    const result = await sweepRetention(pool, root, { ...POLICY, retentionDays: 0 });
    expect(result).toMatchObject({ archivedThreads: 0, purgedThreads: 0, deleted: {} });
    expect(await exists("dispatcher_runs", old)).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = "/tmp/aisevak-timeline-test"; });
import { createPool, runMigrations, type DbPool } from "@aisevak/core";
import { loadTimelineEvents } from "./server.js";

// The bounded timeline query against a real Postgres: which events it picks,
// their order (ties included) and truncation, in thread and task mode. Runs
// when AISEVAK_TEST_DATABASE_URL points at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

type Expected = { source: "run" | "dispatcher" | "input"; id: string; queued: number; created: number; seq: number };

describe.skipIf(!databaseUrl)("timeline events against Postgres", () => {
  let pool: DbPool;
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  beforeAll(async () => { pool = createPool(databaseUrl); await runMigrations(pool); });
  afterAll(async () => { await pool?.end(); });

  async function seed() {
    const suffix = randomUUID().slice(0, 8);
    const [agent] = await q("INSERT INTO agents (name, description, model, instructions) VALUES ($1,'a','gpt-test','x') RETURNING id", [`Timeline-${suffix}`]);
    const [task] = await q("INSERT INTO tasks (title, agent_id, work_scope, work_key, work_fingerprint) VALUES ('T', $1, 'test', $2, 'f') RETURNING id", [agent.id, `timeline-${suffix}`]);
    const [session] = await q("INSERT INTO task_sessions (task_id, agent_snapshot, codex_home) VALUES ($1, '{}'::jsonb, '/tmp') RETURNING id", [task.id]);
    const thread = async (taskId: string | null) => (await q(
      `INSERT INTO agent_threads (agent_id, task_id, provider_instance_id, model, title, cwd, runtime_home)
       SELECT $1, $2, id, 'gpt-test', 't', '/tmp', '/tmp/' || gen_random_uuid() FROM provider_instances LIMIT 1 RETURNING id`,
      [agent.id, taskId]))[0].id as string;
    const mine = await thread(task.id);
    // Another agent's session working on the same task (a task owns one thread).
    const other = await thread(null);
    const base = Date.parse("2026-11-01T00:00:00Z");
    const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
    const expected: Expected[] = [];

    const workerRun = async (threadId: string, queued: number, kind = "worker") => (await q(
      `INSERT INTO task_runs (task_id, task_session_id, agent_thread_id, run_kind, status, cwd, model, prompt, queued_at)
       VALUES ($1, $2, $3, $4, 'succeeded', '/tmp', 'gpt-test', 'p', $5) RETURNING id`,
      [task.id, session.id, threadId, kind, at(queued)]))[0].id as string;
    const dispatcherRun = async (threadId: string, queued: number) => (await q(
      `INSERT INTO dispatcher_runs (task_id, agent_thread_id, scope, status, cwd, codex_home, model, prompt, queued_at)
       VALUES ($1, $2, 'coordination', 'succeeded', '/tmp', '/tmp', 'gpt-test', 'p', $3) RETURNING id`,
      [task.id, threadId, at(queued)]))[0].id as string;
    const event = async (table: "run_events" | "dispatcher_run_events", runId: string, seq: number, created: number) => (await q(
      `INSERT INTO ${table} (${table === "run_events" ? "run_id" : "dispatcher_run_id"}, seq, event_type, text, payload, created_at)
       VALUES ($1, $2, 'item', $3, '{}'::jsonb, $4) RETURNING id`,
      [runId, seq, `event ${seq}`, at(created)]))[0].id as string;

    // Two worker runs queued at the same moment, with events sharing created_at.
    for (const runId of [await workerRun(mine, 10), await workerRun(mine, 10)]) {
      for (let seq = 1; seq <= 4; seq += 1) expected.push({ source: "run", id: await event("run_events", runId, seq, 11), queued: 10, created: 11, seq });
    }
    const coordination = await dispatcherRun(mine, 5);
    for (let seq = 1; seq <= 3; seq += 1) expected.push({ source: "dispatcher", id: await event("dispatcher_run_events", coordination, seq, 6 + seq), queued: 5, created: 6 + seq, seq });
    const [input] = await q(
      `INSERT INTO agent_turn_inputs (agent_thread_id, dispatcher_run_id, message, status, created_at) VALUES ($1, $2, 'steer', 'delivered', $3) RETURNING id`,
      [mine, coordination, at(8)]);
    expected.push({ source: "input", id: input.id, queued: 5, created: 8, seq: 0 });
    // Not on the timeline: a review run, and another thread of the same task.
    const review = await workerRun(mine, 20, "review");
    await event("run_events", review, 1, 21);
    const elsewhere = await dispatcherRun(other, 30);
    const otherEvent = await event("dispatcher_run_events", elsewhere, 1, 31);
    return { taskId: task.id as string, threadId: mine, expected, otherEvent };
  }

  // Newest first by (queued_at, created_at, seq, id), keep `limit`, oldest first.
  const reference = (rows: Expected[], limit: number) => {
    const sorted = [...rows].sort((a, b) => b.queued - a.queued || b.created - a.created || b.seq - a.seq || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return { ids: sorted.slice(0, limit).reverse().map((row) => row.id), truncated: sorted.length > limit };
  };

  it("selects, orders and truncates a thread's events like the reference ordering", async () => {
    const { threadId, expected } = await seed();
    for (const limit of [3, 6, expected.length, expected.length + 5]) {
      const result = await loadTimelineEvents(pool, null, threadId, limit);
      const want = reference(expected, limit);
      expect(result.events.map((row) => row.id)).toEqual(want.ids);
      expect(result.truncated).toBe(want.truncated);
    }
    const all = await loadTimelineEvents(pool, null, threadId, 100);
    const input = all.events.find((row) => row.event_type === "thread.message-sent");
    expect(input?.payload).toMatchObject({ role: "user", text: "steer", deliveryStatus: "delivered" });
  });

  it("covers every thread of the task in task mode, still skipping review runs", async () => {
    const { taskId, expected, otherEvent } = await seed();
    const withOther = [...expected, { source: "dispatcher" as const, id: otherEvent, queued: 30, created: 31, seq: 1 }];
    const result = await loadTimelineEvents(pool, taskId, null, 100);
    expect(result.events.map((row) => row.id)).toEqual(reference(withOther, 100).ids);
    expect(result.truncated).toBe(false);
  });
});

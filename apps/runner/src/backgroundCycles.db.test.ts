import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = "/tmp/aisevak-background-cycle-test"; });
import { createPool, ensureConcurrentIndexes, runMigrations, type DbPool } from "@aisevak/core";
import { createBackgroundCycleRecorder } from "./backgroundCycles.js";
import { persistDispatcherCodexLine, scheduledTaskIsIdle } from "./index.js";
import { activeRunIds } from "./runLeases.js";

// Runs when AISEVAK_TEST_DATABASE_URL points at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("background cycles and idle schedule ticks", () => {
  let pool: DbPool;
  beforeAll(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool);
    await ensureConcurrentIndexes(pool);
  });
  afterAll(async () => { await pool?.end(); });

  async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const result = await pool.query(sql, params);
    return result.rows[0] as T;
  }

  async function fixture() {
    const agent = await one<{ id: string }>(
      "INSERT INTO agents (name, description, model, instructions) VALUES ($1, 'a', 'claude-test', 'x') RETURNING id",
      [`Background-${randomUUID().slice(0, 8)}`]
    );
    const task = await one<{ id: string }>(
      `INSERT INTO tasks (title, agent_id, status, work_scope, work_key, work_fingerprint)
       VALUES ('Campaign', $1, 'running', 'test', $2, 'f') RETURNING id`,
      [agent.id, `bg-${randomUUID()}`]
    );
    const thread = await one<{ id: string }>(
      `INSERT INTO coordination_threads (title, task_id, primary_agent_id) VALUES ('Campaign', $1, $2) RETURNING id`,
      [task.id, agent.id]
    );
    await pool.query("UPDATE tasks SET coordination_thread_id = $2 WHERE id = $1", [task.id, thread.id]);
    const agentThread = await one<{ id: string }>(
      `INSERT INTO agent_threads (agent_id, task_id, provider_instance_id, model, title, cwd, runtime_home, provider_thread_id)
       SELECT $1, $2, id, 'claude-test', 't', '/tmp', '/tmp/home', 'ses-1' FROM provider_instances LIMIT 1 RETURNING id`,
      [agent.id, task.id]
    );
    const run = await one<{ id: string }>(
      `INSERT INTO dispatcher_runs (task_id, agent_thread_id, trigger, scope, status, cwd, codex_home, model, prompt, started_at, finished_at)
       VALUES ($1, $2, 'message', 'coordination', 'succeeded', '/tmp', '/tmp/home', 'claude-test', 'p', now(), now()) RETURNING id`,
      [task.id, agentThread.id]
    );
    return { agentId: agent.id, taskId: task.id, threadId: thread.id, agentThreadId: agentThread.id, runId: run.id };
  }

  const chunk = (text: string) => JSON.stringify({ method: "session/update", params: { sessionId: "ses-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  const result = JSON.stringify({ method: "session/update", params: { sessionId: "ses-1", update: { sessionUpdate: "usage_update", used: 5, size: 10, cost: { amount: 0.25, currency: "USD" } } } });
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition not reached");
  };

  it("records a cycle as a running background run on the thread and ends it at the cycle's result", async () => {
    const f = await fixture();
    const record = createBackgroundCycleRecorder(pool, { sourceRunId: f.runId, driver: "claude" },
      (runId, line, seq, normalizer) => persistDispatcherCodexLine(pool, { id: runId }, line, seq, normalizer),
      { endAfterResultMs: 30 });
    await record(chunk("finish returned rc=0"));
    const running = await one<{ id: string; status: string; scope: string; trigger: string; codex_thread_id: string; task_id: string }>(
      "SELECT id, status::text, scope, trigger, codex_thread_id, task_id FROM dispatcher_runs WHERE agent_thread_id = $1 AND scope = 'background'",
      [f.agentThreadId]
    );
    expect(running).toMatchObject({ status: "running", trigger: "background", codex_thread_id: "ses-1", task_id: f.taskId });
    expect(activeRunIds("dispatcher")).toContain(running.id);
    await record(result);
    await waitFor(async () => (await one<{ status: string }>("SELECT status::text FROM dispatcher_runs WHERE id = $1", [running.id])).status === "succeeded");
    expect(activeRunIds("dispatcher")).not.toContain(running.id);
    const events = await pool.query("SELECT seq FROM dispatcher_run_events WHERE dispatcher_run_id = $1 ORDER BY seq", [running.id]);
    expect(events.rows.map((row) => row.seq)).toEqual([1, 2]);

    // The next cycle gets its own run.
    await record(chunk("cleanup done"));
    const runs = await pool.query("SELECT id FROM dispatcher_runs WHERE agent_thread_id = $1 AND scope = 'background'", [f.agentThreadId]);
    expect(runs.rows).toHaveLength(2);
  });

  it("drops a cycle while another turn runs on the thread", async () => {
    const f = await fixture();
    await pool.query(
      `INSERT INTO dispatcher_runs (task_id, agent_thread_id, trigger, scope, status, cwd, codex_home, model, prompt, started_at)
       VALUES ($1, $2, 'message', 'coordination', 'running', '/tmp', '/tmp/home', 'claude-test', 'p', now())`,
      [f.taskId, f.agentThreadId]
    );
    const persisted: string[] = [];
    const record = createBackgroundCycleRecorder(pool, { sourceRunId: f.runId, driver: "claude" },
      async (_runId, line) => { persisted.push(line); }, { endAfterResultMs: 10 });
    await record(chunk("x"));
    await record(result);
    expect(persisted).toEqual([]);
    const runs = await pool.query("SELECT id FROM dispatcher_runs WHERE agent_thread_id = $1 AND scope = 'background'", [f.agentThreadId]);
    expect(runs.rows).toHaveLength(0);
  });

  it("treats a task-bound schedule tick as idle only when nothing changed since the last tick ran", async () => {
    const f = await fixture();
    const schedule = await one<{ id: string }>(
      `INSERT INTO schedules (title, prompt, agent_id, schedule_kind, next_run_at, interval_seconds, task_id, idle_skip_max_seconds)
       VALUES ('tick', 'p', $1, 'interval', now(), 1800, $2, 7200) RETURNING id`,
      [f.agentId, f.taskId]
    );
    const input = { scheduleId: schedule.id, agentId: f.agentId, taskId: f.taskId, coordinationThreadId: f.threadId, maxIdleSeconds: 7200 };
    // No tick has run yet.
    expect(await scheduledTaskIsIdle(pool, input)).toBe(false);
    const tick = await one<{ id: string }>(
      `INSERT INTO dispatcher_runs (task_id, agent_thread_id, trigger, scope, status, cwd, codex_home, model, prompt, started_at, finished_at)
       VALUES ($1, $2, 'schedule', 'coordination', 'succeeded', '/tmp', '/tmp/home', 'claude-test', 'p', now() - interval '10 minutes', now()) RETURNING id`,
      [f.taskId, f.agentThreadId]
    );
    await pool.query("INSERT INTO schedule_runs (schedule_id, dispatcher_run_id, scheduled_for) VALUES ($1, $2, now() - interval '10 minutes')", [schedule.id, tick.id]);
    expect(await scheduledTaskIsIdle(pool, input)).toBe(true);
    // The schedule agent's own messages do not count as activity.
    await pool.query("INSERT INTO thread_messages (thread_id, sender_agent_id, body) VALUES ($1, $2, 'my summary')", [f.threadId, f.agentId]);
    expect(await scheduledTaskIsIdle(pool, input)).toBe(true);
    // A child task changing does.
    const child = await one<{ id: string }>(
      `INSERT INTO tasks (title, agent_id, status, work_scope, work_key, work_fingerprint, parent_task_id)
       VALUES ('Child', $1, 'completed', 'test', $2, 'f', $3) RETURNING id`,
      [f.agentId, `bg-child-${randomUUID()}`, f.taskId]
    );
    expect(await scheduledTaskIsIdle(pool, input)).toBe(false);
    await pool.query("UPDATE tasks SET updated_at = now() - interval '1 hour' WHERE id = $1", [child.id]);
    expect(await scheduledTaskIsIdle(pool, input)).toBe(true);
    // A message from someone else does.
    await pool.query("INSERT INTO thread_messages (thread_id, body, message_type) VALUES ($1, 'delivery failed', 'delivery.failed')", [f.threadId]);
    expect(await scheduledTaskIsIdle(pool, input)).toBe(false);
    // And past the maximum idle time a tick always runs.
    await pool.query("DELETE FROM thread_messages WHERE thread_id = $1 AND message_type = 'delivery.failed'", [f.threadId]);
    expect(await scheduledTaskIsIdle(pool, { ...input, maxIdleSeconds: 300 })).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = "/tmp/aisevak-usage-events-test"; });
import { createPool, createRuntimeNormalizer, runMigrations, type DbPool } from "@aisevak/core";
import { persistCodexLine, persistDispatcherCodexLine } from "./index.js";

// Usage-bearing events are copied into usage_events as they are stored; the
// cost tab reads only that table. Runs when AISEVAK_TEST_DATABASE_URL points
// at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("usage events copied on write", () => {
  let pool: DbPool;
  beforeAll(async () => { pool = createPool(databaseUrl); await runMigrations(pool); });
  afterAll(async () => { await pool?.end(); });

  it("copies turn results with usage, and nothing else", async () => {
    const [run] = (await pool.query(
      `INSERT INTO dispatcher_runs (scope, status, cwd, codex_home, model, prompt)
       VALUES ('coordination', 'running', '/tmp', '/tmp', 'claude-opus-5-5', 'p') RETURNING id`
    )).rows;
    const normalizer = createRuntimeNormalizer("claude");
    const lines = [
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } },
      { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } }
    ];
    for (const [seq, line] of lines.entries()) await persistDispatcherCodexLine(pool, { id: run.id }, JSON.stringify(line), seq, normalizer);
    // A redelivered line (same seq) is stored once.
    await persistDispatcherCodexLine(pool, { id: run.id }, JSON.stringify(lines[1]), 1, normalizer);
    const copied = (await pool.query("SELECT run_kind, event_type, payload FROM usage_events WHERE run_id = $1", [run.id])).rows;
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ run_kind: "dispatcher", event_type: "turn.completed" });
    expect(copied[0].payload.raw.payload.result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("copies a worker run's usage too", async () => {
    const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const [agent] = await q("INSERT INTO agents (name, description, model, instructions) VALUES ($1,'a','gpt-test','x') RETURNING id", [`Usage-${Date.now()}`]);
    const [task] = await q("INSERT INTO tasks (title, agent_id, work_scope, work_key, work_fingerprint) VALUES ('T', $1, 'test', $2, 'f') RETURNING id", [agent.id, `usage-${Date.now()}`]);
    const [session] = await q("INSERT INTO task_sessions (task_id, agent_snapshot, codex_home) VALUES ($1, '{}'::jsonb, '/tmp') RETURNING id", [task.id]);
    const [run] = await q(
      `INSERT INTO task_runs (task_id, task_session_id, run_kind, status, cwd, model, prompt)
       VALUES ($1, $2, 'worker', 'running', '/tmp', 'gpt-test', 'p') RETURNING id`,
      [task.id, session.id]
    );
    const usage = { method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 7, outputTokens: 3 } } } };
    await persistCodexLine(pool, { id: run.id, task_session_id: session.id, agent_thread_id: null }, JSON.stringify(usage), 0, createRuntimeNormalizer("codex"));
    const copied = await q("SELECT run_kind, event_type FROM usage_events WHERE run_id = $1", [run.id]);
    expect(copied).toEqual([{ run_kind: "worker", event_type: "usage.updated" }]);
  });
});

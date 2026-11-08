import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = "/tmp/aisevak-usage-test"; });
import { backfillUsageEvents, createPool, ensureConcurrentIndexes, runMigrations, USAGE_EVENT_PREDICATE, type DbPool } from "@aisevak/core";
import { loadUsageAnalytics } from "./usageAnalytics.js";

// The cost tab's query must read usage rows through the partial indexes: a
// sequential scan of the event tables decompressed every payload and timed out.
// Runs when AISEVAK_TEST_DATABASE_URL points at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("usage analytics indexes", () => {
  let pool: DbPool;
  beforeAll(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool);
    // Twice: a second call finds them valid and leaves them alone.
    await ensureConcurrentIndexes(pool);
    await ensureConcurrentIndexes(pool);
  });
  afterAll(async () => { await pool?.end(); });

  it.each([
    ["dispatcher_run_events", "dispatcher_run_events_usage_idx"],
    ["run_events", "run_events_usage_idx"]
  ])("reads %s usage rows through %s", async (table, index) => {
    const client = await pool.connect();
    try {
      // Only proves the index is usable for this predicate; the planner picks it on real data volumes.
      await client.query("SET enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT e.created_at, e.payload FROM ${table} e WHERE e.created_at >= now() - interval '30 days' AND ${USAGE_EVENT_PREDICATE}`
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(index);
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });

  it("backfills stored usage events once and serves the cost tab from them", async () => {
    await pool.query("DELETE FROM usage_events");
    const [run] = (await pool.query(
      `INSERT INTO dispatcher_runs (scope, status, cwd, codex_home, model, prompt)
       VALUES ('coordination', 'succeeded', '/tmp', '/tmp', 'claude-backfill-test', 'p') RETURNING id`
    )).rows;
    const turn = { v: 2, type: "turn.completed", provider: "claude", raw: { source: "acp.jsonrpc", payload: { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 } } } } };
    await pool.query(
      `INSERT INTO dispatcher_run_events (dispatcher_run_id, seq, event_type, payload) VALUES
       ($1, 1, 'turn.completed', $2), ($1, 2, 'content.delta', '{"v":2,"type":"content.delta"}'::jsonb)`,
      [run.id, JSON.stringify(turn)]
    );
    // Other test files share the database: count only this run's rows.
    expect(await backfillUsageEvents(pool)).toBeGreaterThanOrEqual(1);
    expect((await pool.query("SELECT event_type FROM usage_events WHERE run_id = $1", [run.id])).rows).toEqual([{ event_type: "turn.completed" }]);
    // Only while the table is empty: later boots copy nothing.
    expect(await backfillUsageEvents(pool)).toBe(0);
    const pricing = { source: "bundled" as const, lookup: () => ({ input: 1, cachedInput: 0, cacheWrite: 0, output: 1 }) };
    const analytics = await loadUsageAnalytics(pool, { days: 30, tzOffsetMinutes: 0, pricing });
    const claude = analytics.harnesses.find((harness) => harness.driver === "claude");
    expect(claude?.models.find((model) => model.model === "claude-backfill-test")?.totals.totalTokens).toBe(150);
  });
});

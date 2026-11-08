import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = "/tmp/aisevak-usage-test"; });
import { createPool, runMigrations, type DbPool } from "@aisevak/core";
import { USAGE_FILTER } from "./usageAnalytics.js";

// The cost tab's query must read usage rows through the partial indexes: a
// sequential scan of the event tables decompressed every payload and timed out.
// Runs when AISEVAK_TEST_DATABASE_URL points at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("usage analytics indexes", () => {
  let pool: DbPool;
  beforeAll(async () => { pool = createPool(databaseUrl); await runMigrations(pool); });
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
        `EXPLAIN SELECT e.created_at, e.payload FROM ${table} e WHERE e.created_at >= now() - interval '30 days' AND ${USAGE_FILTER}`
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(index);
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });
});

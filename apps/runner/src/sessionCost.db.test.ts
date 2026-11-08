import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = "/tmp/aisevak-session-cost-test"; });
import { createPool, ensureConcurrentIndexes, runMigrations, SESSION_COST_PREDICATE, type DbPool } from "@aisevak/core";
import { lastSessionCost } from "./sessionCost.js";

// Runs when AISEVAK_TEST_DATABASE_URL points at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("last stored session cost", () => {
  let pool: DbPool;
  beforeAll(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool);
    await ensureConcurrentIndexes(pool);
  });
  afterAll(async () => { await pool?.end(); });

  const reading = (session: string, payloadUsage: Record<string, unknown>, at: string, type = "usage.updated") =>
    pool.query(
      `INSERT INTO usage_events (event_id, run_kind, run_id, event_type, payload, created_at)
       VALUES (gen_random_uuid(), 'dispatcher', gen_random_uuid(), $1, $2, $3)`,
      [type, JSON.stringify({ v: 2, type, threadId: session, usage: payloadUsage }), at]
    );

  it("returns the newest cost total for the session and ignores readings without one", async () => {
    const session = `ses-${Date.now()}`;
    await reading(session, { scope: "context", cost: { amount: 28.32, currency: "USD" } }, "2026-11-08T19:19:18Z");
    await reading(session, { scope: "context", cost: { amount: 28.89, currency: "USD" } }, "2026-11-08T19:47:42Z");
    // Later gauges without cost, other event types and other sessions don't count.
    await reading(session, { scope: "context", usedTokens: 5 }, "2026-11-08T19:50:00Z");
    await reading(session, { scope: "turn", cost: { amount: 1, currency: "USD" } }, "2026-11-08T19:51:00Z", "turn.completed");
    await reading(`${session}-other`, { scope: "context", cost: { amount: 99, currency: "USD" } }, "2026-11-08T19:52:00Z");
    expect(await lastSessionCost(pool, session)).toBe(28.89);
    expect(await lastSessionCost(pool, `${session}-missing`)).toBeUndefined();
  });

  it("reads through the session cost index", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT created_at FROM usage_events WHERE payload->>'threadId' = 's' AND ${SESSION_COST_PREDICATE} ORDER BY created_at DESC LIMIT 1`
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("usage_events_session_cost_idx");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });
});

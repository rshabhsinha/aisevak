import { SESSION_COST_PREDICATE, type DbPool } from "@aisevak/core";

/**
 * The last cost total stored for an ACP session. Harnesses report cost as the
 * session's running total and restore it when a new process loads the session,
 * so a resumed turn's spend is measured from this reading.
 */
export async function lastSessionCost(pool: Pick<DbPool, "query">, sessionId: string): Promise<number | undefined> {
  const result = await pool.query<{ amount: string | null }>(
    `SELECT payload->'usage'->'cost'->>'amount' AS amount
     FROM usage_events
     WHERE payload->>'threadId' = $1 AND ${SESSION_COST_PREDICATE}
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  const amount = Number(result.rows[0]?.amount ?? Number.NaN);
  return Number.isFinite(amount) ? amount : undefined;
}

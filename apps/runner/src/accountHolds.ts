// Holding work for harness accounts at their usage limit.
//
// A turn that fails on a provider usage limit records its account in
// provider_account_limits until the reset (claudeAccounts.ts for Claude, which
// also moves work to another Claude account; settleProviderAccount here for
// the others). While an account is held, the runner starts no turn on it:
// queued runs stay queued, heartbeats and schedule ticks for it are not
// queued, and everything resumes on its own once the reset passes. Without
// this, every heartbeat, schedule tick and queued turn launched the provider,
// failed on the same limit and woke the thread again until the reset.

import { defaultProviderInstanceId, type DbPool, type ProviderDriver } from "@aisevak/core";
import { chooseClaudeAccount, MIN_LIMIT_MS, UNKNOWN_RESET_COOLDOWN_MS } from "./claudeAccounts.js";
import { parseUsageLimit } from "./providerLimits.js";

type Queryable = Pick<DbPool, "query">;

/** Same horizon parseUsageLimit trusts for a printed reset. */
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/** The account a run without a recorded account uses: the runner falls back to Codex. */
export const UNSET_ACCOUNT_ID = defaultProviderInstanceId("codex");

/**
 * Accounts no turn may start on right now, each with when it may run again.
 * A limited Claude account is held only while no other Claude account can
 * take its work. Errors are logged and treated as "nothing held", so a
 * bookkeeping failure never stops the runner.
 */
export async function heldProviderAccounts(
  pool: Queryable,
  secretKey: string,
  now: Date = new Date()
): Promise<Map<string, Date>> {
  const held = new Map<string, Date>();
  try {
    const result = await pool.query<{ provider_instance_id: string; limited_until: Date; driver: string | null }>(
      `SELECT account_limit.provider_instance_id, account_limit.limited_until, instance.driver
       FROM provider_account_limits account_limit
       LEFT JOIN provider_instances instance ON instance.id = account_limit.provider_instance_id
       WHERE account_limit.limited_until > $1`,
      [now]
    );
    for (const row of result.rows) {
      const until = new Date(row.limited_until);
      if (row.driver === "claude") {
        const choice = await chooseClaudeAccount(pool, row.provider_instance_id, secretKey, now);
        if (choice.allLimited) held.set(row.provider_instance_id, choice.earliestReset ?? until);
      } else {
        held.set(row.provider_instance_id, until);
      }
    }
  } catch (error) {
    console.warn(`Could not read held harness accounts: ${error instanceof Error ? error.message : String(error)}`);
  }
  return held;
}

/** The soonest time any of these accounts may run again, or null when none is held. */
export function heldUntil(held: Map<string, Date>, accountIds: Array<string | null | undefined>): Date | null {
  let soonest: Date | null = null;
  for (const id of accountIds) {
    const until = held.get(id || UNSET_ACCOUNT_ID);
    if (until && (!soonest || until < soonest)) soonest = until;
  }
  return soonest;
}

export interface ProviderAccountOutcome {
  /** Set when the turn failed on a usage limit: when the account may run again. */
  limitedUntil: Date | null;
}

/**
 * Limit bookkeeping for harnesses other than Claude (Claude goes through
 * settleClaudeAccount, which also fails over). A usage-limit failure holds the
 * account until its reset; a success clears a limit recorded before the run
 * started. Errors are logged, never thrown into run finalization.
 */
export async function settleProviderAccount(
  pool: Queryable,
  input: {
    driver: ProviderDriver;
    instanceId: string | null | undefined;
    /** Database time when the run started; fences limit clearing. */
    startedAt: Date;
    status: "succeeded" | "failed" | "cancelled";
    stdout: string;
    stderr: string;
    now?: Date;
  }
): Promise<ProviderAccountOutcome> {
  const none: ProviderAccountOutcome = { limitedUntil: null };
  if (input.driver === "claude") return none;
  const instanceId = input.instanceId || defaultProviderInstanceId(input.driver);
  const now = input.now ?? new Date();
  try {
    if (input.status === "succeeded") {
      await pool.query("DELETE FROM provider_account_limits WHERE provider_instance_id = $1 AND limited_at < $2", [
        instanceId,
        input.startedAt
      ]);
      return none;
    }
    if (input.status !== "failed") return none;
    const limit = parseUsageLimit(input.stderr, now);
    if (!limit) return none;
    const reported =
      (input.driver === "codex" ? codexRateLimitResetFromOutput(input.stdout, now) : null) ??
      limit.resetAt ??
      new Date(now.getTime() + UNKNOWN_RESET_COOLDOWN_MS);
    const limitedUntil = new Date(Math.max(reported.getTime(), now.getTime() + MIN_LIMIT_MS));
    await pool.query(
      `INSERT INTO provider_account_limits (provider_instance_id, limited_until, limited_at, reason)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (provider_instance_id) DO UPDATE
       SET limited_until = EXCLUDED.limited_until, limited_at = now(), reason = EXCLUDED.reason`,
      [instanceId, limitedUntil, "usage limit reached"]
    );
    return { limitedUntil };
  } catch (error) {
    console.warn(`Could not update harness account limits: ${error instanceof Error ? error.message : String(error)}`);
    return none;
  }
}

/**
 * The reset of the exhausted window in the last `account/rateLimits/updated`
 * notification of a Codex turn. Codex reports each window's used percent and
 * reset in epoch seconds; the latest reset among windows at 100% is when the
 * account can run again.
 */
export function codexRateLimitResetFromOutput(rawStdout: string, now: Date = new Date()): Date | null {
  if (!rawStdout.includes("account/rateLimits/updated")) return null;
  let resetAt: Date | null = null;
  for (const line of rawStdout.split(/\r?\n/)) {
    if (!line.includes("account/rateLimits/updated")) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = findRateLimits(message);
    if (!limits) continue;
    let latest: Date | null = null;
    for (const key of ["primary", "secondary"]) {
      const window = limits[key] as Record<string, unknown> | undefined;
      if (!window || typeof window.usedPercent !== "number" || window.usedPercent < 100) continue;
      if (typeof window.resetsAt !== "number") continue;
      const ms = window.resetsAt < 1e12 ? window.resetsAt * 1000 : window.resetsAt;
      if (ms <= now.getTime() || ms - now.getTime() > MAX_RESET_AHEAD_MS) continue;
      if (!latest || ms > latest.getTime()) latest = new Date(ms);
    }
    // The last notification wins: a later one without an exhausted window
    // means the earlier exhaustion is over.
    resetAt = latest;
  }
  return resetAt;
}

function findRateLimits(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const record = value as Record<string, unknown>;
  if (record.method === "account/rateLimits/updated") {
    const params = record.params as Record<string, unknown> | undefined;
    const limits = params?.rateLimits;
    return limits && typeof limits === "object" ? (limits as Record<string, unknown>) : null;
  }
  for (const child of Object.values(record)) {
    const found = findRateLimits(child, depth + 1);
    if (found) return found;
  }
  return null;
}

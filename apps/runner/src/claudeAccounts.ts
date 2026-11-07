// Claude account failover. A thread runs on its own Claude account until that
// account hits its usage limit; then each run uses the next added Claude
// account that is enabled, holds a subscription token and is not itself
// limited. The thread's account is retried once its limit resets.
//
// Switching accounts keeps the conversation: the session transcript lives in
// the thread's CLAUDE_CONFIG_DIR, not in the account, and a new credential
// starts a fresh ACP process that loads the same session.

import {
  CLAUDE_CODE_TOKEN_SECRET_NAME,
  classifyClaudeCredential,
  decryptSecret,
  defaultProviderInstanceId,
  providerInstanceSecretName,
  type DbPool
} from "@aisevak/core";
import { parseUsageLimit } from "./providerLimits.js";

type Queryable = Pick<DbPool, "query">;

export interface ClaudeAccountChoice {
  /** The account to run on. */
  instanceId: string;
  /** The thread's own account when the run moved off it, otherwise null. */
  fallbackFrom: string | null;
  /** True when every usable account is limited; the run uses the thread's account. */
  allLimited: boolean;
  /** When every usable account is limited, the soonest of their resets. */
  earliestReset: Date | null;
}

export interface LaunchedClaudeAccount extends ClaudeAccountChoice {
  /** Database time when the run took the account; fences limit clearing. */
  startedAt: Date;
}

/** Without a readable reset time, retry the limited account after this long. */
export const UNKNOWN_RESET_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * An account that just failed on its limit is skipped for at least this long,
 * even when the printed reset has already passed, so a retry never lands
 * straight back on it.
 */
export const MIN_LIMIT_MS = 5 * 60 * 1000;
/** Same horizon parseUsageLimit trusts for a printed reset. */
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

interface AccountRow {
  id: string;
  enabled: boolean;
  limited_until: Date | null;
}

function isLimited(row: AccountRow, now: Date): boolean {
  return row.limited_until !== null && new Date(row.limited_until).getTime() > now.getTime();
}

export async function chooseClaudeAccount(
  pool: Queryable,
  preferredId: string | null | undefined,
  secretKey: string,
  now: Date = new Date()
): Promise<ClaudeAccountChoice> {
  const preferred = preferredId || defaultProviderInstanceId("claude");
  const result = await pool.query<AccountRow>(
    `SELECT instance.id, instance.enabled, account_limit.limited_until
     FROM provider_instances instance
     LEFT JOIN provider_account_limits account_limit ON account_limit.provider_instance_id = instance.id
     WHERE instance.driver = 'claude'
     ORDER BY instance.created_at, instance.id`
  );
  const own = result.rows.find((row) => row.id === preferred);
  if (!own || !isLimited(own, now)) {
    return { instanceId: preferred, fallbackFrom: null, allLimited: false, earliestReset: null };
  }

  let earliestReset = new Date(own.limited_until!);
  for (const row of result.rows) {
    if (row.id === preferred || !row.enabled) continue;
    if (!(await hasSubscriptionToken(pool, row.id, secretKey))) continue;
    if (!isLimited(row, now)) return { instanceId: row.id, fallbackFrom: preferred, allLimited: false, earliestReset: null };
    const resetAt = new Date(row.limited_until!);
    if (resetAt < earliestReset) earliestReset = resetAt;
  }
  return { instanceId: preferred, fallbackFrom: null, allLimited: true, earliestReset };
}

// Only subscription accounts are fallbacks: an API key bills per token and has
// no plan limit, so moving work onto one is a cost decision, not a failover.
async function hasSubscriptionToken(pool: Queryable, instanceId: string, secretKey: string): Promise<boolean> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1 AND agent_accessible = false",
    [providerInstanceSecretName(CLAUDE_CODE_TOKEN_SECRET_NAME, instanceId)]
  );
  const row = result.rows[0];
  if (!row) return false;
  try {
    return classifyClaudeCredential(decryptSecret(row.encrypted_value, secretKey).trim()) === "oauth_token";
  } catch {
    return false;
  }
}

/**
 * Marks an account limited until its reset. The latest observation replaces
 * the previous one, so a wrong far-off reset is corrected by the next limit.
 */
export async function recordClaudeAccountLimit(
  pool: Queryable,
  instanceId: string,
  limitedUntil: Date,
  reason: string
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_account_limits (provider_instance_id, limited_until, limited_at, reason)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (provider_instance_id) DO UPDATE
     SET limited_until = EXCLUDED.limited_until,
         limited_at = now(),
         reason = EXCLUDED.reason`,
    [instanceId, limitedUntil, reason.slice(0, 500)]
  );
}

/**
 * A successful turn proves the account is usable again. Only a limit recorded
 * before the run started is cleared, so a run that began before the limit hit
 * cannot erase it.
 */
export async function clearClaudeAccountLimit(pool: Queryable, instanceId: string, runStartedAt: Date): Promise<void> {
  await pool.query(
    "DELETE FROM provider_account_limits WHERE provider_instance_id = $1 AND limited_at < $2",
    [instanceId, runStartedAt]
  );
}

/**
 * The reset time from the last rejected `rate_limit_event` in the turn's ACP
 * output. claude-agent-acp forwards it as a usage_update carrying
 * `_meta["_claude/rateLimit"]` with `resetsAt` in epoch seconds. Unlike the
 * printed "resets 3pm (Asia/Kolkata)" text it does not depend on a time zone.
 */
export function rateLimitResetFromOutput(rawStdout: string, now: Date = new Date()): Date | null {
  if (!rawStdout.includes("_claude/rateLimit")) return null;
  let resetAt: Date | null = null;
  for (const line of rawStdout.split(/\r?\n/)) {
    if (!line.includes("_claude/rateLimit")) continue;
    try {
      const info = findRateLimitInfo(JSON.parse(line));
      if (!info || info.status !== "rejected" || typeof info.resetsAt !== "number") continue;
      // Pay-as-you-go overage is not the plan window that blocks the account.
      if (info.rateLimitType === "overage") continue;
      const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
      if (ms > now.getTime() && ms - now.getTime() <= MAX_RESET_AHEAD_MS) resetAt = new Date(ms);
    } catch { /* Not JSON: ignore. */ }
  }
  return resetAt;
}

interface RateLimitInfo {
  status?: unknown;
  resetsAt?: unknown;
  rateLimitType?: unknown;
}

function findRateLimitInfo(value: unknown, depth = 0): RateLimitInfo | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const record = value as Record<string, unknown>;
  const meta = record._meta as Record<string, unknown> | undefined;
  const info = meta?.["_claude/rateLimit"];
  if (info && typeof info === "object") return info as RateLimitInfo;
  for (const child of Object.values(record)) {
    const found = findRateLimitInfo(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Picks the run's Claude account and records it on the run row. */
export async function launchClaudeAccount(
  pool: Queryable,
  runTable: "dispatcher_runs" | "task_runs",
  runId: string,
  threadAccountId: string | null | undefined,
  secretKey: string
): Promise<LaunchedClaudeAccount> {
  const choice = await chooseClaudeAccount(pool, threadAccountId, secretKey);
  const updated = await pool.query<{ started_at: Date }>(
    `UPDATE ${runTable} SET provider_instance_id = $2 WHERE id = $1 RETURNING now() AS started_at`,
    [runId, choice.instanceId]
  );
  if (choice.fallbackFrom) {
    console.info(`Run ${runId}: Claude account ${choice.fallbackFrom} is at its usage limit; using ${choice.instanceId}`);
  }
  return { ...choice, startedAt: updated.rows[0]?.started_at ?? new Date(0) };
}

export interface ClaudeAccountOutcome {
  /** Another Claude account can take the thread's work now. */
  fallbackReady: boolean;
  /** When no account is free: the soonest any of them resets. */
  earliestReset: Date | null;
}

/**
 * After a Claude turn: a usage-limit failure marks the account limited, a
 * success clears an older limit. Returns true when another Claude account can
 * take the thread's work right now, so a held delivery need not wait for the
 * reset. Bookkeeping errors are logged, never thrown into run finalization.
 */
export async function settleClaudeAccount(
  pool: Queryable,
  choice: LaunchedClaudeAccount,
  input: {
    status: "succeeded" | "failed" | "cancelled";
    stdout: string;
    stderr: string;
    secretKey: string;
    now?: Date;
  }
): Promise<ClaudeAccountOutcome> {
  const none: ClaudeAccountOutcome = { fallbackReady: false, earliestReset: null };
  const now = input.now ?? new Date();
  try {
    if (input.status === "succeeded") {
      await clearClaudeAccountLimit(pool, choice.instanceId, choice.startedAt);
      return none;
    }
    if (input.status !== "failed") return none;
    const limit = parseUsageLimit(input.stderr, now);
    if (!limit) return none;
    const reported =
      rateLimitResetFromOutput(input.stdout, now) ?? limit.resetAt ?? new Date(now.getTime() + UNKNOWN_RESET_COOLDOWN_MS);
    // A reset that has just passed still failed this turn: hold the account
    // briefly instead of handing the retry straight back to it.
    const limitedUntil = new Date(Math.max(reported.getTime(), now.getTime() + MIN_LIMIT_MS));
    await recordClaudeAccountLimit(pool, choice.instanceId, limitedUntil, "usage limit reached");
    const next = await chooseClaudeAccount(pool, choice.fallbackFrom ?? choice.instanceId, input.secretKey, now);
    if (next.allLimited) return { fallbackReady: false, earliestReset: next.earliestReset };
    return { fallbackReady: next.instanceId !== choice.instanceId, earliestReset: null };
  } catch (error) {
    console.warn(`Could not update Claude account limits: ${error instanceof Error ? error.message : String(error)}`);
    return none;
  }
}

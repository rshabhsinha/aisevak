import {
  defaultProviderInstanceId,
  isDefaultProviderInstance,
  PROVIDER_DRIVERS,
  type DbPool,
  type ProviderDriver
} from "@aisevak/core";
import { loadAccountLimits, type AccountLimits, type LimitWindow } from "./usageLimits.js";

// What `aisevak providers` returns: every harness account (several of one
// harness included, e.g. two Claude accounts), how much of its 5-hour session
// and weekly limits is left, and which agents run on it, so an orchestrating
// agent can plan work around the limits.

export interface WindowUsage {
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface ProviderAccountOverview {
  accountId: string;
  driver: ProviderDriver;
  label: string | null;
  isDefault: boolean;
  /** The account the calling agent's own thread runs on. */
  current: boolean;
  /** False while the account is at its usage limit; the runner starts no turn on it until limitedUntil. */
  available: boolean;
  limitedUntil: string | null;
  plan: string | null;
  /** live: fetched now; snapshot: last value a run reported; unavailable: the provider reports no usage. */
  source: AccountLimits["source"];
  checkedAt: string;
  session: WindowUsage | null;
  weekly: WindowUsage | null;
  /** Further windows: monthly plans and per-model weekly limits. */
  otherWindows: Array<WindowUsage & { label: string }>;
  credits: AccountLimits["credits"];
  note: string | null;
  error: string | null;
  agents: string[];
}

/** Same horizon the runner trusts for a reset. */
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

export async function loadProviderOverview(
  pool: DbPool,
  secretKey: string,
  options: { agentThreadId?: string | null; agentId?: string | null; fetchImpl?: typeof fetch } = {}
): Promise<{ checkedAt: string; currentAccountId: string | null; providers: ProviderAccountOverview[] }> {
  const accounts = await pool.query<{
    id: string;
    driver: ProviderDriver;
    label: string | null;
    limited_until: Date | null;
    agents: string[] | null;
  }>(
    `SELECT instance.id, instance.driver, NULLIF(instance.config->>'label', '') AS label,
            (SELECT limited_until FROM provider_account_limits account_limit
               WHERE account_limit.provider_instance_id = instance.id AND account_limit.limited_until > now()) AS limited_until,
            (SELECT array_agg(agents.name ORDER BY agents.name) FROM agents
               WHERE agents.provider_instance_id = instance.id AND agents.enabled = true) AS agents
     FROM provider_instances instance
     WHERE instance.enabled = true AND instance.driver = ANY($1::text[])
     ORDER BY instance.created_at ASC, instance.id ASC`,
    [PROVIDER_DRIVERS]
  );
  const currentAccountId = await callerAccount(pool, options.agentThreadId ?? null, options.agentId ?? null);
  const limits = await loadAccountLimits(
    pool,
    secretKey,
    accounts.rows.map((row) => ({ id: row.id, driver: row.driver })),
    { fetchImpl: options.fetchImpl }
  );
  await recordExhaustedAccounts(pool, limits);
  const byId = new Map(limits.map((limit) => [limit.accountId, limit]));
  const now = Date.now();
  const providers = accounts.rows.map((row): ProviderAccountOverview => {
    const limit = byId.get(row.id);
    const windows = limit?.windows ?? [];
    const session = windows.find((window) => window.kind === "session") ?? null;
    const weekly = windows.find((window) => window.kind === "weekly") ?? null;
    const others = [
      ...windows.filter((window) => window !== session && window !== weekly),
      ...(limit?.groups ?? []).flatMap((group) => group.windows)
    ];
    const limitedUntil = row.limited_until ? new Date(row.limited_until) : null;
    return {
      accountId: row.id,
      driver: row.driver,
      label: row.label,
      isDefault: isDefaultProviderInstance(row.id),
      current: row.id === currentAccountId,
      available: !limitedUntil || limitedUntil.getTime() <= now,
      limitedUntil: limitedUntil?.toISOString() ?? null,
      plan: limit?.plan ?? null,
      source: limit?.source ?? "unavailable",
      checkedAt: limit?.checkedAt ?? new Date(now).toISOString(),
      session: session ? usage(session) : null,
      weekly: weekly ? usage(weekly) : null,
      otherWindows: others.map((window) => ({ label: window.label, ...usage(window) })),
      credits: limit?.credits ?? [],
      note: limit?.note ?? null,
      error: limit?.error ?? null,
      agents: (row.agents ?? []).map((name) => `AGENT-${name}`)
    };
  });
  return { checkedAt: new Date(now).toISOString(), currentAccountId, providers };
}

function usage(window: LimitWindow): WindowUsage {
  return {
    usedPercent: window.usedPercent,
    remainingPercent: Math.max(0, Math.round((100 - window.usedPercent) * 10) / 10),
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes
  };
}

async function callerAccount(pool: DbPool, agentThreadId: string | null, agentId: string | null): Promise<string | null> {
  if (agentThreadId) {
    const thread = await pool.query<{ provider_instance_id: string | null }>(
      "SELECT provider_instance_id FROM agent_threads WHERE id = $1",
      [agentThreadId]
    );
    if (thread.rows[0]) return thread.rows[0].provider_instance_id ?? defaultProviderInstanceId("codex");
  }
  if (!agentId) return null;
  const agent = await pool.query<{ provider_instance_id: string }>("SELECT provider_instance_id FROM agents WHERE id = $1", [agentId]);
  return agent.rows[0]?.provider_instance_id ?? null;
}

/**
 * A live reading that shows the plan's 5-hour or weekly window used up marks
 * the account limited until that window resets, so the runner holds its work
 * without first launching a turn that fails on the limit. Accounts with extra
 * usage or credits keep running past 100% and are left alone, as are
 * per-model windows, which do not block the whole account.
 */
export async function recordExhaustedAccounts(pool: Pick<DbPool, "query">, limits: AccountLimits[], now: Date = new Date()): Promise<void> {
  for (const limit of limits) {
    if (limit.source !== "live" || limit.credits.length) continue;
    let resetAt: number | null = null;
    for (const window of limit.windows) {
      if ((window.kind !== "session" && window.kind !== "weekly") || window.usedPercent < 100 || !window.resetsAt) continue;
      const at = Date.parse(window.resetsAt);
      if (!Number.isFinite(at) || at <= now.getTime() || at - now.getTime() > MAX_RESET_AHEAD_MS) continue;
      if (resetAt === null || at > resetAt) resetAt = at;
    }
    if (resetAt === null) continue;
    try {
      await pool.query(
        `INSERT INTO provider_account_limits (provider_instance_id, limited_until, limited_at, reason)
         VALUES ($1, $2, now(), 'usage limit reported by the provider')
         ON CONFLICT (provider_instance_id) DO UPDATE
         SET limited_until = EXCLUDED.limited_until, limited_at = now(), reason = EXCLUDED.reason
         WHERE provider_account_limits.limited_until IS DISTINCT FROM EXCLUDED.limited_until`,
        [limit.accountId, new Date(resetAt)]
      );
    } catch (error) {
      console.warn(`Could not record the usage limit of ${limit.accountId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

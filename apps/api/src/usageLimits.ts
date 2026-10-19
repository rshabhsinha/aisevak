import {
  classifyClaudeCredential,
  CLAUDE_CODE_TOKEN_SECRET_NAME,
  CODEX_CHATGPT_AUTH_SECRET_NAME,
  CURSOR_API_KEY_SECRET_NAME,
  CURSOR_AUTH_SECRET_NAME,
  decryptSecret,
  isCursorHostAuthBundle,
  isDefaultProviderInstance,
  OPENCODE_AUTH_SECRET_NAME,
  parseCodexChatGptAuthFile,
  providerInstanceSecretName,
  type DbPool,
  type ProviderDriver
} from "@aisevak/core";

// Remaining plan limits per harness account. Endpoints follow what each
// harness's own CLI calls (see t3code's provider usage probes, MIT):
// - Claude:   GET  api.anthropic.com/api/oauth/usage (subscription OAuth token)
// - Codex:    GET  chatgpt.com/backend-api/wham/usage (ChatGPT access token)
// - Cursor:   POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
// - OpenCode: GET  opencode.ai/zen/go/v1/usage (OpenCode Go key)
// Devin exposes no plan usage. Codex falls back to the last
// `account/rateLimits/updated` snapshot a run reported for the account.

export type LimitWindowKind = "session" | "weekly" | "monthly" | "other";

export interface LimitWindow {
  id: string;
  label: string;
  kind: LimitWindowKind;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface LimitGroup {
  label: string;
  windows: LimitWindow[];
}

export interface AccountLimits {
  accountId: string;
  driver: ProviderDriver;
  /** live: fetched now; snapshot: last value a harness run reported; unavailable: nothing to show. */
  source: "live" | "snapshot" | "unavailable";
  checkedAt: string;
  plan: string | null;
  windows: LimitWindow[];
  groups: LimitGroup[];
  credits: { label: string; value: string }[];
  note: string | null;
  error: string | null;
}

const SESSION_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

interface LimitsContext {
  pool: DbPool;
  secretKey: string;
  fetchImpl: typeof fetch;
  now: Date;
}

const cache = new Map<string, { at: number; value: AccountLimits }>();

export async function loadAccountLimits(
  pool: DbPool,
  secretKey: string,
  accounts: { id: string; driver: ProviderDriver }[],
  options: { refresh?: boolean | string[]; fetchImpl?: typeof fetch } = {}
): Promise<AccountLimits[]> {
  const context: LimitsContext = { pool, secretKey, fetchImpl: options.fetchImpl ?? fetch, now: new Date() };
  return Promise.all(
    accounts.map(async (account) => {
      const cached = cache.get(account.id);
      const refresh = Array.isArray(options.refresh) ? options.refresh.includes(account.id) : Boolean(options.refresh);
      if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS && cached.value.driver === account.driver) {
        return cached.value;
      }
      let value: AccountLimits;
      try {
        value = await fetchLimits(context, account.id, account.driver);
      } catch (error) {
        value = {
          ...base(context, account.id, account.driver, "unavailable"),
          error: error instanceof Error ? error.message : String(error)
        };
      }
      cache.set(account.id, { at: Date.now(), value });
      return value;
    })
  );
}

/** Forget an account's cached limits, e.g. after it is removed. */
export function forgetAccountLimits(accountId: string): void {
  cache.delete(accountId);
}

async function fetchLimits(context: LimitsContext, accountId: string, driver: ProviderDriver): Promise<AccountLimits> {
  switch (driver) {
    case "claude":
      return claudeLimits(context, accountId);
    case "codex":
      return codexLimits(context, accountId);
    case "cursor":
      return cursorLimits(context, accountId);
    case "opencode":
      return openCodeLimits(context, accountId);
    case "devin":
      return { ...base(context, accountId, driver, "unavailable"), note: "Devin does not report plan usage to API clients." };
  }
}

// --- Claude -----------------------------------------------------------------

const CLAUDE_WINDOW_LABELS: Record<string, { label: string; kind: LimitWindowKind; minutes: number }> = {
  five_hour: { label: "Session (5h)", kind: "session", minutes: SESSION_MINUTES },
  seven_day: { label: "Weekly · all models", kind: "weekly", minutes: WEEK_MINUTES }
};

async function claudeLimits(context: LimitsContext, accountId: string): Promise<AccountLimits> {
  const result = base(context, accountId, "claude", "unavailable");
  const credential = await readSecret(context, providerInstanceSecretName(CLAUDE_CODE_TOKEN_SECRET_NAME, accountId));
  if (!credential) return { ...result, note: "Not connected." };
  if (classifyClaudeCredential(credential) === "api_key") {
    return { ...result, plan: "API key", note: "Billed per token through the Anthropic API; there are no plan limits." };
  }
  const response = await request(context, "https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${credential}`,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.0 (external, cli)"
    }
  });
  if (response.ok) {
    return { ...parseClaudeUsage(objectValue(await response.json()) ?? {}, result), source: "live" };
  }
  // `claude setup-token` tokens carry only the inference scope, which the usage
  // endpoint can reject; the unified rate-limit headers of a one-token request
  // report the same session and weekly utilization.
  if (response.status === 401 || response.status === 403) return claudeHeaderProbe(context, credential, result);
  throw new Error(`Anthropic usage endpoint returned ${response.status}`);
}

export function parseClaudeUsage(body: JsonRecord, result: AccountLimits): AccountLimits {
  const windows: LimitWindow[] = [];
  const perModel: LimitWindow[] = [];
  for (const [key, value] of Object.entries(body)) {
    const entry = objectValue(value);
    if (!entry || typeof entry.utilization !== "number") continue;
    const known = CLAUDE_WINDOW_LABELS[key];
    const window: LimitWindow = {
      id: key,
      label: known?.label ?? claudeScopedLabel(key),
      kind: known?.kind ?? (key.startsWith("seven_day") ? "weekly" : "other"),
      usedPercent: clampPercent(entry.utilization),
      resetsAt: isoFromString(entry.resets_at),
      windowMinutes: known?.minutes ?? (key.startsWith("seven_day") ? WEEK_MINUTES : null)
    };
    (known ? windows : perModel).push(window);
  }
  for (const value of arrayValue(body.limits)) {
    const entry = objectValue(value);
    const name = stringValue(objectValue(objectValue(entry?.scope)?.model)?.display_name);
    if (!entry || !name || typeof entry.percent !== "number") continue;
    perModel.push({
      id: `scoped_${name.toLowerCase().replace(/\W+/g, "_")}`,
      label: `Weekly · ${name}`,
      kind: "weekly",
      usedPercent: clampPercent(entry.percent),
      resetsAt: isoFromString(entry.resets_at),
      windowMinutes: WEEK_MINUTES
    });
  }
  const credits: AccountLimits["credits"] = [];
  const extra = objectValue(body.extra_usage);
  if (extra?.is_enabled === true) {
    const used = numberOrNull(extra.used_credits);
    const limit = numberOrNull(extra.monthly_limit);
    credits.push({
      label: "Extra usage",
      value: used !== null && limit !== null ? `$${(used / 100).toFixed(2)} of $${(limit / 100).toFixed(2)}` : "Enabled"
    });
  }
  return {
    ...result,
    plan: "Claude subscription",
    windows: sortWindows(windows),
    groups: perModel.length ? [{ label: "Per model", windows: perModel }] : [],
    credits
  };
}

async function claudeHeaderProbe(context: LimitsContext, credential: string, result: AccountLimits): Promise<AccountLimits> {
  const response = await request(context, "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "." }]
    })
  });
  const windows: LimitWindow[] = [];
  for (const [id, prefix] of [
    ["five_hour", "5h"],
    ["seven_day", "7d"]
  ] as const) {
    const utilization = Number(response.headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`));
    if (!Number.isFinite(utilization) || response.headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`) === null) continue;
    const reset = Number(response.headers.get(`anthropic-ratelimit-unified-${prefix}-reset`));
    const known = CLAUDE_WINDOW_LABELS[id]!;
    windows.push({
      id,
      label: known.label,
      kind: known.kind,
      usedPercent: clampPercent(utilization * 100),
      resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
      windowMinutes: known.minutes
    });
  }
  if (!windows.length) {
    throw new Error(
      response.status === 401
        ? "Anthropic rejected this subscription token. Run `claude setup-token` again and replace it."
        : `Anthropic did not report rate limits (HTTP ${response.status}).`
    );
  }
  const status = response.headers.get("anthropic-ratelimit-unified-status");
  return {
    ...result,
    source: "live",
    plan: "Claude subscription",
    windows,
    note: status && status !== "allowed" ? `Anthropic reports this account as ${status.replace(/_/g, " ")}.` : null
  };
}

function claudeScopedLabel(key: string): string {
  const scope = key.replace(/^seven_day_?/, "").replace(/_/g, " ").trim();
  if (!scope) return "Weekly";
  if (scope === "oauth apps") return "Weekly · third-party apps";
  return `Weekly · ${scope.replace(/\b\w/g, (letter) => letter.toUpperCase())}`;
}

// --- Codex ------------------------------------------------------------------

async function codexLimits(context: LimitsContext, accountId: string): Promise<AccountLimits> {
  const result = base(context, accountId, "codex", "unavailable");
  const stored = await readSecret(context, providerInstanceSecretName(CODEX_CHATGPT_AUTH_SECRET_NAME, accountId));
  if (!stored) {
    const apiKey = await readSecret(context, providerInstanceSecretName("openai_api_key", accountId));
    if (apiKey) return { ...result, plan: "API key", note: "Billed per token through the OpenAI API; there are no plan limits." };
    return withCodexSnapshot(context, accountId, { ...result, note: "Not connected." });
  }
  let auth: ReturnType<typeof parseCodexChatGptAuthFile>;
  try {
    auth = parseCodexChatGptAuthFile(stored);
  } catch (error) {
    return withCodexSnapshot(context, accountId, { ...result, error: errorMessage(error) });
  }
  let response: Response;
  try {
    response = await request(context, "https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        authorization: `Bearer ${auth.tokens.access_token}`,
        "chatgpt-account-id": auth.tokens.account_id,
        "openai-beta": "codex-1",
        originator: "codex_cli_rs",
        accept: "application/json"
      }
    });
  } catch (error) {
    return withCodexSnapshot(context, accountId, { ...result, error: errorMessage(error) });
  }
  if (!response.ok) {
    // Access tokens refresh during runs; until then the last run's snapshot is the best answer.
    const error =
      response.status === 401
        ? "The stored ChatGPT access token has expired; it refreshes on the next Codex run."
        : `ChatGPT usage endpoint returned ${response.status}`;
    return withCodexSnapshot(context, accountId, { ...result, error });
  }
  return { ...parseWhamUsage(objectValue(await response.json()) ?? {}, result), source: "live" };
}

export function parseWhamUsage(body: JsonRecord, result: AccountLimits): AccountLimits {
  const plan = stringValue(body.plan_type);
  const windows = whamWindows(objectValue(body.rate_limit), plan);
  const groups: LimitGroup[] = [];
  for (const value of arrayValue(body.additional_rate_limits)) {
    const entry = objectValue(value);
    if (!entry) continue;
    const label = stringValue(entry.limit_name) ?? stringValue(entry.metered_feature) ?? "Additional limit";
    const groupWindows = whamWindows(objectValue(entry.rate_limit), plan);
    if (groupWindows.length) groups.push({ label: humanize(label), windows: groupWindows });
  }
  const credits: AccountLimits["credits"] = [];
  const creditInfo = objectValue(body.credits);
  if (creditInfo?.unlimited === true) credits.push({ label: "Credits", value: "Unlimited" });
  else if (creditInfo?.has_credits === true) credits.push({ label: "Credits", value: String(creditInfo.balance ?? "Available") });
  return { ...result, plan: plan ? `ChatGPT ${humanize(plan)}` : "ChatGPT", windows, groups, credits };
}

function whamWindows(rateLimit: JsonRecord | undefined, plan: string | undefined): LimitWindow[] {
  if (!rateLimit) return [];
  const windows: LimitWindow[] = [];
  for (const [id, key] of [
    ["primary", "primary_window"],
    ["secondary", "secondary_window"]
  ] as const) {
    const window = objectValue(rateLimit[key]);
    const used = numberOrNull(window?.used_percent);
    if (!window || used === null) continue;
    const seconds = numberOrNull(window.limit_window_seconds);
    const reset = numberOrNull(window.reset_at);
    windows.push(
      codexWindow(id, used, seconds !== null ? seconds / 60 : null, reset !== null ? new Date(reset * 1000).toISOString() : null, plan)
    );
  }
  return windows;
}

async function withCodexSnapshot(context: LimitsContext, accountId: string, result: AccountLimits): Promise<AccountLimits> {
  const snapshot = await latestCodexRateLimits(context.pool, accountId);
  if (!snapshot) return result;
  const params = objectValue(snapshot.params);
  const limits = objectValue(params?.rateLimits);
  if (!limits) return result;
  const plan = stringValue(limits.planType);
  const windows: LimitWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const window = objectValue(limits[id]);
    const used = numberOrNull(window?.usedPercent);
    if (!window || used === null) continue;
    const reset = numberOrNull(window.resetsAt);
    windows.push(
      codexWindow(id, used, numberOrNull(window.windowDurationMins), reset !== null ? new Date(reset * 1000).toISOString() : null, plan)
    );
  }
  if (!windows.length) return result;
  const credits: AccountLimits["credits"] = [];
  const creditInfo = objectValue(limits.credits);
  if (creditInfo?.unlimited === true) credits.push({ label: "Credits", value: "Unlimited" });
  else if (creditInfo?.hasCredits === true) credits.push({ label: "Credits", value: String(creditInfo.balance ?? "Available") });
  return {
    ...result,
    source: "snapshot",
    checkedAt: snapshot.at.toISOString(),
    note: "Last limits reported by a Codex run on this account.",
    plan: plan ? `ChatGPT ${humanize(plan)}` : result.plan,
    windows,
    credits
  };
}

async function latestCodexRateLimits(pool: DbPool, accountId: string): Promise<{ at: Date; params: unknown } | null> {
  // Runs without a thread predate accounts and belong to the default account.
  const matchesAccount = isDefaultProviderInstance(accountId)
    ? "(t.provider_instance_id = $1 OR t.id IS NULL)"
    : "t.provider_instance_id = $1";
  const rateLimitEvent = `e.event_type IN ('account/rateLimits/updated', 'provider.event')
    AND COALESCE(e.payload->'raw'->>'method', e.payload->'raw'->'payload'->>'method') = 'account/rateLimits/updated'`;
  const result = await pool.query<{ created_at: Date; message: unknown }>(
    `SELECT created_at, message FROM (
       SELECT e.created_at, COALESCE(e.payload->'raw'->'payload', e.payload->'raw') AS message
       FROM dispatcher_run_events e
       JOIN dispatcher_runs r ON r.id = e.dispatcher_run_id
       LEFT JOIN agent_threads t ON t.id = r.agent_thread_id
       WHERE ${rateLimitEvent} AND ${matchesAccount}
       UNION ALL
       SELECT e.created_at, COALESCE(e.payload->'raw'->'payload', e.payload->'raw') AS message
       FROM run_events e
       JOIN task_runs r ON r.id = e.run_id
       LEFT JOIN agent_threads t ON t.id = r.agent_thread_id
       WHERE ${rateLimitEvent} AND ${matchesAccount}
     ) events
     ORDER BY created_at DESC
     LIMIT 1`,
    [accountId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at), params: objectValue(row.message)?.params };
}

function codexWindow(
  id: string,
  usedPercent: number,
  windowMinutes: number | null,
  resetsAt: string | null,
  plan: string | undefined
): LimitWindow {
  const monthlyPlan = plan === "free" || plan === "go";
  const minutes = windowMinutes ?? (id === "primary" ? (monthlyPlan ? 30 * 24 * 60 : SESSION_MINUTES) : WEEK_MINUTES);
  const kind: LimitWindowKind = minutes >= 28 * 24 * 60 ? "monthly" : minutes >= WEEK_MINUTES ? "weekly" : "session";
  return {
    id,
    label: kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : `Session (${Math.round(minutes / 60)}h)`,
    kind,
    usedPercent: clampPercent(usedPercent),
    resetsAt,
    windowMinutes: minutes
  };
}

// --- Cursor -----------------------------------------------------------------

async function cursorLimits(context: LimitsContext, accountId: string): Promise<AccountLimits> {
  const result = base(context, accountId, "cursor", "unavailable");
  const bundle = await readSecret(context, providerInstanceSecretName(CURSOR_AUTH_SECRET_NAME, accountId));
  const apiKey = await readSecret(context, providerInstanceSecretName(CURSOR_API_KEY_SECRET_NAME, accountId));
  const token = cursorAccessToken(bundle) ?? apiKey;
  if (!token) {
    return {
      ...result,
      note: isCursorHostAuthBundle(bundle) ? "Uses the host's Cursor login; usage is shown in the Cursor app." : "Not connected."
    };
  }
  const response = await request(context, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "cli"
    },
    body: "{}"
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ...result,
        note: apiKey && !cursorAccessToken(bundle)
          ? "Cursor API keys cannot read plan usage. Sign in with the Cursor login to see limits."
          : "Cursor rejected the stored login. Sign in again to see limits."
      };
    }
    throw new Error(`Cursor usage endpoint returned ${response.status}`);
  }
  return { ...parseCursorUsage(objectValue(await response.json()) ?? {}, result), source: "live" };
}

export function parseCursorUsage(body: JsonRecord, result: AccountLimits): AccountLimits {
  const usage = objectValue(body.planUsage) ?? {};
  const end = numberOrNull(body.billingCycleEnd);
  const resetsAt = end !== null ? new Date(end).toISOString() : null;
  const windows: LimitWindow[] = [];
  const groupWindows: LimitWindow[] = [];
  for (const [key, label, nested] of [
    ["totalPercentUsed", "Monthly · overall", false],
    ["autoPercentUsed", "Cursor models (Auto)", true],
    ["apiPercentUsed", "Other models (API)", true]
  ] as const) {
    const used = numberOrNull(usage[key]);
    if (used === null) continue;
    const window: LimitWindow = { id: key, label, kind: "monthly", usedPercent: clampPercent(used), resetsAt, windowMinutes: null };
    (nested ? groupWindows : windows).push(window);
  }
  return {
    ...result,
    plan: stringValue(body.planName) ?? "Cursor subscription",
    windows,
    groups: groupWindows.length ? [{ label: "By model pool", windows: groupWindows }] : []
  };
}

function cursorAccessToken(bundle: string | undefined): string | undefined {
  if (!bundle) return undefined;
  try {
    const files = objectValue((JSON.parse(bundle) as JsonRecord).homeFiles) ?? {};
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith("auth.json") || typeof content !== "string") continue;
      const token = stringValue(objectValue(JSON.parse(content))?.accessToken);
      if (token) return token;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// --- OpenCode ---------------------------------------------------------------

async function openCodeLimits(context: LimitsContext, accountId: string): Promise<AccountLimits> {
  const result = base(context, accountId, "opencode", "unavailable");
  const stored = await readSecret(context, providerInstanceSecretName(OPENCODE_AUTH_SECRET_NAME, accountId));
  if (!stored) return { ...result, note: "Not connected." };
  let key: string | undefined;
  try {
    key = stringValue(objectValue(objectValue(JSON.parse(stored))?.["opencode-go"])?.key);
  } catch {
    key = undefined;
  }
  if (!key) {
    return { ...result, note: "Only OpenCode Go subscriptions report plan limits; other providers bill per token." };
  }
  const response = await request(context, "https://opencode.ai/zen/go/v1/usage", {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" }
  });
  if (response.status === 403) return { ...result, note: "This OpenCode key has no Go subscription." };
  if (response.status === 401) return { ...result, note: "OpenCode rejected the stored Go key. Sign in again to see limits." };
  if (!response.ok) throw new Error(`OpenCode usage endpoint returned ${response.status}`);
  const usage = objectValue(objectValue(await response.json())?.usage) ?? {};
  const windows: LimitWindow[] = [];
  for (const [key, label, kind, minutes] of [
    ["rolling", "Session (5h)", "session", SESSION_MINUTES],
    ["weekly", "Weekly", "weekly", WEEK_MINUTES],
    ["monthly", "Monthly", "monthly", null]
  ] as const) {
    const window = objectValue(usage[key]);
    const used = numberOrNull(window?.percent);
    if (!window || used === null) continue;
    windows.push({ id: key, label, kind, usedPercent: clampPercent(used), resetsAt: isoFromString(window.resetsAt), windowMinutes: minutes });
  }
  return { ...result, source: "live", plan: "OpenCode Go", windows };
}

// --- Helpers ----------------------------------------------------------------

function base(context: LimitsContext, accountId: string, driver: ProviderDriver, source: AccountLimits["source"]): AccountLimits {
  return {
    accountId,
    driver,
    source,
    checkedAt: context.now.toISOString(),
    plan: null,
    windows: [],
    groups: [],
    credits: [],
    note: null,
    error: null
  };
}

async function readSecret(context: LimitsContext, name: string): Promise<string | undefined> {
  const result = await context.pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1 AND agent_accessible = false",
    [name]
  );
  const row = result.rows[0];
  return row ? decryptSecret(row.encrypted_value, context.secretKey).trim() || undefined : undefined;
}

function request(context: LimitsContext, url: string, init: RequestInit): Promise<Response> {
  return context.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function sortWindows(windows: LimitWindow[]): LimitWindow[] {
  const order: Record<LimitWindowKind, number> = { session: 0, weekly: 1, monthly: 2, other: 3 };
  return [...windows].sort((a, b) => order[a.kind] - order[b.kind]);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoFromString(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

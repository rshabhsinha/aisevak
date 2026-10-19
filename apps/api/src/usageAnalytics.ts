import type { DbPool } from "@aisevak/core";

// Token and cost analytics across harnesses and models.
//
// Every harness turn persists its raw provider messages as run events, so the
// numbers come straight from what each harness reported:
// - Codex `thread/tokenUsage/updated` carries the last model request's usage
//   (OpenAI semantics: `inputTokens` includes cached tokens).
// - ACP harnesses (Claude Code, Cursor, OpenCode, Devin) return per-turn usage
//   on the `session/prompt` result (Anthropic semantics: `inputTokens` excludes
//   cache reads) and may stream a cumulative session cost in `usage_update`.
// Both legacy (raw message) and v2 (normalized, raw kept under `raw.payload`)
// event payloads are read.

export type HarnessDriver = "codex" | "cursor" | "opencode" | "devin" | "claude";

export interface TokenTotals {
  /** Uncached input tokens. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requests: number;
  /** API-equivalent cost from public per-token prices; null when no model in the bucket is priced. */
  costUsd: number | null;
  /** Tokens whose model has no known price (excluded from costUsd). */
  unpricedTokens: number;
}

export interface ModelPricing {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface ModelUsage {
  model: string;
  totals: TokenTotals;
  /** USD per million tokens, when known. */
  pricing: ModelPricing | null;
}

export interface HarnessUsage {
  driver: HarnessDriver;
  totals: TokenTotals;
  /** Cost the harness itself reported (cumulative session cost), when it reports one. */
  reportedCostUsd: number | null;
  threads: number;
  models: ModelUsage[];
  /** Per harness account (provider instance). */
  accounts: { accountId: string; totals: TokenTotals }[];
}

export interface DailyUsage {
  date: string;
  drivers: Partial<Record<HarnessDriver, { tokens: number; costUsd: number }>>;
}

export interface ThreadUsage {
  threadId: string;
  title: string;
  driver: HarnessDriver;
  model: string;
  tokens: number;
  costUsd: number | null;
  lastActivityAt: string;
}

export interface UsageAnalytics {
  range: { days: number; since: string };
  generatedAt: string;
  pricingSource: "litellm" | "bundled";
  totals: TokenTotals;
  harnesses: HarnessUsage[];
  daily: DailyUsage[];
  topThreads: ThreadUsage[];
}

export interface UsageEventRow {
  created_at: Date | string;
  payload: unknown;
  model: string | null;
  driver: string | null;
  thread_id: string | null;
  thread_title: string | null;
  account_id: string | null;
}

interface UsageSample {
  at: Date;
  driver: HarnessDriver;
  model: string;
  threadId: string | null;
  threadTitle: string | null;
  accountId: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

interface CostSample {
  driver: HarnessDriver;
  sessionId: string;
  amountUsd: number;
}

type JsonRecord = Record<string, unknown>;

const DRIVERS: HarnessDriver[] = ["codex", "claude", "cursor", "opencode", "devin"];

export async function loadUsageAnalytics(
  pool: DbPool,
  options: { days: number; tzOffsetMinutes: number; now?: Date; pricing?: PricingTable }
): Promise<UsageAnalytics> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.days * 86_400_000);
  const rows = await queryUsageEvents(pool, since);
  const pricing = options.pricing ?? (await loadPricingTable());
  return aggregateUsage(rows, { ...options, since, now, pricing });
}

// Only usage-bearing messages: Codex token updates, ACP usage updates, and ACP
// prompt results that carry `usage`.
const USAGE_FILTER = `(
  e.event_type IN ('usage.updated', 'thread/tokenUsage/updated', 'usage_update', 'turn.completed')
  OR e.payload->'raw'->'result' ? 'usage'
)`;

async function queryUsageEvents(pool: DbPool, since: Date): Promise<UsageEventRow[]> {
  const result = await pool.query<UsageEventRow>(
    `SELECT e.created_at, e.payload, r.model, pi.driver, t.id::text AS thread_id, t.title AS thread_title, t.provider_instance_id AS account_id
     FROM run_events e
     JOIN task_runs r ON r.id = e.run_id
     LEFT JOIN agent_threads t ON t.id = r.agent_thread_id
     LEFT JOIN provider_instances pi ON pi.id = t.provider_instance_id
     WHERE e.created_at >= $1 AND ${USAGE_FILTER}
     UNION ALL
     SELECT e.created_at, e.payload, r.model, pi.driver, t.id::text AS thread_id, t.title AS thread_title, t.provider_instance_id AS account_id
     FROM dispatcher_run_events e
     JOIN dispatcher_runs r ON r.id = e.dispatcher_run_id
     LEFT JOIN agent_threads t ON t.id = r.agent_thread_id
     LEFT JOIN provider_instances pi ON pi.id = t.provider_instance_id
     WHERE e.created_at >= $1 AND ${USAGE_FILTER}`,
    [since]
  );
  return result.rows;
}

export function aggregateUsage(
  rows: UsageEventRow[],
  options: { days: number; tzOffsetMinutes: number; since: Date; now: Date; pricing: PricingTable }
): UsageAnalytics {
  const samples: UsageSample[] = [];
  const costs = new Map<string, CostSample>();
  for (const row of rows) {
    const parsed = parseUsageRow(row);
    if (!parsed) continue;
    if (parsed.kind === "tokens") samples.push(parsed.sample);
    else {
      // Session cost is cumulative: keep the highest value seen per session.
      const key = `${parsed.cost.driver}:${parsed.cost.sessionId}`;
      const previous = costs.get(key);
      if (!previous || parsed.cost.amountUsd > previous.amountUsd) costs.set(key, parsed.cost);
    }
  }

  const harnesses = new Map<
    HarnessDriver,
    { totals: TokenTotals; models: Map<string, TokenTotals>; accounts: Map<string, TokenTotals>; threads: Set<string> }
  >();
  const daily = new Map<string, DailyUsage>();
  const threads = new Map<string, ThreadUsage>();
  const totals = emptyTotals();

  for (const sample of samples) {
    const price = options.pricing.lookup(sample.model);
    const cost = price ? sampleCost(sample, price) : null;
    let harness = harnesses.get(sample.driver);
    if (!harness) {
      harness = { totals: emptyTotals(), models: new Map(), accounts: new Map(), threads: new Set() };
      harnesses.set(sample.driver, harness);
    }
    let modelTotals = harness.models.get(sample.model);
    if (!modelTotals) {
      modelTotals = emptyTotals();
      harness.models.set(sample.model, modelTotals);
    }
    let accountTotals = harness.accounts.get(sample.accountId);
    if (!accountTotals) {
      accountTotals = emptyTotals();
      harness.accounts.set(sample.accountId, accountTotals);
    }
    for (const bucket of [totals, harness.totals, modelTotals, accountTotals]) addSample(bucket, sample, cost);
    if (sample.threadId) harness.threads.add(sample.threadId);

    const date = localDate(sample.at, options.tzOffsetMinutes);
    const day = daily.get(date) ?? { date, drivers: {} };
    const dayDriver = day.drivers[sample.driver] ?? { tokens: 0, costUsd: 0 };
    dayDriver.tokens += sampleTokens(sample);
    dayDriver.costUsd += cost ?? 0;
    day.drivers[sample.driver] = dayDriver;
    daily.set(date, day);

    if (sample.threadId) {
      const thread = threads.get(sample.threadId) ?? {
        threadId: sample.threadId,
        title: sample.threadTitle ?? "Untitled thread",
        driver: sample.driver,
        model: sample.model,
        tokens: 0,
        costUsd: null,
        lastActivityAt: sample.at.toISOString()
      };
      thread.tokens += sampleTokens(sample);
      if (cost !== null) thread.costUsd = (thread.costUsd ?? 0) + cost;
      if (sample.at.toISOString() > thread.lastActivityAt) {
        thread.lastActivityAt = sample.at.toISOString();
        thread.model = sample.model;
      }
      threads.set(sample.threadId, thread);
    }
  }

  const reported = new Map<HarnessDriver, number>();
  for (const cost of costs.values()) reported.set(cost.driver, (reported.get(cost.driver) ?? 0) + cost.amountUsd);

  const harnessList: HarnessUsage[] = DRIVERS.flatMap((driver) => {
    const harness = harnesses.get(driver);
    const reportedCostUsd = reported.get(driver) ?? null;
    if (!harness && reportedCostUsd === null) return [];
    return [
      {
        driver,
        totals: harness?.totals ?? emptyTotals(),
        reportedCostUsd,
        threads: harness?.threads.size ?? 0,
        models: [...(harness?.models.entries() ?? [])]
          .map(([model, modelTotals]) => ({ model, totals: modelTotals, pricing: options.pricing.lookup(model) }))
          .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
        accounts: [...(harness?.accounts.entries() ?? [])]
          .map(([accountId, accountTotals]) => ({ accountId, totals: accountTotals }))
          .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens)
      }
    ];
  });
  harnessList.sort((a, b) => (b.totals.costUsd ?? 0) - (a.totals.costUsd ?? 0) || b.totals.totalTokens - a.totals.totalTokens);

  return {
    range: { days: options.days, since: options.since.toISOString() },
    generatedAt: options.now.toISOString(),
    pricingSource: options.pricing.source,
    totals,
    harnesses: harnessList,
    daily: fillDays(daily, options),
    topThreads: [...threads.values()]
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens)
      .slice(0, 8)
  };
}

type ParsedRow = { kind: "tokens"; sample: UsageSample } | { kind: "cost"; cost: CostSample };

export function parseUsageRow(row: UsageEventRow): ParsedRow | null {
  const payload = objectValue(row.payload);
  if (!payload) return null;
  const raw = objectValue(payload.raw);
  // v2 events keep the provider message under raw.payload; legacy events stored it as raw.
  const message = payload.v === 2 ? objectValue(raw?.payload) : raw;
  if (!message) return null;
  const driver = harnessDriver(stringValue(payload.provider) ?? row.driver);
  const at = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const base = {
    at,
    driver,
    model: row.model?.trim() || "unknown",
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    // Runs without a thread predate accounts and belong to the default account.
    accountId: row.account_id ?? `${driver}-local`
  };

  const method = stringValue(message.method);
  const params = objectValue(message.params);
  if (method === "thread/tokenUsage/updated") {
    const last = objectValue(objectValue(params?.tokenUsage)?.last);
    if (!last) return null;
    const input = numberValue(last.inputTokens);
    const cached = numberValue(last.cachedInputTokens);
    return {
      kind: "tokens",
      sample: {
        ...base,
        inputTokens: Math.max(0, input - cached),
        cachedInputTokens: cached,
        cacheWriteTokens: numberValue(last.cacheWriteInputTokens),
        outputTokens: numberValue(last.outputTokens),
        reasoningTokens: numberValue(last.reasoningOutputTokens)
      }
    };
  }

  if (method === "session/update") {
    const update = objectValue(params?.update);
    if (stringValue(update?.sessionUpdate) !== "usage_update") return null;
    const cost = objectValue(update?.cost);
    const amount = numberValue(cost?.amount);
    const currency = stringValue(cost?.currency) ?? "USD";
    const sessionId = stringValue(params?.sessionId);
    if (!cost || amount <= 0 || currency !== "USD" || !sessionId) return null;
    return { kind: "cost", cost: { driver, sessionId, amountUsd: amount } };
  }

  const usage = objectValue(objectValue(message.result)?.usage);
  if (!method && usage) {
    return {
      kind: "tokens",
      sample: {
        ...base,
        inputTokens: numberValue(usage.inputTokens),
        cachedInputTokens: numberValue(usage.cachedReadTokens),
        cacheWriteTokens: numberValue(usage.cachedWriteTokens),
        outputTokens: numberValue(usage.outputTokens),
        reasoningTokens: numberValue(usage.thoughtTokens)
      }
    };
  }
  return null;
}

function addSample(bucket: TokenTotals, sample: UsageSample, cost: number | null): void {
  bucket.inputTokens += sample.inputTokens;
  bucket.cachedInputTokens += sample.cachedInputTokens;
  bucket.cacheWriteTokens += sample.cacheWriteTokens;
  bucket.outputTokens += sample.outputTokens;
  bucket.reasoningTokens += sample.reasoningTokens;
  bucket.totalTokens += sampleTokens(sample);
  bucket.requests += 1;
  if (cost === null) bucket.unpricedTokens += sampleTokens(sample);
  else bucket.costUsd = (bucket.costUsd ?? 0) + cost;
}

// Reasoning tokens are already counted inside output tokens by every harness.
function sampleTokens(sample: UsageSample): number {
  return sample.inputTokens + sample.cachedInputTokens + sample.cacheWriteTokens + sample.outputTokens;
}

function sampleCost(sample: UsageSample, price: ModelPricing): number {
  return (
    (sample.inputTokens * price.input +
      sample.cachedInputTokens * price.cachedInput +
      sample.cacheWriteTokens * price.cacheWrite +
      sample.outputTokens * price.output) /
    1_000_000
  );
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
    costUsd: null,
    unpricedTokens: 0
  };
}

function fillDays(
  daily: Map<string, DailyUsage>,
  options: { days: number; tzOffsetMinutes: number; now: Date }
): DailyUsage[] {
  const days: DailyUsage[] = [];
  const count = Math.max(1, Math.ceil(options.days));
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = localDate(new Date(options.now.getTime() - index * 86_400_000), options.tzOffsetMinutes);
    days.push(daily.get(date) ?? { date, drivers: {} });
  }
  return days;
}

/** `tzOffsetMinutes` follows `Date#getTimezoneOffset` (UTC minus local). */
function localDate(at: Date, tzOffsetMinutes: number): string {
  return new Date(at.getTime() - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function harnessDriver(value: string | null | undefined): HarnessDriver {
  return DRIVERS.includes(value as HarnessDriver) ? (value as HarnessDriver) : "codex";
}

// --- Pricing -----------------------------------------------------------------

export interface PricingTable {
  source: "litellm" | "bundled";
  lookup(model: string): ModelPricing | null;
}

const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_TTL_MS = 12 * 60 * 60 * 1000;

// Fallback when the public price list is unreachable. USD per million tokens,
// from LiteLLM's model_prices_and_context_window.json (October 2026).
const BUNDLED_PRICES: Record<string, ModelPricing> = {
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, cacheWrite: 5, output: 30 },
  "claude-fable-5-1": { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 },
  "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  "claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5-5": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-haiku-5-5": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }
};

// Claude Code accepts aliases; price them as the model each alias resolves to.
const MODEL_ALIASES: Record<string, string> = {
  default: "claude-opus-5-5",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1"
};

let cachedPricing: { table: PricingTable; fetchedAt: number } | null = null;

export async function loadPricingTable(fetchImpl: typeof fetch = fetch): Promise<PricingTable> {
  if (cachedPricing && Date.now() - cachedPricing.fetchedAt < PRICING_TTL_MS) return cachedPricing.table;
  try {
    const response = await fetchImpl(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const table = pricingTableFromLiteLlm((await response.json()) as JsonRecord);
    cachedPricing = { table, fetchedAt: Date.now() };
    return table;
  } catch {
    const table = pricingTable("bundled", new Map(Object.entries(BUNDLED_PRICES)));
    // Retry the public list after a few minutes rather than on every request.
    cachedPricing = { table, fetchedAt: Date.now() - PRICING_TTL_MS + 5 * 60 * 1000 };
    return table;
  }
}

export function pricingTableFromLiteLlm(data: JsonRecord): PricingTable {
  const prices = new Map<string, ModelPricing>(Object.entries(BUNDLED_PRICES));
  for (const [key, value] of Object.entries(data)) {
    const entry = objectValue(value);
    if (!entry) continue;
    const input = numberValue(entry.input_cost_per_token);
    const output = numberValue(entry.output_cost_per_token);
    if (input <= 0 && output <= 0) continue;
    const cachedInput = numberValue(entry.cache_read_input_token_cost) || input;
    const cacheWrite = numberValue(entry.cache_creation_input_token_cost) || input;
    prices.set(key.toLowerCase(), {
      input: input * 1_000_000,
      cachedInput: cachedInput * 1_000_000,
      cacheWrite: cacheWrite * 1_000_000,
      output: output * 1_000_000
    });
  }
  return pricingTable("litellm", prices);
}

function pricingTable(source: PricingTable["source"], prices: Map<string, ModelPricing>): PricingTable {
  return {
    source,
    lookup(model) {
      for (const candidate of modelCandidates(model)) {
        const price = prices.get(candidate);
        if (price) return price;
      }
      return null;
    }
  };
}

function modelCandidates(model: string): string[] {
  const id = model.trim().toLowerCase();
  if (!id || id === "unknown" || id === "auto") return [];
  // Harness-specific prefixes such as `opencode/` or `anthropic/` and `[1m]` suffixes.
  const bare = id.replace(/\[[^\]]*\]$/, "").split("/").pop() ?? id;
  const undated = bare.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  const alias = MODEL_ALIASES[bare];
  return [...new Set([id, bare, undated, alias, `openai/${bare}`, `anthropic/${bare}`].filter((value): value is string => Boolean(value)))];
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

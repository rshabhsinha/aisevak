import { ChevronRight, Gauge, RefreshCw, TrendingDown, TrendingUp } from "./icons";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { HarnessMark } from "./harness-logos";

// Settings > Usage (cost & token analytics) and Settings > Limits (remaining
// plan limits per harness account). Data: GET /api/usage/analytics and
// GET /api/usage/limits.

export type HarnessDriver = "codex" | "claude" | "cursor" | "opencode" | "devin";

export const HARNESS_ORDER: HarnessDriver[] = ["codex", "claude", "opencode", "devin", "cursor"];

export const HARNESS_LABELS: Record<HarnessDriver, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  devin: "Devin"
};

export interface HarnessAccount {
  id: string;
  driver: HarnessDriver;
  label: string | null;
  isDefault: boolean;
  agents: number;
  threads: number;
}

export function accountName(account: Pick<HarnessAccount, "label" | "isDefault"> | undefined): string {
  if (!account) return "Unknown account";
  return account.label || (account.isDefault ? "Default account" : "Account");
}

// --- Data types (mirror apps/api/src/usageAnalytics.ts and usageLimits.ts) ---

interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requests: number;
  costUsd: number | null;
  unpricedTokens: number;
}

interface UsageAnalytics {
  range: { days: number; since: string };
  generatedAt: string;
  pricingSource: "litellm" | "bundled";
  totals: TokenTotals;
  harnesses: Array<{
    driver: HarnessDriver;
    totals: TokenTotals;
    reportedCostUsd: number | null;
    threads: number;
    models: Array<{
      model: string;
      totals: TokenTotals;
      pricing: { input: number; cachedInput: number; cacheWrite: number; output: number } | null;
    }>;
    accounts: Array<{ accountId: string; totals: TokenTotals }>;
  }>;
  daily: Array<{ date: string; drivers: Partial<Record<HarnessDriver, { tokens: number; costUsd: number }>> }>;
  topThreads: Array<{
    threadId: string;
    title: string;
    driver: HarnessDriver;
    model: string;
    tokens: number;
    costUsd: number | null;
    lastActivityAt: string;
  }>;
}

export interface LimitWindow {
  id: string;
  label: string;
  kind: "session" | "weekly" | "monthly" | "other";
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface AccountLimits {
  accountId: string;
  driver: HarnessDriver;
  source: "live" | "snapshot" | "unavailable";
  checkedAt: string;
  plan: string | null;
  windows: LimitWindow[];
  groups: Array<{ label: string; windows: LimitWindow[] }>;
  credits: Array<{ label: string; value: string }>;
  note: string | null;
  error: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) {
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as { message?: string };
      throw new Error(payload.message ?? text);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(text || `HTTP ${response.status}`);
      throw error;
    }
  }
  return (await response.json()) as T;
}

// --- Formatting ----------------------------------------------------------------

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function formatUsd(value: number | null, precise = false): string {
  if (value === null) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: precise || value < 100 ? 2 : 0 })}`;
}

function formatPercent(value: number): string {
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
}

function formatRelative(target: string | null, now = Date.now()): string | null {
  if (!target) return null;
  const ms = new Date(target).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const text = days >= 1 ? `${days}d ${hours % 24}h` : hours >= 1 ? `${hours}h ${minutes % 60}m` : `${Math.max(1, minutes)}m`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

function shortDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return parsed.toLocaleDateString([], { month: "short", day: "numeric" });
}

// --- Limits -------------------------------------------------------------------

type Pace = "ahead" | "on" | "under";

/** A window whose reset time has passed: the reported usage no longer applies. */
export function isWindowStale(window: LimitWindow, now = Date.now()): boolean {
  return Boolean(window.resetsAt && new Date(window.resetsAt).getTime() <= now);
}

function windowPace(window: LimitWindow, now = Date.now()): Pace | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const length = window.windowMinutes * 60_000;
  const elapsed = (length - (new Date(window.resetsAt).getTime() - now)) / length;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 1) return null;
  const gap = window.usedPercent - elapsed * 100;
  return gap > 5 ? "ahead" : gap < -5 ? "under" : "on";
}

function elapsedShare(window: LimitWindow, now = Date.now()): number | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const length = window.windowMinutes * 60_000;
  const elapsed = (length - (new Date(window.resetsAt).getTime() - now)) / length;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 1 ? elapsed : null;
}

const PACE_COPY: Record<Pace, { icon: ReactNode; label: string }> = {
  ahead: { icon: <TrendingUp size={12} />, label: "Using faster than the window refills" },
  on: { icon: <Gauge size={12} />, label: "On pace for this window" },
  under: { icon: <TrendingDown size={12} />, label: "Using slower than the window refills" }
};

/** Remaining-percent bars for a set of limit windows. */
export function LimitWindows({ windows, compact = false }: { windows: LimitWindow[]; compact?: boolean }) {
  return (
    <div className={`limit-windows ${compact ? "compact" : ""}`}>
      {windows.map((window) => {
        const stale = isWindowStale(window);
        const remaining = stale ? 100 : Math.max(0, 100 - window.usedPercent);
        const pace = stale ? null : windowPace(window);
        const elapsed = stale ? null : elapsedShare(window);
        const tone = stale ? "stale" : remaining <= 10 ? "critical" : remaining <= 25 ? "low" : "ok";
        return (
          <div className="limit-window" key={window.id}>
            <div className="limit-window-label">
              <span>{window.label}</span>
              <strong>{stale ? "Reset since last report" : `${formatPercent(remaining)} left`}</strong>
            </div>
            <div
              className={`limit-bar ${tone}`}
              role="meter"
              aria-label={`${window.label} remaining`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(remaining)}
            >
              <span className="limit-bar-fill" style={{ width: `${remaining}%` }} />
              {elapsed !== null ? (
                <span
                  className="limit-bar-pace"
                  style={{ left: `${(1 - elapsed) * 100}%` }}
                  title="Even pace: where the bar would be if usage were spread evenly across the window"
                />
              ) : null}
            </div>
            <div className="limit-window-reset">
              {pace ? (
                <span className={`limit-pace ${pace}`} title={PACE_COPY[pace].label}>
                  {PACE_COPY[pace].icon}
                </span>
              ) : null}
              <span>
                {stale ? `Reset ${formatRelative(window.resetsAt)}` : window.resetsAt ? `Resets ${formatRelative(window.resetsAt)}` : "No reset time"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AccountLimitsBody({ limits }: { limits: AccountLimits }) {
  return (
    <div className="account-limits-body">
      {limits.windows.length ? <LimitWindows windows={limits.windows} /> : null}
      {limits.groups.map((group) => (
        <details className="limit-group" key={group.label} open={limits.windows.length === 0}>
          <summary>
            <ChevronRight size={13} />
            <span>{group.label}</span>
            <em>{group.windows.length}</em>
          </summary>
          <LimitWindows windows={group.windows} compact />
        </details>
      ))}
      {limits.credits.length ? (
        <div className="limit-credits">
          {limits.credits.map((credit) => (
            <span key={credit.label}>
              {credit.label}: <strong>{credit.value}</strong>
            </span>
          ))}
        </div>
      ) : null}
      {limits.note ? <p className="limit-note">{limits.note}</p> : null}
      {limits.error ? <p className="limit-note error">{limits.error}</p> : null}
    </div>
  );
}

function LimitSourceBadge({ limits }: { limits: AccountLimits }) {
  if (limits.source === "live") return <Badge variant="success">Live</Badge>;
  if (limits.source === "snapshot") {
    return (
      <Badge variant="secondary" title={new Date(limits.checkedAt).toLocaleString()}>
        From last run · {formatRelative(limits.checkedAt)}
      </Badge>
    );
  }
  return <Badge variant="secondary">Not reported</Badge>;
}

export function UsageLimitsView({ accounts }: { accounts: HarnessAccount[] }) {
  const [limits, setLimits] = useState<AccountLimits[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(refresh = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await getJson<{ limits: AccountLimits[] }>(`/api/usage/limits${refresh ? "?refresh=1" : ""}`);
      setLimits(result.limits);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load usage limits.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const byDriver = useMemo(() => {
    const groups = new Map<HarnessDriver, AccountLimits[]>();
    for (const entry of limits ?? []) groups.set(entry.driver, [...(groups.get(entry.driver) ?? []), entry]);
    return HARNESS_ORDER.flatMap((driver) => (groups.has(driver) ? [[driver, groups.get(driver)!] as const] : []));
  }, [limits]);

  // Accounts at or near a limit surface first.
  const tightest = useMemo(() => {
    return (limits ?? [])
      .flatMap((entry) => [...entry.windows, ...entry.groups.flatMap((group) => group.windows)].map((window) => ({ entry, window })))
      .filter(({ window }) => !isWindowStale(window))
      .sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];
  }, [limits]);

  return (
    <div className="usage-view">
      <header className="usage-header">
        <div>
          <h3>Usage limits</h3>
          <p>Remaining plan allowance for every connected harness account. Bars show what is left; the tick marks even pace.</p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => void load(true)}>
          <RefreshCw className={busy ? "spin" : ""} size={14} /> Refresh
        </Button>
      </header>
      {error ? <div className="notice error">{error}</div> : null}
      {tightest && tightest.window.usedPercent >= 75 ? (
        <div className="limit-alert">
          <HarnessMark driver={tightest.entry.driver} size={14} color />
          <span>
            <strong>{HARNESS_LABELS[tightest.entry.driver]} · {accountName(accounts.find((a) => a.id === tightest.entry.accountId))}</strong>{" "}
            has {formatPercent(100 - tightest.window.usedPercent)} of its {tightest.window.label.toLowerCase()} limit left
            {tightest.window.resetsAt ? `, resetting ${formatRelative(tightest.window.resetsAt)}` : ""}.
          </span>
        </div>
      ) : null}
      {limits === null && busy ? <div className="usage-empty">Checking limits…</div> : null}
      <div className="limits-grid">
        {byDriver.map(([driver, entries]) => (
          <section className="limits-harness" key={driver}>
            <div className="limits-harness-head">
              <span className={`harness-chip driver-${driver}`}>
                <HarnessMark driver={driver} size={15} color />
              </span>
              <h4>{HARNESS_LABELS[driver]}</h4>
              <span className="muted">{entries.length} account{entries.length === 1 ? "" : "s"}</span>
            </div>
            {entries.map((entry) => {
              const account = accounts.find((candidate) => candidate.id === entry.accountId);
              return (
                <article className="limits-account" key={entry.accountId}>
                  <div className="limits-account-head">
                    <div>
                      <strong>{accountName(account)}</strong>
                      {entry.plan ? <span>{entry.plan}</span> : null}
                    </div>
                    <LimitSourceBadge limits={entry} />
                  </div>
                  <AccountLimitsBody limits={entry} />
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

// --- Cost & analytics ------------------------------------------------------------

const RANGES = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" }
];

const TOKEN_TYPES: Array<{ key: keyof TokenTotals; label: string; className: string }> = [
  { key: "inputTokens", label: "Uncached input", className: "tok-input" },
  { key: "cachedInputTokens", label: "Cached input", className: "tok-cached" },
  { key: "cacheWriteTokens", label: "Cache write", className: "tok-write" },
  { key: "outputTokens", label: "Output", className: "tok-output" }
];

export function CostAnalyticsView({ accounts }: { accounts: HarnessAccount[] }) {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [data, setData] = useState<UsageAnalytics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<HarnessDriver>>(new Set());
  const [chartAsTable, setChartAsTable] = useState(false);

  async function load(range = days) {
    setBusy(true);
    setError(null);
    try {
      setData(await getJson<UsageAnalytics>(`/api/usage/analytics?days=${range}&tzOffset=${new Date().getTimezoneOffset()}`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load usage analytics.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(days);
  }, [days]);

  const totals = data?.totals;
  const totalCost = totals?.costUsd ?? 0;
  const cacheSavings = useMemo(() => {
    if (!data) return 0;
    return data.harnesses
      .flatMap((harness) => harness.models)
      .reduce((sum, model) => sum + (model.pricing ? (model.totals.cachedInputTokens * (model.pricing.input - model.pricing.cachedInput)) / 1_000_000 : 0), 0);
  }, [data]);
  const hasData = Boolean(totals && totals.requests > 0);

  return (
    <div className="usage-view">
      <header className="usage-header">
        <div>
          <h3>Cost &amp; analytics</h3>
          <p>
            Tokens every harness reported, priced at public API rates. Subscription runs show what the same tokens would cost on the API.
          </p>
        </div>
        <div className="usage-controls">
          <div className="segmented" role="tablist" aria-label="Metric">
            {(["cost", "tokens"] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={metric === value} className={metric === value ? "active" : ""} onClick={() => setMetric(value)}>
                {value === "cost" ? "Cost" : "Tokens"}
              </button>
            ))}
          </div>
          <div className="segmented" role="tablist" aria-label="Time range">
            {RANGES.map((range) => (
              <button key={range.days} type="button" role="tab" aria-selected={days === range.days} className={days === range.days ? "active" : ""} onClick={() => setDays(range.days)}>
                {range.label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" aria-label="Refresh" disabled={busy} onClick={() => void load()}>
            <RefreshCw className={busy ? "spin" : ""} size={14} />
          </Button>
        </div>
      </header>
      {error ? <div className="notice error">{error}</div> : null}
      {!data && busy ? <div className="usage-empty">Loading usage…</div> : null}
      {data && !hasData ? (
        <div className="usage-empty">No harness usage in this range yet. Token counts appear here once agents run turns.</div>
      ) : null}
      {data && totals && hasData ? (
        <>
          <section className="usage-hero">
            <div className="usage-hero-total">
              <span className="eyebrow">{metric === "cost" ? "API-equivalent cost" : "Tokens processed"}</span>
              <strong>{metric === "cost" ? formatUsd(totals.costUsd) : formatTokens(totals.totalTokens)}</strong>
              <p>
                {metric === "cost" ? `${formatTokens(totals.totalTokens)} tokens` : formatUsd(totals.costUsd)} · {totals.requests.toLocaleString()} model
                requests
                {totals.unpricedTokens > 0 ? ` · ${formatTokens(totals.unpricedTokens)} tokens unpriced` : ""}
              </p>
              <ul className="usage-harness-share">
                {data.harnesses.map((harness) => {
                  const value = metric === "cost" ? harness.totals.costUsd ?? 0 : harness.totals.totalTokens;
                  const whole = metric === "cost" ? totalCost : totals.totalTokens;
                  return (
                    <li key={harness.driver}>
                      <span className={`series-dot driver-${harness.driver}`} />
                      <HarnessMark driver={harness.driver} size={13} />
                      <span className="usage-harness-name">{HARNESS_LABELS[harness.driver]}</span>
                      <span className="usage-harness-value">{metric === "cost" ? formatUsd(harness.totals.costUsd) : formatTokens(harness.totals.totalTokens)}</span>
                      <span className="usage-harness-pct">{whole > 0 ? formatPercent((value / whole) * 100) : "—"}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="usage-chart-card">
              <div className="usage-chart-head">
                <span className="eyebrow">{metric === "cost" ? "Cost" : "Tokens"} per day</span>
                <button type="button" className="link-button" onClick={() => setChartAsTable((value) => !value)}>
                  {chartAsTable ? "Show chart" : "Show table"}
                </button>
              </div>
              {chartAsTable ? <DailyTable data={data} metric={metric} /> : <DailyChart data={data} metric={metric} />}
            </div>
          </section>

          <section className="usage-metrics">
            <Metric label="Uncached input" value={formatTokens(totals.inputTokens)} />
            <Metric label="Cached input" value={formatTokens(totals.cachedInputTokens)} hint={totals.inputTokens + totals.cachedInputTokens > 0 ? `${formatPercent((totals.cachedInputTokens / (totals.inputTokens + totals.cachedInputTokens)) * 100)} hit rate` : undefined} />
            <Metric label="Cache write" value={formatTokens(totals.cacheWriteTokens)} />
            <Metric label="Output" value={formatTokens(totals.outputTokens)} hint={totals.reasoningTokens ? `${formatTokens(totals.reasoningTokens)} reasoning` : undefined} />
            <Metric label="Cache savings" value={formatUsd(cacheSavings)} hint="vs. uncached input" />
          </section>

          <section className="usage-share-card">
            <span className="eyebrow">Tokens by type</span>
            <TokenShareBar totals={totals} />
          </section>

          <section className="usage-breakdown">
            <div className="usage-section-head">
              <h4>By harness and model</h4>
              <span className="muted">Prices per million tokens · {data.pricingSource === "litellm" ? "LiteLLM price list" : "bundled price list"}</span>
            </div>
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Harness / model</th>
                    <th className="num">Requests</th>
                    <th className="num">Input</th>
                    <th className="num">Cached</th>
                    <th className="num">Output</th>
                    <th className="num">Total</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.harnesses.map((harness) => {
                    const open = expanded.has(harness.driver);
                    return (
                      <Fragment key={harness.driver}>
                        <tr
                          className="usage-row-harness"
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(harness.driver)) next.delete(harness.driver);
                              else next.add(harness.driver);
                              return next;
                            })
                          }
                        >
                          <td>
                            <span className="usage-row-title">
                              <ChevronRight size={13} className={`usage-chevron ${open ? "open" : ""}`} />
                              <span className={`series-dot driver-${harness.driver}`} />
                              <HarnessMark driver={harness.driver} size={13} />
                              <strong>{HARNESS_LABELS[harness.driver]}</strong>
                              <span className="muted">
                                {harness.models.length} model{harness.models.length === 1 ? "" : "s"} · {harness.threads} thread{harness.threads === 1 ? "" : "s"}
                              </span>
                            </span>
                          </td>
                          <TotalsCells totals={harness.totals} />
                        </tr>
                        {open
                          ? harness.models.map((model) => (
                              <tr className="usage-row-model" key={`${harness.driver}:${model.model}`}>
                                <td>
                                  <span className="usage-row-title nested">
                                    <code>{model.model}</code>
                                    {model.pricing ? (
                                      <span className="muted" title="Input / cached input / output, USD per million tokens">
                                        ${trimPrice(model.pricing.input)} · ${trimPrice(model.pricing.cachedInput)} · ${trimPrice(model.pricing.output)}
                                      </span>
                                    ) : (
                                      <span className="muted">Unpriced</span>
                                    )}
                                  </span>
                                </td>
                                <TotalsCells totals={model.totals} />
                              </tr>
                            ))
                          : null}
                        {open && harness.accounts.length > 1
                          ? harness.accounts.map((entry) => (
                              <tr className="usage-row-model usage-row-account" key={`${harness.driver}:account:${entry.accountId}`}>
                                <td>
                                  <span className="usage-row-title nested">
                                    <span className="usage-account-tag">Account</span>
                                    {accountName(accounts.find((account) => account.id === entry.accountId))}
                                  </span>
                                </td>
                                <TotalsCells totals={entry.totals} />
                              </tr>
                            ))
                          : null}
                        {open && harness.reportedCostUsd !== null ? (
                          <tr className="usage-row-model">
                            <td colSpan={7}>
                              <span className="usage-row-title nested muted">
                                {HARNESS_LABELS[harness.driver]} itself reported {formatUsd(harness.reportedCostUsd, true)} for these sessions.
                              </span>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {data.topThreads.length ? (
            <section className="usage-breakdown">
              <div className="usage-section-head">
                <h4>Most expensive threads</h4>
              </div>
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>Thread</th>
                      <th>Model</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topThreads.map((thread) => (
                      <tr key={thread.threadId}>
                        <td>
                          <a className="usage-row-title usage-thread-link" href={`/threads/${encodeURIComponent(thread.threadId)}`}>
                            <HarnessMark driver={thread.driver} size={13} />
                            <span>{thread.title}</span>
                          </a>
                        </td>
                        <td>
                          <code>{thread.model}</code>
                        </td>
                        <td className="num">{formatTokens(thread.tokens)}</td>
                        <td className="num">{formatUsd(thread.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function trimPrice(value: number): string {
  return Number(value.toPrecision(3)).toString();
}

function TotalsCells({ totals }: { totals: TokenTotals }) {
  return (
    <>
      <td className="num">{totals.requests.toLocaleString()}</td>
      <td className="num">{formatTokens(totals.inputTokens)}</td>
      <td className="num">{formatTokens(totals.cachedInputTokens)}</td>
      <td className="num">{formatTokens(totals.outputTokens)}</td>
      <td className="num">{formatTokens(totals.totalTokens)}</td>
      <td className="num">
        <strong>{formatUsd(totals.costUsd)}</strong>
      </td>
    </>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="usage-metric">
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      {hint ? <em>{hint}</em> : null}
    </div>
  );
}

function TokenShareBar({ totals }: { totals: TokenTotals }) {
  const whole = TOKEN_TYPES.reduce((sum, type) => sum + Number(totals[type.key] ?? 0), 0);
  if (!whole) return null;
  const parts = TOKEN_TYPES.map((type) => ({ ...type, value: Number(totals[type.key] ?? 0) })).filter((part) => part.value > 0);
  return (
    <div className="token-share">
      <div className="token-share-bar">
        {parts.map((part) => (
          <span
            key={part.key}
            className={part.className}
            style={{ flexGrow: part.value }}
            title={`${part.label}: ${formatTokens(part.value)} (${formatPercent((part.value / whole) * 100)})`}
          />
        ))}
      </div>
      <ul className="token-share-legend">
        {parts.map((part) => (
          <li key={part.key}>
            <span className={`series-dot ${part.className}`} />
            {part.label}
            <strong>{formatPercent((part.value / whole) * 100)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DailyChart({ data, metric }: { data: UsageAnalytics; metric: "cost" | "tokens" }) {
  const [hover, setHover] = useState<number | null>(null);
  const drivers = HARNESS_ORDER.filter((driver) => data.harnesses.some((harness) => harness.driver === driver));
  const values = data.daily.map((day) =>
    drivers.map((driver) => {
      const entry = day.drivers[driver];
      return metric === "cost" ? entry?.costUsd ?? 0 : entry?.tokens ?? 0;
    })
  );
  const max = Math.max(...values.map((row) => row.reduce((sum, value) => sum + value, 0)), 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const format = (value: number) => (metric === "cost" ? formatUsd(value) : formatTokens(value));
  const labelEvery = Math.max(1, Math.ceil(data.daily.length / 8));

  return (
    <div className="daily-chart">
      <div className="daily-chart-legend">
        {drivers.map((driver) => (
          <span key={driver}>
            <span className={`series-dot driver-${driver}`} />
            {HARNESS_LABELS[driver]}
          </span>
        ))}
      </div>
      <div className="daily-chart-plot">
        <div className="daily-chart-axis">
          {[...ticks].reverse().map((tick) => (
            <span key={tick}>{format(tick)}</span>
          ))}
        </div>
        <div className="daily-chart-bars" onMouseLeave={() => setHover(null)}>
          {ticks.slice(1).map((tick) => (
            <span key={tick} className="daily-chart-grid" style={{ bottom: `${(tick / top) * 100}%` }} />
          ))}
          {data.daily.map((day, index) => {
            const row = values[index]!;
            const total = row.reduce((sum, value) => sum + value, 0);
            return (
              <div
                key={day.date}
                className={`daily-chart-col ${hover === index ? "hover" : ""}`}
                onMouseEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
                tabIndex={0}
                aria-label={`${shortDate(day.date)}: ${format(total)}`}
              >
                <div className="daily-chart-stack" style={{ height: `${(total / top) * 100}%` }}>
                  {drivers.map((driver, driverIndex) =>
                    row[driverIndex]! > 0 ? (
                      <span key={driver} className={`driver-${driver}`} style={{ flexGrow: row[driverIndex] }} />
                    ) : null
                  )}
                </div>
                {(index % labelEvery === 0 && index < data.daily.length - labelEvery / 2) || index === data.daily.length - 1 ? (
                  <em>{shortDate(day.date)}</em>
                ) : null}
                {hover === index ? (
                  <div className={`daily-chart-tooltip ${index > data.daily.length / 2 ? "left" : ""}`}>
                    <strong>{shortDate(day.date)}</strong>
                    {drivers.map((driver, driverIndex) => (
                      <span key={driver}>
                        <span className={`series-dot driver-${driver}`} />
                        {HARNESS_LABELS[driver]}
                        <b>{format(row[driverIndex]!)}</b>
                      </span>
                    ))}
                    <span className="total">
                      Total<b>{format(total)}</b>
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DailyTable({ data, metric }: { data: UsageAnalytics; metric: "cost" | "tokens" }) {
  const drivers = HARNESS_ORDER.filter((driver) => data.harnesses.some((harness) => harness.driver === driver));
  const format = (value: number) => (metric === "cost" ? formatUsd(value) : formatTokens(value));
  return (
    <div className="usage-table-wrap daily-table">
      <table className="usage-table">
        <thead>
          <tr>
            <th>Day</th>
            {drivers.map((driver) => (
              <th key={driver} className="num">{HARNESS_LABELS[driver]}</th>
            ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...data.daily].reverse().map((day) => {
            const values = drivers.map((driver) => (metric === "cost" ? day.drivers[driver]?.costUsd ?? 0 : day.drivers[driver]?.tokens ?? 0));
            return (
              <tr key={day.date}>
                <td>{shortDate(day.date)}</td>
                {values.map((value, index) => (
                  <td key={drivers[index]} className="num">{value ? format(value) : "—"}</td>
                ))}
                <td className="num"><strong>{format(values.reduce((sum, value) => sum + value, 0))}</strong></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? rough;
  const ticks: number[] = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Number(value.toPrecision(6)));
  return ticks;
}

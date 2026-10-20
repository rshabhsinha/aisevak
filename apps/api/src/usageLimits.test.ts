import { encryptSecret, providerInstanceSecretName, type DbPool } from "@aisevak/core";
import { describe, expect, it, vi } from "vitest";
import { forgetAccountLimits, loadAccountLimits, parseClaudeUsage, parseCursorUsage, parseWhamUsage, retryAfterMs, type AccountLimits } from "./usageLimits.js";

const key = Buffer.alloc(32, 7).toString("base64");

function empty(driver: AccountLimits["driver"]): AccountLimits {
  return {
    accountId: `${driver}-local`,
    driver,
    source: "live",
    checkedAt: "2026-10-19T00:00:00.000Z",
    plan: null,
    windows: [],
    groups: [],
    credits: [],
    note: null,
    error: null
  };
}

function poolWith(secrets: Record<string, string>, events: unknown[] = []): DbPool {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("FROM secrets")) {
        const value = secrets[String(params[0])];
        return { rows: value ? [{ encrypted_value: encryptSecret(value, key) }] : [] };
      }
      return { rows: events };
    }
  } as unknown as DbPool;
}

describe("limit response parsing", () => {
  it("maps Claude session, weekly and per-model windows", () => {
    const limits = parseClaudeUsage(
      {
        five_hour: { utilization: 42, resets_at: "2026-10-19T05:00:00Z" },
        seven_day: { utilization: 18.25, resets_at: "2026-10-23T00:00:00Z" },
        seven_day_opus: { utilization: 61, resets_at: "2026-10-23T00:00:00Z" },
        seven_day_sonnet: null,
        extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 5000 }
      },
      empty("claude")
    );
    expect(limits.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Session (5h)", 42],
      ["Weekly · all models", 18.3]
    ]);
    expect(limits.groups).toEqual([{ label: "Per model", windows: [expect.objectContaining({ label: "Weekly · Opus", usedPercent: 61 })] }]);
    expect(limits.credits).toEqual([{ label: "Extra usage", value: "$12.50 of $50.00" }]);
  });

  it("maps ChatGPT wham usage, including additional per-model limits", () => {
    const limits = parseWhamUsage(
      {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_792_400_000 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_792_900_000 }
        },
        additional_rate_limits: [
          { limit_name: "codex_spark", rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: 1_792_400_000 } } }
        ],
        credits: { has_credits: true, unlimited: false, balance: "12.5" }
      },
      empty("codex")
    );
    expect(limits.plan).toBe("ChatGPT Pro");
    expect(limits.windows.map((window) => [window.label, window.kind, window.usedPercent])).toEqual([
      ["Session (5h)", "session", 12],
      ["Weekly", "weekly", 40]
    ]);
    expect(limits.groups[0]).toMatchObject({ label: "Codex Spark", windows: [expect.objectContaining({ usedPercent: 5 })] });
    expect(limits.credits).toEqual([{ label: "Credits", value: "12.5" }]);
  });

  it("maps Cursor plan usage into an overall window and model pools", () => {
    const limits = parseCursorUsage(
      { billingCycleEnd: "1793000000000", planUsage: { totalPercentUsed: 33.3, autoPercentUsed: 20, apiPercentUsed: 71 } },
      empty("cursor")
    );
    expect(limits.windows).toEqual([expect.objectContaining({ label: "Monthly · overall", usedPercent: 33.3, kind: "monthly" })]);
    expect(limits.groups[0]!.windows.map((window) => window.usedPercent)).toEqual([20, 71]);
  });
});

describe("account limits", () => {
  it("reads each account's own credential and falls back to the last Codex run snapshot", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(url).includes("oauth/usage")) {
        return new Response(JSON.stringify({ five_hour: { utilization: headers.get("authorization")?.endsWith("WORK") ? 80 : 10 } }));
      }
      return new Response("expired", { status: 401 });
    });
    const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "a.b.c", access_token: "expired", refresh_token: "r", account_id: "acct" } });
    const pool = poolWith(
      {
        claude_code_token: "sk-ant-oat01-personal-token-HOME",
        [providerInstanceSecretName("claude_code_token", "claude-work")]: "sk-ant-oat01-work-token-WORK",
        openai_codex_auth: auth
      },
      [
        {
          created_at: new Date("2026-10-19T08:00:00Z"),
          message: { method: "account/rateLimits/updated", params: { rateLimits: { planType: "plus", primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_792_500_000 } } } }
        }
      ]
    );
    const limits = await loadAccountLimits(
      pool,
      key,
      [
        { id: "claude-local", driver: "claude" },
        { id: "claude-work", driver: "claude" },
        { id: "codex-local", driver: "codex" }
      ],
      { fetchImpl: fetchImpl as unknown as typeof fetch, refresh: true }
    );
    expect(limits.map((entry) => [entry.accountId, entry.source, entry.windows[0]?.usedPercent])).toEqual([
      ["claude-local", "live", 10],
      ["claude-work", "live", 80],
      ["codex-local", "snapshot", 55]
    ]);
    expect(limits[2]!.error).toContain("expired");
  });

  it("re-checks only the accounts named in a targeted refresh", async () => {
    let utilization = 10;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization } })));
    const pool = poolWith({
      claude_code_token: "sk-ant-oat01-personal-token-HOME",
      [providerInstanceSecretName("claude_code_token", "claude-ops")]: "sk-ant-oat01-ops-token-OPS"
    });
    const accounts = [
      { id: "claude-local", driver: "claude" as const },
      { id: "claude-ops", driver: "claude" as const }
    ];
    const options = { fetchImpl: fetchImpl as unknown as typeof fetch };
    await loadAccountLimits(pool, key, accounts, { ...options, refresh: true });
    utilization = 70;
    const targeted = await loadAccountLimits(pool, key, accounts, { ...options, refresh: ["claude-ops"] });
    expect(targeted.map((entry) => entry.windows[0]?.usedPercent)).toEqual([10, 70]);
    forgetAccountLimits("claude-local");
    const afterForget = await loadAccountLimits(pool, key, accounts, options);
    expect(afterForget.map((entry) => entry.windows[0]?.usedPercent)).toEqual([70, 70]);
  });

  it("falls back to the rate-limit headers on a 429 and honors Retry-After", async () => {
    const usageCalls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("oauth/usage")) {
        usageCalls.push(String(url));
        return new Response("rate limited", { status: 429, headers: { "retry-after": "600" } });
      }
      return new Response("{}", {
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.25",
          "anthropic-ratelimit-unified-7d-utilization": "0.5",
          "anthropic-ratelimit-unified-status": "allowed"
        }
      });
    });
    const pool = poolWith({ [providerInstanceSecretName("claude_code_token", "claude-429")]: "sk-ant-oat01-limited-token" });
    const accounts = [{ id: "claude-429", driver: "claude" as const }];
    const options = { fetchImpl: fetchImpl as unknown as typeof fetch, refresh: true };
    const first = await loadAccountLimits(pool, key, accounts, options);
    expect(first[0]).toMatchObject({ source: "live", error: null });
    expect(first[0]!.windows.map((window) => window.usedPercent)).toEqual([25, 50]);
    await loadAccountLimits(pool, key, accounts, options);
    expect(usageCalls).toHaveLength(1);
    forgetAccountLimits("claude-429");
  });

  it("keeps showing the last good reading when a refresh fails", async () => {
    let fail = false;
    const fetchImpl = vi.fn(async () =>
      fail ? new Response("busy", { status: 500 }) : new Response(JSON.stringify({ five_hour: { utilization: 30 } }))
    );
    const pool = poolWith({ [providerInstanceSecretName("claude_code_token", "claude-stale")]: "sk-ant-oat01-stale-token" });
    const accounts = [{ id: "claude-stale", driver: "claude" as const }];
    const options = { fetchImpl: fetchImpl as unknown as typeof fetch, refresh: true };
    await loadAccountLimits(pool, key, accounts, options);
    fail = true;
    const [stale] = await loadAccountLimits(pool, key, accounts, options);
    expect(stale).toMatchObject({ source: "live", error: null });
    expect(stale!.windows[0]!.usedPercent).toBe(30);
    expect(stale!.note).toContain("Anthropic usage endpoint returned 500");
    const [again] = await loadAccountLimits(pool, key, accounts, options);
    expect(again!.windows[0]!.usedPercent).toBe(30);
    forgetAccountLimits("claude-stale");
  });
});

describe("retryAfterMs", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  it("reads seconds, HTTP dates and defaults", () => {
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("Tue, 20 Oct 2026 00:02:00 GMT", now)).toBe(120_000);
    expect(retryAfterMs(null, now)).toBe(5 * 60_000);
    expect(retryAfterMs("garbage", now)).toBe(5 * 60_000);
    expect(retryAfterMs("999999", now)).toBe(60 * 60_000);
  });
});

import { encryptSecret, type DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { chooseClaudeAccount, launchClaudeAccount, MIN_LIMIT_MS, rateLimitResetFromOutput, settleClaudeAccount } from "./claudeAccounts.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = new Date("2026-11-07T12:00:00Z");
const LATER = new Date("2026-11-07T15:00:00Z");
const EARLIER = new Date("2026-11-07T11:00:00Z");

interface Account {
  id: string;
  enabled?: boolean;
  limitedUntil?: Date | null;
  credential?: string | null;
}

function accountsPool(accounts: Account[]) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const limits = new Map<string, Date>(
    accounts.filter((account) => account.limitedUntil).map((account) => [account.id, account.limitedUntil!])
  );
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM provider_instances instance")) {
      return {
        rows: accounts.map((account) => ({
          id: account.id,
          enabled: account.enabled ?? true,
          limited_until: limits.get(account.id) ?? null
        }))
      };
    }
    if (sql.includes("FROM secrets")) {
      const name = String(params[0]);
      const id = name.includes("@") ? name.split("@")[1] : "claude-local";
      const credential = accounts.find((account) => account.id === id)?.credential;
      return { rows: credential ? [{ encrypted_value: encryptSecret(credential, KEY) }] : [] };
    }
    if (sql.includes("RETURNING now() AS started_at")) return { rows: [{ started_at: NOW }] };
    if (sql.includes("INSERT INTO provider_account_limits")) {
      limits.set(String(params[0]), params[1] as Date);
    }
    return { rows: [] };
  };
  return { pool: { query } as unknown as DbPool, queries, limits };
}

const TOKEN = "sk-ant-oat01-abc";
const API_KEY = "sk-ant-api03-abc";

describe("chooseClaudeAccount", () => {
  it("keeps the thread's account while it is under its limit", async () => {
    const { pool } = accountsPool([{ id: "claude-local", credential: TOKEN }, { id: "claude-work", credential: TOKEN }]);
    expect(await chooseClaudeAccount(pool, "claude-local", KEY, NOW)).toEqual({
      instanceId: "claude-local",
      fallbackFrom: null,
      allLimited: false,
      earliestReset: null
    });
  });

  it("moves to the next added account when the thread's account is limited", async () => {
    const { pool } = accountsPool([
      { id: "claude-local", credential: TOKEN, limitedUntil: LATER },
      { id: "claude-work", credential: TOKEN }
    ]);
    expect(await chooseClaudeAccount(pool, null, KEY, NOW)).toEqual({
      instanceId: "claude-work",
      fallbackFrom: "claude-local",
      allLimited: false,
      earliestReset: null
    });
  });

  it("returns to the thread's account once its limit has passed", async () => {
    const { pool } = accountsPool([
      { id: "claude-local", credential: TOKEN, limitedUntil: EARLIER },
      { id: "claude-work", credential: TOKEN }
    ]);
    expect((await chooseClaudeAccount(pool, "claude-local", KEY, NOW)).instanceId).toBe("claude-local");
  });

  it("skips disabled, limited, unconnected and API-key accounts", async () => {
    const { pool } = accountsPool([
      { id: "claude-local", credential: TOKEN, limitedUntil: LATER },
      { id: "claude-off", credential: TOKEN, enabled: false },
      { id: "claude-busy", credential: TOKEN, limitedUntil: LATER },
      { id: "claude-empty", credential: null },
      { id: "claude-billed", credential: API_KEY },
      { id: "claude-spare", credential: TOKEN }
    ]);
    expect((await chooseClaudeAccount(pool, "claude-local", KEY, NOW)).instanceId).toBe("claude-spare");
  });

  it("stays on the thread's account when every account is limited, reporting the soonest reset", async () => {
    const soon = new Date("2026-11-07T13:00:00Z");
    const { pool } = accountsPool([
      { id: "claude-local", credential: TOKEN, limitedUntil: LATER },
      { id: "claude-work", credential: TOKEN, limitedUntil: soon },
      { id: "claude-billed", credential: API_KEY, limitedUntil: new Date("2026-11-07T12:30:00Z") }
    ]);
    expect(await chooseClaudeAccount(pool, "claude-local", KEY, NOW)).toEqual({
      instanceId: "claude-local",
      fallbackFrom: null,
      allLimited: true,
      earliestReset: soon
    });
  });
});

describe("settleClaudeAccount", () => {
  const limitError = "Internal error: You've hit your session limit · resets 3pm (UTC)";

  it("records the limit and reports a ready fallback", async () => {
    const { pool, limits } = accountsPool([{ id: "claude-local", credential: TOKEN }, { id: "claude-work", credential: TOKEN }]);
    const outcome = await settleClaudeAccount(
      pool,
      { instanceId: "claude-local", fallbackFrom: null, allLimited: false, earliestReset: null, startedAt: EARLIER },
      { status: "failed", stdout: "", stderr: limitError, secretKey: KEY, now: NOW }
    );
    expect(limits.get("claude-local")?.toISOString()).toBe(LATER.toISOString());
    expect(outcome.fallbackReady).toBe(true);
  });

  it("holds an account whose printed reset has just passed instead of retrying it at once", async () => {
    const { pool, limits } = accountsPool([{ id: "claude-local", credential: TOKEN }]);
    const justAfter = new Date("2026-11-07T15:00:30Z");
    const outcome = await settleClaudeAccount(
      pool,
      { instanceId: "claude-local", fallbackFrom: null, allLimited: false, earliestReset: null, startedAt: EARLIER },
      { status: "failed", stdout: "", stderr: limitError, secretKey: KEY, now: justAfter }
    );
    expect(limits.get("claude-local")!.getTime()).toBe(justAfter.getTime() + MIN_LIMIT_MS);
    expect(outcome.fallbackReady).toBe(false);
    expect(outcome.earliestReset?.getTime()).toBe(justAfter.getTime() + MIN_LIMIT_MS);
  });

  it("never reports the account that just failed as the fallback", async () => {
    // claude-work failed as the fallback while claude-local is still limited.
    const { pool } = accountsPool([
      { id: "claude-local", credential: TOKEN, limitedUntil: new Date("2026-11-07T18:00:00Z") },
      { id: "claude-work", credential: TOKEN }
    ]);
    const justAfter = new Date("2026-11-07T15:00:30Z");
    const outcome = await settleClaudeAccount(
      pool,
      { instanceId: "claude-work", fallbackFrom: "claude-local", allLimited: false, earliestReset: null, startedAt: EARLIER },
      { status: "failed", stdout: "", stderr: limitError, secretKey: KEY, now: justAfter }
    );
    expect(outcome.fallbackReady).toBe(false);
  });

  it("reports no fallback when the last account hits its limit", async () => {
    const { pool } = accountsPool([
      { id: "claude-local", credential: TOKEN, limitedUntil: LATER },
      { id: "claude-work", credential: TOKEN }
    ]);
    const outcome = await settleClaudeAccount(
      pool,
      { instanceId: "claude-work", fallbackFrom: "claude-local", allLimited: false, earliestReset: null, startedAt: EARLIER },
      { status: "failed", stdout: "", stderr: limitError, secretKey: KEY, now: NOW }
    );
    expect(outcome.fallbackReady).toBe(false);
  });

  it("ignores failures that are not usage limits", async () => {
    const { pool, queries } = accountsPool([{ id: "claude-local", credential: TOKEN }]);
    const outcome = await settleClaudeAccount(
      pool,
      { instanceId: "claude-local", fallbackFrom: null, allLimited: false, earliestReset: null, startedAt: EARLIER },
      { status: "failed", stdout: "", stderr: "ACP session closed", secretKey: KEY, now: NOW }
    );
    expect(outcome.fallbackReady).toBe(false);
    expect(queries.some((query) => query.sql.includes("provider_account_limits"))).toBe(false);
  });

  it("clears only a limit recorded before a successful run started", async () => {
    const { pool, queries } = accountsPool([{ id: "claude-local", credential: TOKEN }]);
    await settleClaudeAccount(
      pool,
      { instanceId: "claude-local", fallbackFrom: null, allLimited: false, earliestReset: null, startedAt: EARLIER },
      { status: "succeeded", stdout: "", stderr: "", secretKey: KEY, now: NOW }
    );
    const clear = queries.find((query) => query.sql.includes("DELETE FROM provider_account_limits"));
    // startedAt is the database time recorded at launch, not the runner clock.
    expect(clear?.sql).toContain("limited_at < $2");
    expect(clear?.params).toEqual(["claude-local", EARLIER]);
  });
});

describe("rateLimitResetFromOutput", () => {
  const event = (status: string, resetsAt: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", _meta: { "_claude/rateLimit": { status, resetsAt } } } }
    });

  it("reads the reset of the last rejected rate-limit event", () => {
    const resetSeconds = Math.floor(LATER.getTime() / 1000);
    const stdout = [event("allowed_warning", resetSeconds - 600), event("rejected", resetSeconds)].join("\n");
    expect(rateLimitResetFromOutput(stdout, NOW)?.toISOString()).toBe(LATER.toISOString());
  });

  it("ignores overage events and resets beyond eight days", () => {
    const event2 = (info: Record<string, unknown>) =>
      JSON.stringify({ params: { update: { _meta: { "_claude/rateLimit": info } } } });
    const tooFar = Math.floor(NOW.getTime() / 1000) + 30 * 24 * 3600;
    expect(rateLimitResetFromOutput(event2({ status: "rejected", resetsAt: tooFar }), NOW)).toBeNull();
    expect(
      rateLimitResetFromOutput(event2({ status: "rejected", rateLimitType: "overage", resetsAt: Math.floor(LATER.getTime() / 1000) }), NOW)
    ).toBeNull();
  });

  it("ignores allowed events and output without them", () => {
    expect(rateLimitResetFromOutput(event("allowed", Math.floor(LATER.getTime() / 1000)), NOW)).toBeNull();
    expect(rateLimitResetFromOutput("not json", NOW)).toBeNull();
  });
});

describe("launchClaudeAccount", () => {
  it("records the chosen account on the run and stamps database time", async () => {
    const { pool, queries } = accountsPool([
      { id: "claude-local", credential: TOKEN, limitedUntil: new Date(Date.now() + 60 * 60_000) },
      { id: "claude-work", credential: TOKEN }
    ]);
    const launched = await launchClaudeAccount(pool, "dispatcher_runs", "run-1", "claude-local", KEY);
    expect(launched.instanceId).toBe("claude-work");
    expect(launched.startedAt).toBe(NOW);
    const update = queries.find((query) => query.sql.includes("UPDATE dispatcher_runs SET provider_instance_id"));
    expect(update?.params).toEqual(["run-1", "claude-work"]);
  });
});

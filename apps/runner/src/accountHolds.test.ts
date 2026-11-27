import { encryptSecret, type DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { codexRateLimitResetFromOutput, heldProviderAccounts, heldUntil, settleProviderAccount } from "./accountHolds.js";
import { MIN_LIMIT_MS } from "./claudeAccounts.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = new Date("2026-11-27T12:00:00Z");
const LATER = new Date("2026-11-27T15:00:00Z");
const SOONER = new Date("2026-11-27T13:00:00Z");
const TOKEN = "sk-ant-oat01-abc";

interface Account {
  id: string;
  driver: string;
  limitedUntil?: Date;
  credential?: string;
}

function accountsPool(accounts: Account[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM provider_account_limits account_limit")) {
      return {
        rows: accounts
          .filter((account) => account.limitedUntil && account.limitedUntil > (params[0] as Date))
          .map((account) => ({ provider_instance_id: account.id, limited_until: account.limitedUntil, driver: account.driver }))
      };
    }
    if (sql.includes("FROM provider_instances instance")) {
      return {
        rows: accounts
          .filter((account) => account.driver === "claude")
          .map((account) => ({ id: account.id, enabled: true, limited_until: account.limitedUntil ?? null }))
      };
    }
    if (sql.includes("FROM secrets")) {
      const name = String(params[0]);
      const id = name.includes("@") ? name.split("@")[1] : "claude-local";
      const credential = accounts.find((account) => account.id === id)?.credential;
      return { rows: credential ? [{ encrypted_value: encryptSecret(credential, KEY) }] : [] };
    }
    return { rows: [] };
  };
  return { pool: { query } as unknown as DbPool, queries };
}

describe("heldProviderAccounts", () => {
  it("holds nothing when no account is limited", async () => {
    const { pool } = accountsPool([{ id: "claude-local", driver: "claude" }]);
    expect((await heldProviderAccounts(pool, KEY, NOW)).size).toBe(0);
  });

  it("does not hold a limited Claude account while another Claude account is free", async () => {
    const { pool } = accountsPool([
      { id: "claude-local", driver: "claude", limitedUntil: LATER, credential: TOKEN },
      { id: "claude-second", driver: "claude", credential: TOKEN }
    ]);
    expect((await heldProviderAccounts(pool, KEY, NOW)).size).toBe(0);
  });

  it("holds Claude accounts until the soonest reset when every one is limited", async () => {
    const { pool } = accountsPool([
      { id: "claude-local", driver: "claude", limitedUntil: LATER, credential: TOKEN },
      { id: "claude-second", driver: "claude", limitedUntil: SOONER, credential: TOKEN }
    ]);
    const held = await heldProviderAccounts(pool, KEY, NOW);
    expect(held.get("claude-local")).toEqual(SOONER);
    expect(held.get("claude-second")).toEqual(SOONER);
  });

  it("holds a limited Codex account until its own reset", async () => {
    const { pool } = accountsPool([{ id: "codex-local", driver: "codex", limitedUntil: LATER }]);
    const held = await heldProviderAccounts(pool, KEY, NOW);
    expect(held.get("codex-local")).toEqual(LATER);
    // A run with no recorded account runs on the default Codex account.
    expect(heldUntil(held, [null])).toEqual(LATER);
    expect(heldUntil(held, ["claude-local"])).toBeNull();
  });

  it("treats a bookkeeping failure as nothing held", async () => {
    const pool = { query: async () => { throw new Error("relation does not exist"); } } as unknown as DbPool;
    expect((await heldProviderAccounts(pool, KEY, NOW)).size).toBe(0);
  });
});

describe("settleProviderAccount", () => {
  const codexLimit = "You've hit your usage limit. Upgrade to Pro or try again in 2 hours.";

  it("holds a Codex account until the reset its rate-limit notification reports", async () => {
    const { pool, queries } = accountsPool([]);
    const resetsAt = Math.floor(LATER.getTime() / 1000);
    const stdout = JSON.stringify({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 100, resetsAt }, secondary: { usedPercent: 40, resetsAt: resetsAt + 86400 } } }
    });
    const outcome = await settleProviderAccount(pool, {
      driver: "codex", instanceId: null, startedAt: NOW, status: "failed", stdout, stderr: codexLimit, now: NOW
    });
    expect(outcome.limitedUntil).toEqual(LATER);
    expect(outcome.reportedReset).toEqual(LATER);
    const insert = queries.find((query) => query.sql.includes("INSERT INTO provider_account_limits"));
    expect(insert?.params.slice(0, 2)).toEqual(["codex-local", LATER]);
  });

  it("falls back to the printed reset and holds at least briefly", async () => {
    const { pool } = accountsPool([]);
    const outcome = await settleProviderAccount(pool, {
      driver: "codex", instanceId: "codex-work", startedAt: NOW, status: "failed", stdout: "", stderr: codexLimit, now: NOW
    });
    expect(outcome.limitedUntil?.getTime()).toBe(NOW.getTime() + 2 * 60 * 60 * 1000);
    const passed = await settleProviderAccount(pool, {
      driver: "codex", instanceId: "codex-work", startedAt: NOW, status: "failed", stdout: "", stderr: "Usage limit reached.", now: NOW
    });
    expect(passed.limitedUntil!.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + MIN_LIMIT_MS);
    // No reset reported: the account is held for a cooldown, but the delivery
    // keeps its own backoff instead of waking at the cooldown.
    expect(passed.reportedReset).toBeNull();
  });

  it("clears only a limit recorded before a successful run started", async () => {
    const { pool, queries } = accountsPool([]);
    await settleProviderAccount(pool, {
      driver: "codex", instanceId: "codex-work", startedAt: NOW, status: "succeeded", stdout: "", stderr: "", now: NOW
    });
    const clear = queries.find((query) => query.sql.includes("DELETE FROM provider_account_limits"));
    expect(clear?.sql).toContain("limited_at < $2");
    expect(clear?.params).toEqual(["codex-work", NOW]);
  });

  it("ignores ordinary failures and leaves Claude to its own bookkeeping", async () => {
    const { pool, queries } = accountsPool([]);
    expect((await settleProviderAccount(pool, {
      driver: "codex", instanceId: null, startedAt: NOW, status: "failed", stdout: "", stderr: "TypeError: boom", now: NOW
    })).limitedUntil).toBeNull();
    expect((await settleProviderAccount(pool, {
      driver: "claude", instanceId: null, startedAt: NOW, status: "failed", stdout: "", stderr: codexLimit, now: NOW
    })).limitedUntil).toBeNull();
    expect(queries).toHaveLength(0);
  });
});

describe("codexRateLimitResetFromOutput", () => {
  const line = (primary: number, secondary: number, resetSeconds: number) => JSON.stringify({
    jsonrpc: "2.0",
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: { usedPercent: primary, resetsAt: resetSeconds }, secondary: { usedPercent: secondary, resetsAt: resetSeconds + 3600 } } }
  });
  const reset = Math.floor(LATER.getTime() / 1000);

  it("reads the latest reset among exhausted windows", () => {
    expect(codexRateLimitResetFromOutput(line(100, 100, reset), NOW)).toEqual(new Date((reset + 3600) * 1000));
    expect(codexRateLimitResetFromOutput(line(100, 20, reset), NOW)).toEqual(LATER);
  });

  it("uses the last notification and ignores windows with room", () => {
    expect(codexRateLimitResetFromOutput(`${line(100, 20, reset)}\n${line(30, 20, reset)}`, NOW)).toBeNull();
    expect(codexRateLimitResetFromOutput("not json account/rateLimits/updated", NOW)).toBeNull();
    expect(codexRateLimitResetFromOutput("", NOW)).toBeNull();
  });
});

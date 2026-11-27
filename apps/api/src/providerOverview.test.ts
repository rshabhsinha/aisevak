import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { loadProviderOverview, recordExhaustedAccounts } from "./providerOverview.js";
import type { AccountLimits } from "./usageLimits.js";

const NOW = new Date("2026-11-27T12:00:00Z");
const RESET = "2026-11-27T14:00:00.000Z";
const WEEK_RESET = "2026-11-30T00:00:00.000Z";

function reading(overrides: Partial<AccountLimits> = {}): AccountLimits {
  return {
    accountId: "claude-local",
    driver: "claude",
    source: "live",
    checkedAt: NOW.toISOString(),
    plan: "Claude subscription",
    windows: [
      { id: "five_hour", label: "Session (5h)", kind: "session", usedPercent: 100, resetsAt: RESET, windowMinutes: 300 },
      { id: "seven_day", label: "Weekly · all models", kind: "weekly", usedPercent: 62, resetsAt: WEEK_RESET, windowMinutes: 10080 }
    ],
    groups: [],
    credits: [],
    note: null,
    error: null,
    ...overrides
  };
}

function recordingPool() {
  const inserts: unknown[][] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("INSERT INTO provider_account_limits")) inserts.push(params);
      return { rows: [] };
    }
  } as unknown as DbPool;
  return { pool, inserts };
}

describe("recordExhaustedAccounts", () => {
  it("holds an account whose session window is used up until that window resets", async () => {
    const { pool, inserts } = recordingPool();
    await recordExhaustedAccounts(pool, [reading()], NOW);
    expect(inserts).toEqual([["claude-local", new Date(RESET)]]);
  });

  it("holds until the later reset when both windows are used up", async () => {
    const { pool, inserts } = recordingPool();
    const windows = reading().windows.map((window) => ({ ...window, usedPercent: 100 }));
    await recordExhaustedAccounts(pool, [reading({ windows })], NOW);
    expect(inserts).toEqual([["claude-local", new Date(WEEK_RESET)]]);
  });

  it("leaves accounts alone that can keep running or whose reading is not live", async () => {
    const { pool, inserts } = recordingPool();
    await recordExhaustedAccounts(pool, [
      reading({ credits: [{ label: "Extra usage", value: "$1.00 of $50.00" }] }),
      reading({ source: "snapshot" }),
      reading({ windows: reading().windows.map((window) => ({ ...window, usedPercent: 99 })) }),
      reading({ windows: [{ ...reading().windows[0]!, resetsAt: "2026-11-27T11:00:00.000Z" }] }),
      // Header readings cannot see extra usage: only a rejected status counts.
      reading({ unifiedStatus: "allowed" }),
      reading({ unifiedStatus: "allowed_warning" }),
      reading({ unifiedStatus: null }),
      // A per-model weekly limit does not stop the account.
      reading({
        windows: [],
        groups: [{ label: "Per model", windows: [{ id: "scoped_opus", label: "Weekly · Opus", kind: "weekly", usedPercent: 100, resetsAt: WEEK_RESET, windowMinutes: 10080 }] }]
      })
    ], NOW);
    expect(inserts).toEqual([]);
  });

  it("trusts a header reading that Anthropic reports as rejected", async () => {
    const { pool, inserts } = recordingPool();
    await recordExhaustedAccounts(pool, [reading({ unifiedStatus: "rejected" })], NOW);
    expect(inserts).toEqual([["claude-local", new Date(RESET)]]);
  });
});

describe("loadProviderOverview", () => {
  it("lists every account, several of one harness included, with the caller's account marked", async () => {
    const limitedUntil = new Date(Date.now() + 60 * 60 * 1000);
    const pool = {
      async query(sql: string) {
        if (sql.includes("FROM provider_instances instance")) {
          return {
            rows: [
              { id: "claude-local", driver: "claude", label: null, limited_until: limitedUntil, agents: ["Orchestrator"] },
              { id: "claude-second", driver: "claude", label: "Second", limited_until: null, agents: ["Builder", "Reviewer"] },
              { id: "devin-local", driver: "devin", label: null, limited_until: null, agents: null }
            ]
          };
        }
        if (sql.includes("FROM agent_threads")) return { rows: [{ provider_instance_id: "claude-second" }] };
        // No stored credentials: every account reads as not connected.
        return { rows: [] };
      }
    } as unknown as DbPool;

    const overview = await loadProviderOverview(pool, Buffer.alloc(32, 7).toString("base64"), { agentThreadId: "thread-1" });

    expect(overview.currentAccountId).toBe("claude-second");
    expect(overview.providers.map((provider) => [provider.accountId, provider.current, provider.available])).toEqual([
      ["claude-local", false, false],
      ["claude-second", true, true],
      ["devin-local", false, true]
    ]);
    expect(overview.providers[0]).toMatchObject({
      isDefault: true,
      limitedUntil: limitedUntil.toISOString(),
      agents: ["AGENT-Orchestrator"],
      session: null,
      weekly: null,
      note: "Not connected."
    });
    expect(overview.providers[1]?.label).toBe("Second");
    expect(overview.providers[2]?.note).toContain("Devin");
  });
});

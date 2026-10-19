import { describe, expect, it } from "vitest";
import { aggregateUsage, parseUsageRow, pricingTableFromLiteLlm, type UsageEventRow } from "./usageAnalytics.js";

const at = new Date("2026-10-18T10:00:00Z");

function row(payload: unknown, overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return { created_at: at, payload, model: "gpt-6.1-sol", driver: "codex", thread_id: "t1", thread_title: "Fix login", account_id: "codex-local", ...overrides };
}

const codexUsage = {
  method: "thread/tokenUsage/updated",
  params: {
    tokenUsage: {
      last: { inputTokens: 18_522, cachedInputTokens: 2_432, outputTokens: 133, reasoningOutputTokens: 37, totalTokens: 18_655 },
      total: { inputTokens: 40_895, totalTokens: 41_546 }
    }
  }
};

const pricing = pricingTableFromLiteLlm({
  "gpt-6.1-sol": { input_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-7, output_cost_per_token: 1e-5 },
  "claude-opus-5-5": {
    input_cost_per_token: 4e-6,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 5e-6,
    output_cost_per_token: 2e-5
  }
});

describe("usage event parsing", () => {
  it("reads Codex last-request usage from legacy and v2 payloads, excluding cached tokens from input", () => {
    const legacy = parseUsageRow(row({ type: "thread/tokenUsage/updated", raw: codexUsage }));
    const v2 = parseUsageRow(
      row({ v: 2, type: "usage.updated", provider: "codex", raw: { source: "codex.app-server", method: codexUsage.method, payload: codexUsage } })
    );
    for (const parsed of [legacy, v2]) {
      expect(parsed).toMatchObject({
        kind: "tokens",
        sample: { driver: "codex", inputTokens: 16_090, cachedInputTokens: 2_432, outputTokens: 133, reasoningTokens: 37 }
      });
    }
  });

  it("reads ACP prompt-result usage, where input already excludes cache reads", () => {
    const parsed = parseUsageRow(
      row(
        {
          v: 2,
          type: "turn.completed",
          provider: "claude",
          raw: {
            source: "acp.jsonrpc",
            payload: { id: 5, result: { stopReason: "end_turn", usage: { inputTokens: 6_675, cachedReadTokens: 1_792, cachedWriteTokens: 40, outputTokens: 21 } } }
          }
        },
        { model: "claude-opus-5-5", driver: "claude", account_id: "claude-work" }
      )
    );
    expect(parsed).toMatchObject({
      kind: "tokens",
      sample: { driver: "claude", accountId: "claude-work", inputTokens: 6_675, cachedInputTokens: 1_792, cacheWriteTokens: 40, outputTokens: 21 }
    });
  });

  it("treats ACP usage_update cost as a cumulative session cost", () => {
    const update = (amount: number) =>
      row(
        { type: "usage_update", raw: { method: "session/update", params: { sessionId: "ses_1", update: { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } } } } },
        { driver: "claude" }
      );
    const result = aggregateUsage([update(0.4), update(1.25), update(0.9)], {
      days: 7,
      tzOffsetMinutes: 0,
      since: new Date("2026-10-12T00:00:00Z"),
      now: at,
      pricing
    });
    expect(result.harnesses[0]).toMatchObject({ driver: "claude", reportedCostUsd: 1.25 });
  });
});

describe("usage aggregation", () => {
  it("prices tokens per model and rolls them up by harness, model, account and day", () => {
    const rows = [
      row({ type: "thread/tokenUsage/updated", raw: codexUsage }),
      row({ type: "thread/tokenUsage/updated", raw: codexUsage }, { thread_id: "t2", thread_title: "Docs", account_id: null }),
      row({ type: "thread/tokenUsage/updated", raw: codexUsage }, { model: "mystery-model" })
    ];
    const result = aggregateUsage(rows, { days: 7, tzOffsetMinutes: -330, since: new Date("2026-10-12T00:00:00Z"), now: at, pricing });

    // 16,090 uncached × $2 + 2,432 cached × $0.10 + 133 output × $10, per million.
    const perRequest = (16_090 * 2 + 2_432 * 0.1 + 133 * 10) / 1_000_000;
    const codex = result.harnesses[0]!;
    expect(codex.totals.requests).toBe(3);
    expect(codex.totals.costUsd).toBeCloseTo(perRequest * 2, 8);
    expect(codex.totals.unpricedTokens).toBe(16_090 + 2_432 + 133);
    expect(codex.models.map((model) => model.model)).toEqual(["gpt-6.1-sol", "mystery-model"]);
    expect(codex.models[1]!.pricing).toBeNull();
    // Rows without a thread account fall back to the harness's default account.
    expect(codex.accounts).toEqual([{ accountId: "codex-local", totals: expect.objectContaining({ requests: 3 }) }]);
    expect(result.daily).toHaveLength(7);
    expect(result.daily.at(-1)).toMatchObject({ date: "2026-10-18" });
    expect(result.topThreads[0]).toMatchObject({ threadId: "t1", title: "Fix login" });
  });

  it("matches harness-prefixed and aliased model ids to prices", () => {
    expect(pricing.lookup("openai/gpt-6.1-sol")).toMatchObject({ input: 2 });
    expect(pricing.lookup("claude-opus-5-5[1m]")).toMatchObject({ cacheWrite: 5 });
    expect(pricing.lookup("opus")).toMatchObject({ output: 20 });
    expect(pricing.lookup("auto")).toBeNull();
  });
});

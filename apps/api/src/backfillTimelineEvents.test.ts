import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { backfillPayload, backfillTimelineEvents, parseBackfillArgs } from "./backfillTimelineEvents.js";

const IMAGE_OUTPUT = JSON.stringify(
  [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(600_000) } }],
  null,
  2
);

function imageRead(extra: Record<string, unknown> = {}) {
  return {
    v: 2,
    type: "item.completed",
    provider: "claude",
    itemId: "toolu_read",
    item: { itemType: "file_read", status: "completed", title: "Read board.png", output: IMAGE_OUTPUT },
    raw: { source: "acp.jsonrpc", method: "session/update", payload: { rawOutput: IMAGE_OUTPUT } },
    ...extra
  };
}

describe("backfillPayload", () => {
  it("deletes replayed history", () => {
    expect(backfillPayload(imageRead({ replay: true }))).toEqual({ action: "delete" });
    expect(backfillPayload({ v: 2, type: "content.delta", replay: true, raw: { source: "acp.jsonrpc", payload: {} } })).toEqual({ action: "delete" });
  });

  it("summarizes inline images and drops the oversized raw message", () => {
    const decision = backfillPayload(imageRead());
    expect(decision.action).toBe("update");
    if (decision.action !== "update") return;
    expect(decision.payload.item?.output).toBe("[image: image/png, 439 KB]");
    expect(decision.payload.raw).toEqual({ source: "acp.jsonrpc", method: "session/update", payload: { omitted: true, chars: expect.any(Number) } });
    expect(decision.payload.itemId).toBe("toolu_read");
    expect(JSON.stringify(decision.payload).length).toBeLessThan(1000);
  });

  it("clips oversized plain output, keeping both ends", () => {
    const output = `start${"x".repeat(400_000)}end`;
    const decision = backfillPayload({ ...imageRead(), item: { itemType: "command_execution", status: "completed", output }, raw: { source: "codex.app-server", payload: {} } });
    expect(decision.action).toBe("update");
    if (decision.action !== "update") return;
    expect(decision.payload.item?.output?.startsWith("start")).toBe(true);
    expect(decision.payload.item?.output?.endsWith("end")).toBe(true);
    expect(decision.payload.item?.outputOmittedChars).toBeGreaterThan(0);
  });

  it("keeps small, legacy, aisevak-written and accounting rows as they are", () => {
    expect(backfillPayload({ v: 2, type: "content.delta", delta: { stream: "assistant", text: "hi" }, raw: { source: "acp.jsonrpc", payload: {} } })).toEqual({ action: "keep" });
    expect(backfillPayload({ method: "item/completed", params: { output: IMAGE_OUTPUT } })).toEqual({ action: "keep" });
    expect(backfillPayload({ type: "thread.message-sent", text: "hello" })).toEqual({ action: "keep" });
    const bigRaw = { blob: "x".repeat(50_000) };
    expect(backfillPayload({ v: 2, type: "usage.updated", raw: { source: "codex.app-server", payload: bigRaw } })).toEqual({ action: "keep" });
    expect(backfillPayload({ v: 2, type: "provider.event", raw: { source: "codex.app-server", payload: { method: "account/rateLimits/updated", ...bigRaw } } })).toEqual({ action: "keep" });
    expect(backfillPayload({ v: 2, type: "provider.event", raw: { source: "acp.jsonrpc", payload: { result: { usage: { inputTokens: 1 } }, ...bigRaw } } })).toEqual({ action: "keep" });
  });
});

describe("backfillTimelineEvents", () => {
  function fakePool(rows: Array<{ id: string; payload: unknown }>) {
    const writes: Array<{ sql: string; params?: unknown[] }> = [];
    const select = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT id, payload")) {
        const after = params?.[0] as string | null;
        const batch = rows.filter((row) => after === null || row.id > after).slice(0, params?.[1] as number);
        return { rows: batch.map((row) => ({ ...row, bytes: JSON.stringify(row.payload).length })) };
      }
      writes.push({ sql, params });
      return { rows: [] };
    };
    const pool = { query: select, connect: async () => ({ query: select, release() {} }) } as unknown as DbPool;
    return { pool, writes };
  }

  const rows = [
    { id: "00000000-0000-4000-8000-000000000001", payload: imageRead({ replay: true }) },
    { id: "00000000-0000-4000-8000-000000000002", payload: imageRead() },
    { id: "00000000-0000-4000-8000-000000000003", payload: { type: "thread.message-sent", text: "x".repeat(20_000) } }
  ];

  it("reports without writing in a dry run", async () => {
    const { pool, writes } = fakePool(rows);
    const lines: string[] = [];
    const result = await backfillTimelineEvents(pool, { dryRun: true, batchSize: 2, after: null, tables: ["run_events"], log: (line) => lines.push(line) });
    expect(writes).toEqual([]);
    expect(result.run_events).toMatchObject({ scanned: 3, deleted: 1, updated: 1 });
    expect(result.run_events.bytesBefore - result.run_events.bytesAfter).toBeGreaterThan(1_000_000);
    expect(lines.at(-2)).toContain("--after 00000000-0000-4000-8000-000000000003");
  });

  it("deletes and rewrites in one transaction per batch", async () => {
    const { pool, writes } = fakePool(rows);
    await backfillTimelineEvents(pool, { dryRun: false, batchSize: 10, after: null, tables: ["dispatcher_run_events"], log: () => {} });
    expect(writes.map((write) => write.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "DELETE FROM dispatcher_run_events",
      "UPDATE dispatcher_run_events SET",
      "COMMIT"
    ]);
    expect(writes[1]?.params).toEqual([["00000000-0000-4000-8000-000000000001"]]);
    expect(writes[2]?.params?.[0]).toBe("00000000-0000-4000-8000-000000000002");
  });
});

describe("parseBackfillArgs", () => {
  it("parses flags and rejects unknown ones", () => {
    expect(parseBackfillArgs(["--", "--dry-run", "--batch", "50", "--table", "run_events", "--after", "abc"])).toEqual({
      dryRun: true,
      batchSize: 50,
      after: "abc",
      tables: ["run_events"]
    });
    expect(() => parseBackfillArgs(["--table", "users"])).toThrow(/--table/);
    expect(() => parseBackfillArgs(["--force"])).toThrow(/Unknown argument/);
  });
});

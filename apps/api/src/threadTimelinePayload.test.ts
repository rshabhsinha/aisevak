import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { getAgentThreadTimeline } from "./server.js";
import { fullTimelineOutput, MAX_TIMELINE_OUTPUT_CHARS, slimTimelineEvent } from "./timelinePayload.js";

const THREAD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function toolEvent(output: string, extra: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    seq: 3,
    event_type: "item.completed",
    text: "Read file",
    payload: {
      v: 2,
      type: "item.completed",
      provider: "claude",
      item: { itemType: "file_read", status: "completed", title: "Read file", output, input: { content: "x".repeat(10_000) } },
      raw: { source: "acp.jsonrpc", payload: { output } },
      ...extra
    }
  };
}

describe("timeline payloads", () => {
  it("drops raw and large inputs and clips output with an omitted count", () => {
    const output = "o".repeat(MAX_TIMELINE_OUTPUT_CHARS * 3);
    const slim = slimTimelineEvent(toolEvent(output)).payload as { raw?: unknown; item: Record<string, unknown> };
    expect(slim.raw).toBeUndefined();
    expect(slim.item.input).toBeUndefined();
    expect((slim.item.output as string).length).toBeLessThan(MAX_TIMELINE_OUTPUT_CHARS + 100);
    expect(slim.item.outputOmittedChars).toBe(output.length - MAX_TIMELINE_OUTPUT_CHARS);
    expect(slim.item.title).toBe("Read file");
  });

  it("re-renders legacy JSON image output as a placeholder", () => {
    const legacy = JSON.stringify(
      [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(600_000) } }],
      null,
      2
    );
    const slim = slimTimelineEvent(toolEvent(legacy)).payload as { item: Record<string, unknown> };
    expect(slim.item.output).toBe("[image: image/png, 439 KB]");
    expect(slim.item.outputOmittedChars).toBeUndefined();
    expect(fullTimelineOutput(toolEvent(legacy).payload)).toEqual({ output: "[image: image/png, 439 KB]", omittedChars: 0 });
  });

  it("passes rows aisevak writes itself through unchanged", () => {
    const event = { id: "m", seq: -1, event_type: "thread.message-sent", text: "hi", payload: { type: "thread.message-sent", text: "hi" } };
    expect(slimTimelineEvent(event)).toEqual(event);
  });
});

describe("agent thread timeline polling", () => {
  function threadPool(eventRows: Array<Record<string, unknown>>) {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("FROM agent_threads")) return { rows: [{ id: THREAD_ID, task_id: null }] };
        if (sql.includes("task_runs_and_dispatches")) {
          return { rows: [{ id: "run-1", kind: "dispatcher", status: "running", prompt: "first prompt", queued_at: "2026-10-20T10:00:00.000Z" }] };
        }
        // A delta poll reads rows after the cursor in one query.
        if (sql.includes("newest_thread_events")) return { rows: eventRows };
        // A full page ranks narrow keys first, then loads the kept bodies.
        if (sql.includes("task_event_keys")) {
          return { rows: [...eventRows].reverse().map((row) => ({ source: "dispatcher", id: row.id })) };
        }
        if (sql.includes("id = ANY($1::uuid[])")) {
          const ids = params?.[1] as string[];
          return { rows: eventRows.filter((row) => ids.includes(String(row.id))).map((row) => ({ source: "dispatcher", ...row })) };
        }
        if (sql.includes("FROM agent_turn_inputs")) {
          return {
            rows: [{
              id: "steer-1",
              run_id: null,
              dispatcher_run_id: "run-0",
              seq: 0,
              event_type: "thread.message-sent",
              text: "steer",
              payload: { type: "thread.message-sent", steer: true, deliveryStatus: "delivered" },
              created_at: "2026-10-20T10:00:05.000Z"
            }]
          };
        }
        if (sql.includes("UNION") && sql.includes("event_type = 'thread.message-sent'")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }
    } as unknown as DbPool;
    return { pool, queries };
  }

  const providerRow = (id: string, createdAt: string, payload: Record<string, unknown> = { v: 2, type: "content.delta" }) => ({
    id,
    run_id: null,
    dispatcher_run_id: "run-1",
    seq: 1,
    event_type: String(payload.type),
    text: null,
    payload,
    created_at: createdAt
  });

  it("returns only rows after the cursor, minus an overlap, with live rows sent whole", async () => {
    const { pool, queries } = threadPool([
      providerRow("e-1", "2026-10-20T10:00:09.000Z"),
      providerRow("e-2", "2026-10-20T10:00:12.000Z")
    ]);
    const timeline = await getAgentThreadTimeline(pool, THREAD_ID, new Date("2026-10-20T10:00:10.000Z"));

    const eventsQuery = queries.find((query) => query.sql.includes("newest_thread_events"))!;
    expect(eventsQuery.params?.[1]).toEqual(new Date("2026-10-20T10:00:00.000Z"));
    expect(timeline.mode).toBe("delta");
    expect(timeline.cursor).toBe("2026-10-20T10:00:12.000Z");
    expect(timeline.events.map((event) => event.id)).toEqual(["e-1", "e-2"]);
    expect(timeline.liveEvents.map((event) => event.id)).toEqual(["user-message:run-1", "steer-1"]);
  });

  it("drops replayed history and keeps the cursor when nothing is new", async () => {
    const { pool } = threadPool([
      providerRow("replayed", "2026-10-20T10:00:01.000Z", { v: 2, type: "item.completed", replay: true })
    ]);
    const timeline = await getAgentThreadTimeline(pool, THREAD_ID, null);
    expect(timeline.mode).toBe("full");
    expect(timeline.events).toEqual([]);
    expect(timeline.cursor).toBe("2026-10-20T10:00:01.000Z");

    const empty = threadPool([]);
    const delta = await getAgentThreadTimeline(empty.pool, THREAD_ID, new Date("2026-10-20T10:00:01.000Z"));
    expect(delta.mode).toBe("delta");
    expect(delta.cursor).toBe("2026-10-20T10:00:01.000Z");
  });

  it("falls back to a full page when a delta overflows it", async () => {
    // One row more than a page (2,000) after the cursor: the client's copy would have a gap.
    const rows = Array.from({ length: 2_001 }, (_, index) =>
      providerRow(`e-${index}`, new Date(Date.parse("2026-10-20T10:00:30.000Z") + index).toISOString())
    );
    const { pool, queries } = threadPool(rows);
    const timeline = await getAgentThreadTimeline(pool, THREAD_ID, new Date("2026-10-20T10:00:10.000Z"));
    const delta = queries.filter((query) => query.sql.includes("newest_thread_events"));
    expect(delta.map((query) => query.params?.[1])).toEqual([new Date("2026-10-20T10:00:00.000Z")]);
    // The full page ranks keys for the thread alone, without steer inputs (sent as live events).
    const keys = queries.find((query) => query.sql.includes("task_event_keys"))!;
    expect(keys.params).toEqual([THREAD_ID, 2_001, false]);
    expect(timeline.mode).toBe("full");
    expect(timeline.eventsTruncated).toBe(true);
  });
});

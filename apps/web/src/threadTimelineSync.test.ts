import { describe, expect, it } from "vitest";
import { applyThreadTimelineResponse, threadTimelineEvents, threadTimelineQuery } from "./threadTimelineSync";

const event = (id: string, text = id) => ({ id, text });

describe("thread timeline sync", () => {
  it("merges a delta by id and replaces the live rows", () => {
    const full = applyThreadTimelineResponse(null, "t1", {
      mode: "full",
      cursor: "2026-10-20T10:00:00.000Z",
      events: [event("a"), event("b")],
      liveEvents: [event("steer", "queued")],
      eventsTruncated: true
    });
    const next = applyThreadTimelineResponse(full, "t1", {
      mode: "delta",
      cursor: "2026-10-20T10:00:05.000Z",
      events: [event("b"), event("c")],
      liveEvents: [event("steer", "delivered")]
    });
    expect(threadTimelineEvents(next)).toEqual([event("a"), event("b"), event("c"), event("steer", "delivered")]);
    expect(next.cursor).toBe("2026-10-20T10:00:05.000Z");
    expect(next.truncated).toBe(true);
    expect(threadTimelineQuery(next, "t1")).toBe("?after=2026-10-20T10%3A00%3A05.000Z");
  });

  it("keeps the same events array when a delta brings nothing new", () => {
    const full = applyThreadTimelineResponse(null, "t1", { mode: "full", cursor: "c1", events: [event("a")] });
    const next = applyThreadTimelineResponse(full, "t1", { mode: "delta", cursor: null, events: [] });
    expect(next.events).toBe(full.events);
    expect(next.cursor).toBe("c1");
  });

  it("starts over for a full response or another thread", () => {
    const cache = applyThreadTimelineResponse(null, "t1", { mode: "full", cursor: "c1", events: [event("a")] });
    expect(applyThreadTimelineResponse(cache, "t2", { mode: "delta", cursor: "c2", events: [event("z")] }).events).toEqual([event("z")]);
    expect(applyThreadTimelineResponse(cache, "t1", { mode: "full", cursor: "c3", events: [event("b")] }).events).toEqual([event("b")]);
    expect(threadTimelineQuery(cache, "t2")).toBe("");
  });
});

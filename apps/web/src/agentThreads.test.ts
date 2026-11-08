import { describe, expect, it } from "vitest";
import {
  groupSidebarThreads,
  isThreadUnread,
  markThreadSeen,
  mergeRefreshedAgentThreads,
  updateAgentThreadInPlace
} from "./agentThreads.js";

describe("mergeRefreshedAgentThreads", () => {
  it("updates the first page without evicting loaded older threads", () => {
    const current = [
      { id: "recent", status: "queued" },
      { id: "selected-older", status: "running" }
    ];
    const refreshed = [
      { id: "new", status: "running" },
      { id: "recent", status: "succeeded" }
    ];

    expect(mergeRefreshedAgentThreads(current, refreshed)).toEqual([
      { id: "new", status: "running" },
      { id: "recent", status: "succeeded" },
      { id: "selected-older", status: "running" }
    ]);
  });

  it("moves a thread to its activity position after a poll", () => {
    const current = [
      { id: "newer", title: "Same title", status: "running", last_activity_at: "2026-08-22T10:00:00.000Z" },
      { id: "selected", title: "Same title", status: "queued", last_activity_at: "2026-08-22T09:00:00.000Z" }
    ];

    expect(updateAgentThreadInPlace(current, {
      id: "selected",
      title: "Same title",
      status: "running",
      last_activity_at: "2026-08-22T11:00:00.000Z"
    })).toEqual([
      { id: "selected", title: "Same title", status: "running", last_activity_at: "2026-08-22T11:00:00.000Z" },
      { id: "newer", title: "Same title", status: "running", last_activity_at: "2026-08-22T10:00:00.000Z" }
    ]);
  });

  it("orders refreshed pages by activity and uses id as a stable tie-breaker", () => {
    expect(mergeRefreshedAgentThreads(
      [
        { id: "older", last_activity_at: "2026-08-22T08:00:00.000Z" },
        { id: "same-a", last_activity_at: "2026-08-22T09:00:00.000Z" }
      ],
      [
        { id: "same-b", last_activity_at: "2026-08-22T09:00:00.000Z" },
        { id: "newest", last_activity_at: "2026-08-22T10:00:00.000Z" }
      ]
    ).map((thread) => thread.id)).toEqual(["newest", "same-b", "same-a", "older"]);
  });
});

describe("groupSidebarThreads", () => {
  it("puts running and unopened failures first, then buckets the rest by day", () => {
    const now = new Date(2026, 9, 20, 15, 0);
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const threads = [
      { id: "run", status: "running", last_activity_at: at(20, 14) },
      { id: "fail", status: "failed", last_activity_at: at(20, 13) },
      { id: "today", status: "succeeded", last_activity_at: at(20, 9) },
      { id: "yesterday", status: "succeeded", last_activity_at: at(19, 22) },
      { id: "old", status: "succeeded", last_activity_at: at(12, 9) }
    ];

    const groups = groupSidebarThreads(threads, {
      now,
      isRunning: (thread) => thread.status === "running",
      needsAttention: (thread) => thread.status === "failed"
    });

    expect(groups.map((group) => [group.id, group.threads.map((thread) => thread.id)])).toEqual([
      ["running", ["run"]],
      ["attention", ["fail"]],
      ["today", ["today"]],
      ["yesterday", ["yesterday"]],
      ["earlier", ["old"]]
    ]);
  });
});

describe("thread seen state", () => {
  const state = { since: "2026-10-20T10:00:00.000Z", seen: {} };

  it("treats activity before the first visit as seen", () => {
    expect(isThreadUnread(state, { id: "a", last_activity_at: "2026-10-20T09:00:00.000Z" })).toBe(false);
    expect(isThreadUnread(state, { id: "a", last_activity_at: "2026-10-20T11:00:00.000Z" })).toBe(true);
  });

  it("clears unread once the latest activity is seen, and returns to unread on new activity", () => {
    const seen = markThreadSeen(state, "a", "2026-10-20T11:00:00.000Z");
    expect(isThreadUnread(seen, { id: "a", last_activity_at: "2026-10-20T11:00:00.000Z" })).toBe(false);
    expect(isThreadUnread(seen, { id: "a", last_activity_at: "2026-10-20T11:05:00.000Z" })).toBe(true);
    expect(markThreadSeen(seen, "a", "2026-10-20T11:00:00.000Z")).toBe(seen);
  });
});

import { describe, expect, it } from "vitest";
import { mergeRefreshedAgentThreads, updateAgentThreadInPlace } from "./agentThreads.js";

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

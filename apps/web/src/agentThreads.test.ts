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

  it("updates a polled thread without moving the selected row", () => {
    const current = [
      { id: "newer", title: "Same title", status: "running" },
      { id: "selected", title: "Same title", status: "queued" }
    ];

    expect(updateAgentThreadInPlace(current, {
      id: "selected",
      title: "Same title",
      status: "running"
    })).toEqual([
      { id: "newer", title: "Same title", status: "running" },
      { id: "selected", title: "Same title", status: "running" }
    ]);
  });
});

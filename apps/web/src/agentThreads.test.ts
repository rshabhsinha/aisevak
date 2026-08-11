import { describe, expect, it } from "vitest";
import { mergeRefreshedAgentThreads } from "./agentThreads.js";

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
});

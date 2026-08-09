import { describe, expect, it } from "vitest";
import { reconcileSelectedAgent } from "./agentModels.js";

describe("reconcileSelectedAgent", () => {
  it("replaces a selected agent with its refreshed server value", () => {
    const selected = { id: "agent-1", model: "gpt-5.5" };
    const refreshed = [{ id: "agent-1", model: "gpt-5.6-luna" }];

    expect(reconcileSelectedAgent(selected, refreshed)).toBe(refreshed[0]);
  });

  it("preserves a new unsaved agent while the list refreshes", () => {
    const selected = { id: "", model: "gpt-5.6-luna" };

    expect(reconcileSelectedAgent(selected, [{ id: "agent-1", model: "gpt-5.6-luna" }])).toBe(selected);
  });
});

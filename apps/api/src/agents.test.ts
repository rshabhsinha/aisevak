import { describe, expect, it } from "vitest";
import { agentDeletionBlockReason, planAgentModelUpdate } from "./agents.js";

describe("agentDeletionBlockReason", () => {
  it("allows an unused worker to be deleted", () => {
    expect(
      agentDeletionBlockReason(
        { kind: "worker", name: "Builder" },
        { taskCount: 0, threadCount: 0, scheduleCount: 0, otherEnabledDispatcherCount: 1 }
      )
    ).toBeNull();
  });

  it("requires tasks and threads to be reassigned", () => {
    expect(
      agentDeletionBlockReason(
        { kind: "worker", name: "Builder" },
        { taskCount: 2, threadCount: 1, scheduleCount: 0, otherEnabledDispatcherCount: 1 }
      )
    ).toBe("Cannot delete Builder because it is used by 2 tasks and 1 thread. Reassign those first.");
  });

  it("protects the last enabled Orchestrator", () => {
    expect(
      agentDeletionBlockReason(
        { kind: "dispatcher", name: "Orchestrator" },
        { taskCount: 0, threadCount: 0, scheduleCount: 0, otherEnabledDispatcherCount: 0 }
      )
    ).toBe("Cannot delete Orchestrator because it is the last enabled Orchestrator.");
  });

  it("requires schedules to be removed or reassigned", () => {
    expect(
      agentDeletionBlockReason(
        { kind: "worker", name: "Reviewer" },
        { taskCount: 0, threadCount: 0, scheduleCount: 1, otherEnabledDispatcherCount: 1 }
      )
    ).toBe("Cannot delete Reviewer because it is used by 1 schedule. Reassign those first.");
  });
});

describe("planAgentModelUpdate", () => {
  it("moves a Codex agent onto Claude Code with Opus 5.5 at medium effort", () => {
    expect(planAgentModelUpdate({ driver: "claude", previousDriver: "codex", currentModel: "gpt-5.6-luna", requestedModel: null, requestedOptions: null }))
      .toEqual({ model: "claude-opus-5-5", modelOptions: [{ id: "reasoningEffort", value: "medium" }], error: null });
  });

  it("keeps explicit Claude choices and options", () => {
    expect(planAgentModelUpdate({
      driver: "claude", previousDriver: "devin", currentModel: "swe-2-high", requestedModel: "claude-sonnet-5-5",
      requestedOptions: [{ id: "reasoningEffort", value: "low" }]
    })).toEqual({ model: "claude-sonnet-5-5", modelOptions: [{ id: "reasoningEffort", value: "low" }], error: null });
  });

  it("refuses a non-Claude model for Claude Code", () => {
    expect(planAgentModelUpdate({ driver: "claude", previousDriver: "claude", currentModel: "claude-opus-5-5", requestedModel: "gpt-5.6-luna", requestedOptions: null }).error)
      .toMatch(/need a Claude model/);
  });

  it("leaves other harnesses untouched", () => {
    expect(planAgentModelUpdate({ driver: "devin", previousDriver: "devin", currentModel: "swe-2-high", requestedModel: null, requestedOptions: null }))
      .toEqual({ model: null, modelOptions: null, error: null });
  });

  it("requires a model when an agent leaves Claude Code", () => {
    expect(planAgentModelUpdate({ driver: "codex", previousDriver: "claude", currentModel: "claude-opus-5-5", requestedModel: null, requestedOptions: null }).error)
      .toMatch(/Choose a model/);
    expect(planAgentModelUpdate({ driver: "codex", previousDriver: "claude", currentModel: "claude-opus-5-5", requestedModel: "gpt-5.6-luna", requestedOptions: null }))
      .toEqual({ model: "gpt-5.6-luna", modelOptions: null, error: null });
  });
});

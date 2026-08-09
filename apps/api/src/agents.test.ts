import { describe, expect, it } from "vitest";
import { agentDeletionBlockReason } from "./agents.js";

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

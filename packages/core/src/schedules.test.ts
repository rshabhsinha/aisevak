import { describe, expect, it } from "vitest";
import {
  buildScheduledAgentPrompt,
  extractPromptSkillNames,
  nextScheduleRunAt
} from "./schedules.js";

describe("schedule helpers", () => {
  it("extracts unique skill references from a prompt", () => {
    expect(
      extractPromptSkillNames(
        "Use @skill(aisevak-cli) and @skill(work-next). Reuse @skill(aisevak-cli)."
      )
    ).toEqual(["aisevak-cli", "work-next"]);
  });

  it("builds a selected-agent prompt while preserving the scheduled request", () => {
    const prompt = buildScheduledAgentPrompt({
      agentName: "Reviewer",
      agentDescription: "Reviews risky changes.",
      agentInstructions: "Prioritize correctness.",
      prompt: "Review @task(TASK-12)."
    });
    expect(prompt).toContain("You are Reviewer: Reviews risky changes.");
    expect(prompt).toContain("Prioritize correctness.");
    expect(prompt).toContain("Review @task(TASK-12).");
  });

  it("moves delayed intervals forward from now instead of replaying missed runs", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    expect(nextScheduleRunAt(new Date("2026-08-09T10:00:00.000Z"), 3600, now).toISOString()).toBe(
      "2026-08-09T13:00:00.000Z"
    );
  });
});

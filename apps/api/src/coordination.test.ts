import { describe, expect, it } from "vitest";
import { assertThreadCanFinalize, coordinationPrompt } from "./coordination.js";

const thread = {
  number: 12,
  title: "Review parser",
  description: "Focused review",
  purpose: "Check the parser change.",
  status: "active",
  primary_agent_id: "child-agent",
  primary_agent_name: "Reviewer",
  callback_agent_name: "Builder",
  created_by_agent_name: "Builder",
  completion_instructions: "aisevak threads complete THREAD-12 --summary-stdin",
  origin_thread_id: null
};

const recipient = { name: "Reviewer", description: "Reviews changes." };

describe("coordination delivery prompts", () => {
  it("asks a triggered agent to send one final response", () => {
    const prompt = coordinationPrompt(thread, recipient, {
      message_type: "handoff",
      sender_agent_name: "Builder",
      body: "Review this parser."
    }, []);

    expect(prompt).toContain("Completion instruction: aisevak threads complete THREAD-12 --summary-stdin");
    expect(prompt).toContain("send the completed work back to the triggering agent");
    expect(prompt).toContain("Triggered agent: Reviewer");
    expect(prompt).toContain("Result recipient: Builder");
  });

  it.each(["completion", "blocked"])("treats %s as a result notification", (messageType) => {
    const prompt = coordinationPrompt(thread, { name: "Builder", description: "Implements changes." }, {
      message_type: messageType,
      sender_agent_name: "Reviewer",
      body: "Final result from Reviewer."
    }, []);

    expect(prompt).toContain(`This is a final ${messageType} response from the agent you triggered.`);
    expect(prompt).toContain("Do not complete or block THREAD-12");
    expect(prompt).toContain("aisevak threads send THREAD-12 --body-stdin");
    expect(prompt).not.toContain("Completion instruction:");
  });
});

describe("thread finalization policy", () => {
  it("allows the triggered agent to finalize an active thread", () => {
    expect(() => assertThreadCanFinalize(thread, "child-agent")).not.toThrow();
  });

  it("rejects finalization by the triggering agent", () => {
    expect(() => assertThreadCanFinalize(thread, "parent-agent")).toThrowError(
      /Only the agent triggered on THREAD-12/
    );
  });

  it.each(["completed", "blocked"])("rejects another finalization after the thread is %s", (status) => {
    expect(() => assertThreadCanFinalize({ ...thread, status }, "child-agent")).toThrowError(
      new RegExp(`THREAD-12 is already ${status}`)
    );
  });
});

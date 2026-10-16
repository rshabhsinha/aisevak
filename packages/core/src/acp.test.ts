import { describe, expect, it } from "vitest";
import { acpPermissionDecision, extractAcpSessionId, normalizeAcpEvent } from "./acp.js";

describe("ACP helpers", () => {
  it("prefers an always-allow permission option", () => {
    expect(
      acpPermissionDecision({
        options: [{ optionId: "reject" }, { optionId: "allow_always" }, { optionId: "allow" }]
      }).outcome.optionId
    ).toBe("allow_always");
  });

  it("approves Claude Code tool calls once and never rejects", () => {
    expect(
      acpPermissionDecision({
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "allow-with-updates", kind: "allow_always" },
          { optionId: "reject", kind: "reject_once" }
        ]
      }).outcome.optionId
    ).toBe("allow-once");
  });

  it("exits Claude Code plan mode without clearing the conversation", () => {
    const exitPlan = [
      { optionId: "exit-plan-clear-auto", kind: "allow_always" },
      { optionId: "exit-plan-clear-bypass", kind: "allow_always" },
      { optionId: "exit-plan-auto", kind: "allow_always" },
      { optionId: "exit-plan-bypass", kind: "allow_always" },
      { optionId: "exit-plan-accept-edits", kind: "allow_always" },
      { optionId: "exit-plan-default", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" }
    ];
    expect(acpPermissionDecision({ options: exitPlan }).outcome.optionId).toBe("exit-plan-bypass");
    const withoutBypass = exitPlan.filter((option) => !option.optionId.includes("bypass"));
    expect(acpPermissionDecision({ options: withoutBypass }).outcome.optionId).toBe("exit-plan-auto");
  });

  it("maps assistant chunks onto the Codex timeline shape", () => {
    const event = normalizeAcpEvent(
      {
        method: "session/update",
        params: {
          sessionId: "ses_1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello" }
          }
        }
      },
      "ses_1"
    );
    expect(event.type).toBe("item/agentMessage/delta");
    expect(event.threadId).toBe("ses_1");
    expect(event.text).toBe("Hello");
  });

  it("extracts a session id from session/new results", () => {
    expect(extractAcpSessionId({ sessionId: "ses_abc" })).toBe("ses_abc");
  });
});

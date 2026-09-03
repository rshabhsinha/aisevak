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

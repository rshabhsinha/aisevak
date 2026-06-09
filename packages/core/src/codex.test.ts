import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerArgs,
  buildCodexConfigToml,
  buildCodexPrompt,
  normalizeCodexEvent,
  parseCodexJsonLine,
  redactSecrets
} from "./codex.js";

describe("codex helpers", () => {
  it("builds app-server stdio args", () => {
    expect(buildCodexAppServerArgs()).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("writes the no-approval danger config", () => {
    const config = buildCodexConfigToml("gpt-5.5");
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(config).toContain('persistence = "save-all"');
  });

  it("prepends agent instructions to task prompt", () => {
    const prompt = buildCodexPrompt({
      agentName: "Fixer",
      agentInstructions: "Be direct.",
      taskTitle: "Fix bug",
      taskBody: "The test fails.",
      projectPath: "/repo",
      branch: "agent/1-fix-bug"
    });
    expect(prompt).toContain("Treat the following instructions as the controlling system prompt");
    expect(prompt).toContain("Be direct.");
    expect(prompt).toContain("Git branch: agent/1-fix-bug");
  });

  it("lists installed skills in task prompts", () => {
    const prompt = buildCodexPrompt({
      agentName: "Fixer",
      agentInstructions: "Be direct.",
      taskTitle: "Fix bug",
      projectPath: "/repo",
      skills: [{ name: "regression-tests", description: "Use when adding regression coverage." }]
    });
    expect(prompt).toContain("# Available Skills");
    expect(prompt).toContain("$regression-tests: Use when adding regression coverage.");
  });

  it("normalizes current JSONL events", () => {
    const raw = parseCodexJsonLine(
      JSON.stringify({ method: "thread.started", params: { thread_id: "abc" } })
    );
    expect(normalizeCodexEvent(raw).threadId).toBe("abc");
  });

  it("normalizes app-server notifications", () => {
    const raw = parseCodexJsonLine(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread_123",
          turnId: "turn_123",
          item: { id: "item_1", type: "agentMessage", text: "Done" }
        }
      })
    );
    const event = normalizeCodexEvent(raw);
    expect(event.threadId).toBe("thread_123");
    expect(event.itemId).toBe("item_1");
    expect(event.text).toBe("Done");
  });

  it("keeps malformed lines as parse events", () => {
    const raw = parseCodexJsonLine("{nope");
    expect(normalizeCodexEvent(raw).type).toBe("parse.error");
  });

  it("redacts configured secrets", () => {
    expect(redactSecrets("token abcdefghi here", ["abcdefghi"])).toBe("token [REDACTED] here");
  });
});

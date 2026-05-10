import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexConfigToml,
  buildCodexPrompt,
  normalizeCodexEvent,
  parseCodexJsonLine,
  redactSecrets
} from "./codex.js";

describe("codex helpers", () => {
  it("always builds dangerous JSON exec args", () => {
    expect(buildCodexArgs({ model: "gpt-5.5" })).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-"
    ]);
  });

  it("builds resume args using the captured thread id", () => {
    expect(buildCodexArgs({ resumeThreadId: "thread_123" })).toContain("resume");
    expect(buildCodexArgs({ resumeThreadId: "thread_123" })).toContain("thread_123");
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

  it("normalizes current JSONL events", () => {
    const raw = parseCodexJsonLine(
      JSON.stringify({ method: "thread.started", params: { thread_id: "abc" } })
    );
    expect(normalizeCodexEvent(raw).threadId).toBe("abc");
  });

  it("keeps malformed lines as parse events", () => {
    const raw = parseCodexJsonLine("{nope");
    expect(normalizeCodexEvent(raw).type).toBe("parse.error");
  });

  it("redacts configured secrets", () => {
    expect(redactSecrets("token abcdefghi here", ["abcdefghi"])).toBe("token [REDACTED] here");
  });
});

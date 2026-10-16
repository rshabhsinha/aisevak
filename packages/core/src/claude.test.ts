import { describe, expect, it } from "vitest";
import {
  applyClaudeModelDefaults,
  buildClaudeAcpEnv,
  CLAUDE_HARNESS_MODELS,
  claudeConnectionTag,
  claudeCredentialEnv,
  classifyClaudeCredential,
  DEFAULT_CLAUDE_MODEL
} from "./claude.js";

const OAUTH = "sk-ant-oat01-example-token";
const API_KEY = "sk-ant-api03-example-key";

describe("Claude Code harness helpers", () => {
  it("defaults the catalog to Opus 5.5 at medium effort", () => {
    const { defaultModel, models } = applyClaudeModelDefaults();
    expect(defaultModel).toBe(DEFAULT_CLAUDE_MODEL);
    const opus = models.find((model) => model.id === "claude-opus-5-5");
    expect(opus?.badge).toBe("Default");
    const effort = opus?.options?.find((option) => option.id === "reasoningEffort");
    expect(effort?.defaultValue).toBe("medium");
    expect(effort?.values.map((value) => value.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models.filter((model) => model.badge === "Default")).toHaveLength(1);
  });

  it("never offers the Codex-only ultra effort", () => {
    for (const model of CLAUDE_HARNESS_MODELS) {
      const values = model.options?.flatMap((option) => option.values.map((value) => value.id)) ?? [];
      expect(values).not.toContain("ultra");
    }
  });

  it("classifies subscription tokens and API keys by prefix", () => {
    expect(classifyClaudeCredential(OAUTH)).toBe("oauth_token");
    expect(classifyClaudeCredential(` ${API_KEY}\n`)).toBe("api_key");
    expect(() => classifyClaudeCredential("sk-proj-openai")).toThrow(/setup-token/);
    expect(() => classifyClaudeCredential("sk-ant-oat01 extra")).toThrow(/without spaces/);
  });

  it("maps each credential kind onto the variable Claude Code reads", () => {
    expect(claudeCredentialEnv(OAUTH)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
    expect(claudeCredentialEnv(API_KEY)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
  });

  it("builds an isolated launch environment with only the stored credential", () => {
    const env = buildClaudeAcpEnv({
      baseEnv: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-api03-stale",
        ANTHROPIC_BASE_URL: "https://proxy.invalid",
        CLAUDE_CODE_USE_BEDROCK: "1"
      },
      runtimeHome: "/srv/aisevak/codex-homes/thread-1",
      credential: OAUTH,
      model: "claude-opus-5-5"
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/srv/aisevak/codex-homes/thread-1");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/srv/aisevak/codex-homes/thread-1/.claude");
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-5-5");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it("leaves the model to Claude Code for auto selections", () => {
    const env = buildClaudeAcpEnv({ baseEnv: {}, runtimeHome: "/h", credential: API_KEY, model: "auto" });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);
  });

  it("tags connections without exposing the credential", () => {
    const tag = claudeConnectionTag(OAUTH, "claude-opus-5-5");
    expect(tag).not.toContain(OAUTH);
    expect(tag).toMatch(/^claude:[0-9a-f]{16}:claude-opus-5-5$/);
    expect(claudeConnectionTag(API_KEY, "claude-opus-5-5")).not.toBe(tag);
    expect(claudeConnectionTag(OAUTH, "claude-sonnet-5-5")).not.toBe(tag);
  });
});

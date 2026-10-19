import { describe, expect, it } from "vitest";
import { isDefaultProviderInstance, newProviderInstanceId, providerInstanceSecretName } from "./providerAccounts.js";

describe("harness accounts", () => {
  it("keeps the original secret names for each harness's default account", () => {
    expect(providerInstanceSecretName("claude_code_token", "claude-local")).toBe("claude_code_token");
    expect(providerInstanceSecretName("openai_codex_auth", null)).toBe("openai_codex_auth");
    expect(providerInstanceSecretName("claude_code_token", "claude-work")).toBe("claude_code_token@claude-work");
    expect(isDefaultProviderInstance("cursor-local")).toBe(true);
    expect(isDefaultProviderInstance("cursor-team")).toBe(false);
  });

  it("derives unique account ids that never collide with the default", () => {
    expect(newProviderInstanceId("claude", "Work Account!", [])).toBe("claude-work-account");
    expect(newProviderInstanceId("claude", "Work", ["claude-work"])).toBe("claude-work-2");
    expect(newProviderInstanceId("codex", "local", [])).toBe("codex-account");
    expect(newProviderInstanceId("devin", "   ", [])).toBe("devin-account");
  });
});

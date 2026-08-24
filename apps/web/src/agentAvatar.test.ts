import { describe, expect, it } from "vitest";
import { agentAvatarSeed } from "./agentAvatar.js";

describe("agentAvatarSeed", () => {
  it("uses the durable agent id when one exists", () => {
    expect(agentAvatarSeed(" agent-123 ", "Renamed agent")).toBe("agent-123");
  });

  it("uses the draft name before a new agent has an id", () => {
    expect(agentAvatarSeed("", " New Agent ")).toBe("New Agent");
  });

  it("always has a deterministic fallback for an empty draft", () => {
    expect(agentAvatarSeed("", "")).toBe("new-agent");
  });

  it("does not change when an existing agent is renamed", () => {
    expect(agentAvatarSeed("agent-123", "First name")).toBe(
      agentAvatarSeed("agent-123", "Second name")
    );
  });
});

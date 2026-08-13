import { describe, expect, it } from "vitest";
import { describeAgentAvatar } from "./agentAvatar.js";

describe("describeAgentAvatar", () => {
  it("keeps an agent profile picture stable", () => {
    expect(describeAgentAvatar("19e42bed-9f15-4054-9198-5df7f59f1cee")).toEqual(
      describeAgentAvatar("19e42bed-9f15-4054-9198-5df7f59f1cee")
    );
  });

  it("gives different agents unique profile pictures", () => {
    const agentIds = [
      "19e42bed-9f15-4054-9198-5df7f59f1cee",
      "2655765f-5178-4cb5-8c35-a0b683f022b1",
      "ce7bc614-0f95-444c-b411-f1f7cf223926",
      "ed2a9e68-dc98-46c8-9773-0f53756129d4"
    ];
    const pictures = agentIds.map((agentId) => JSON.stringify(describeAgentAvatar(agentId)));

    expect(new Set(pictures).size).toBe(agentIds.length);
  });

  it("stays sparse and ExtraChess-sized", () => {
    const avatar = describeAgentAvatar("19e42bed-9f15-4054-9198-5df7f59f1cee");

    expect(avatar.size).toBe(5);
    expect(avatar.cells.length).toBeGreaterThanOrEqual(5);
    expect(avatar.cells.length).toBeLessThanOrEqual(11);
  });

  it("does not collide for ids that shared the old lossy hash", () => {
    const first = describeAgentAvatar("00000000-0000-4000-8000-000000001902");
    const second = describeAgentAvatar("00000000-0000-4000-8000-000000002356");

    expect(first).not.toEqual(second);
    expect(first.size).toBe(5);
    expect(second.size).toBe(5);
  });

  it("mixes the complete UUID into each persisted picture", () => {
    const base = "00112233-4455-4677-8899-aabbccddeeff";
    const pictures = Array.from({ length: 32 }, (_, nibbleIndex) => {
      const normalized = base.replace(/-/g, "");
      const replacement = normalized[nibbleIndex] === "f" ? "e" : "f";
      const changed = `${normalized.slice(0, nibbleIndex)}${replacement}${normalized.slice(nibbleIndex + 1)}`;
      return JSON.stringify(describeAgentAvatar(changed));
    });

    expect(new Set([JSON.stringify(describeAgentAvatar(base)), ...pictures]).size).toBe(33);
  });
});

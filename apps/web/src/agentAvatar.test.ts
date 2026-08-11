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
});

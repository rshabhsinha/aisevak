import { describe, expect, it } from "vitest";
import { normalizeCodexSkillSnapshots, serializeCodexSkillSnapshots } from "./skills.js";
import type { CodexSkillSnapshot } from "./types.js";

describe("skill snapshot helpers", () => {
  it("serializes empty snapshots as a JSON array", () => {
    expect(serializeCodexSkillSnapshots([])).toBe("[]");
  });

  it("normalizes old object-shaped snapshots to no skills", () => {
    expect(normalizeCodexSkillSnapshots({})).toEqual([]);
  });

  it("keeps valid skill snapshots", () => {
    const snapshot: CodexSkillSnapshot = {
      id: "skill-1",
      name: "regression-tests",
      description: "Use for regression coverage.",
      instructions: "Add focused tests.",
      files: { "notes.md": "hello" },
      sources: ["agent"]
    };

    expect(normalizeCodexSkillSnapshots([snapshot])).toEqual([snapshot]);
  });
});

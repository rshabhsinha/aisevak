import { describe, expect, it } from "vitest";
import { skillMarkdown } from "./skillMarkdown.js";

describe("skillMarkdown", () => {
  it("quotes YAML-sensitive descriptions", () => {
    const markdown = skillMarkdown({
      id: "skill-1",
      name: "release-helper",
      description: 'Use this skill: when shipping "carefully".',
      instructions: "Follow the release checklist.",
      files: {},
      sources: ["agent"]
    });

    expect(markdown).toContain('description: "Use this skill: when shipping \\"carefully\\"."');
  });
});

import { describe, expect, it } from "vitest";
import { bundledSkillsRoot, loadBundledSkills } from "./bundledSkills.js";

describe("bundled skills", () => {
  it("loads the default Aisevak CLI skill and its lazy reference", async () => {
    const skills = await loadBundledSkills();

    expect(bundledSkillsRoot()).toMatch(/packages\/core\/bundled-skills\/?$/);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "aisevak-cli",
      defaultForAgents: true
    });
    expect(skills[0]?.description).toContain("coordinate through durable threads");
    expect(skills[0]?.instructions).toContain("Do not call the CLI on every turn");
    expect(skills[0]?.files["agents/openai.yaml"]).toContain("$aisevak-cli");
    expect(skills[0]?.files["references/commands.md"]).toContain("aisevak threads create");
  });
});

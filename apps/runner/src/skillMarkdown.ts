import type { CodexSkillSnapshot } from "@aisevak/core";

export function skillMarkdown(skill: CodexSkillSnapshot): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    skill.instructions.trim(),
    ""
  ].join("\n");
}

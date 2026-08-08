import type { CodexSkillSnapshot } from "./types.js";

export function serializeCodexSkillSnapshots(skills: CodexSkillSnapshot[]): string {
  return JSON.stringify(skills);
}

export function normalizeCodexSkillSnapshots(value: unknown): CodexSkillSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((skill) => {
    if (!isRecord(skill) || typeof skill.name !== "string") return [];
    return [
      {
        id: typeof skill.id === "string" ? skill.id : "",
        name: skill.name,
        description: typeof skill.description === "string" ? skill.description : "",
        instructions: typeof skill.instructions === "string" ? skill.instructions : "",
        files: normalizeStringRecord(skill.files),
        sources: Array.isArray(skill.sources) ? skill.sources.filter((source) => typeof source === "string") : []
      }
    ];
  });
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

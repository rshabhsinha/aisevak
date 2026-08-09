import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface BundledSkillDefinition {
  name: string;
  description: string;
  instructions: string;
  files: Record<string, string>;
  defaultForAgents: boolean;
}

const manifests = [
  {
    directory: "aisevak-cli",
    files: ["agents/openai.yaml", "references/commands.md"],
    defaultForAgents: true
  }
] as const;

export async function loadBundledSkills(): Promise<BundledSkillDefinition[]> {
  return Promise.all(
    manifests.map(async (manifest) => {
      const skillUrl = new URL(`../bundled-skills/${manifest.directory}/`, import.meta.url);
      const markdown = await readFile(new URL("SKILL.md", skillUrl), "utf8");
      const parsed = parseSkillMarkdown(markdown);
      if (parsed.name !== manifest.directory) {
        throw new Error(`Bundled skill directory ${manifest.directory} does not match skill name ${parsed.name}`);
      }
      const files = Object.fromEntries(
        await Promise.all(
          manifest.files.map(async (relativePath) => [
            relativePath,
            await readFile(new URL(relativePath, skillUrl), "utf8")
          ] as const)
        )
      );
      return { ...parsed, files, defaultForAgents: manifest.defaultForAgents };
    })
  );
}

function parseSkillMarkdown(markdown: string): Omit<BundledSkillDefinition, "files" | "defaultForAgents"> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Bundled SKILL.md must contain YAML frontmatter");
  const frontmatter = match[1] ?? "";
  const instructions = (match[2] ?? "").trim();
  const name = frontmatterField(frontmatter, "name");
  const description = frontmatterField(frontmatter, "description");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid bundled skill name: ${name}`);
  if (!instructions) throw new Error(`Bundled skill ${name} has no instructions`);
  return { name, description, instructions };
}

function frontmatterField(frontmatter: string, field: string): string {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  const value = match?.[1]?.trim();
  if (!value) throw new Error(`Bundled SKILL.md is missing ${field}`);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  return value;
}

export function bundledSkillsRoot(): string {
  return fileURLToPath(new URL("../bundled-skills/", import.meta.url));
}

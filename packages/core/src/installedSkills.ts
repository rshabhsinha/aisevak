import { chmod, chown, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { parse as parseYaml } from "yaml";

export interface InstalledSkillDefinition {
  name: string;
  description: string;
  instructions: string;
  files: Record<string, string>;
  platformManaged: boolean;
  defaultForAgents: boolean;
}

export interface InstalledSkillScan {
  skills: InstalledSkillDefinition[];
  presentNames: string[];
  errors: Array<{ directory: string; message: string }>;
}

const platformManifests = [
  {
    directory: "aisevak-cli",
    files: ["agents/openai.yaml", "references/commands.md"],
    defaultForAgents: true
  }
] as const;

const catalogMigration = "20260809_installed_skills_catalog";
const skillNamePattern = /^[a-z0-9][a-z0-9._-]*$/;

export function installedSkillsRoot(managedRoot = process.env.MANAGED_ROOT ?? "/srv/aisevak"): string {
  return resolve(managedRoot, "skills");
}

export function platformSkillsSourceRoot(): string {
  return fileURLToPath(new URL("../platform-skills/", import.meta.url));
}

export async function loadPlatformSkills(): Promise<InstalledSkillDefinition[]> {
  return Promise.all(
    platformManifests.map(async (manifest) => {
      const skillUrl = new URL(`../platform-skills/${manifest.directory}/`, import.meta.url);
      const markdown = await readFile(new URL("SKILL.md", skillUrl), "utf8");
      const parsed = parseSkillMarkdown(markdown);
      if (parsed.name !== manifest.directory) {
        throw new Error(`Platform skill directory ${manifest.directory} does not match skill name ${parsed.name}`);
      }
      const files = Object.fromEntries(
        await Promise.all(
          manifest.files.map(async (relativePath) => [
            relativePath,
            await readFile(new URL(relativePath, skillUrl), "utf8")
          ] as const)
        )
      );
      return {
        ...parsed,
        files,
        platformManaged: true,
        defaultForAgents: manifest.defaultForAgents
      };
    })
  );
}

export async function ensurePlatformSkillsInstalled(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const skill of await loadPlatformSkills()) {
    await writeInstalledSkill(root, skill, { overwrite: true });
  }
}

export async function scanInstalledSkills(root: string): Promise<InstalledSkillScan> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const platformByName = new Map((await loadPlatformSkills()).map((skill) => [skill.name, skill]));
  const skills: InstalledSkillDefinition[] = [];
  const presentNames: string[] = [];
  const errors: InstalledSkillScan["errors"] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !skillNamePattern.test(entry.name)) continue;
    presentNames.push(entry.name);
    try {
      const skillDirectory = join(root, entry.name);
      const markdown = await readFile(join(skillDirectory, "SKILL.md"), "utf8");
      const parsed = parseSkillMarkdown(markdown);
      if (parsed.name !== entry.name) {
        throw new Error(`Directory name ${entry.name} does not match skill name ${parsed.name}`);
      }
      const platform = platformByName.get(parsed.name);
      skills.push({
        ...parsed,
        files: await readSkillFiles(skillDirectory),
        platformManaged: Boolean(platform),
        defaultForAgents: platform?.defaultForAgents ?? false
      });
    } catch (error) {
      errors.push({
        directory: entry.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { skills, presentNames, errors };
}

export async function writeInstalledSkill(
  root: string,
  skill: Pick<InstalledSkillDefinition, "name" | "description" | "instructions" | "files">,
  options: { overwrite?: boolean } = {}
): Promise<void> {
  validateSkillName(skill.name);
  const filePaths = Object.keys(skill.files);
  for (const relativePath of filePaths) validateSkillFilePath(relativePath);

  const skillDirectory = join(root, skill.name);
  await ensureSafeDirectory(root, []);
  const exists = await pathExists(skillDirectory);
  if (exists && !options.overwrite) {
    throw new Error(`Installed skill directory already exists: ${skillDirectory}`);
  }
  await ensureSafeDirectory(root, [skill.name]);

  const expectedFiles = new Set(["SKILL.md", ...filePaths]);
  if (options.overwrite) await removeUnexpectedFiles(skillDirectory, expectedFiles);

  for (const [relativePath, content] of Object.entries(skill.files)) {
    const parts = relativePath.split("/");
    await ensureSafeDirectory(skillDirectory, parts.slice(0, -1));
    await assertSafeFile(join(skillDirectory, ...parts));
    await writeFile(join(skillDirectory, ...parts), content, "utf8");
    await inheritOwnership(join(skillDirectory, ...parts), skillDirectory);
    await chmod(join(skillDirectory, ...parts), 0o664);
  }
  await assertSafeFile(join(skillDirectory, "SKILL.md"));
  await writeFile(join(skillDirectory, "SKILL.md"), skillMarkdown(skill), "utf8");
  await inheritOwnership(join(skillDirectory, "SKILL.md"), skillDirectory);
  await chmod(join(skillDirectory, "SKILL.md"), 0o664);
}

export async function removeInstalledSkill(root: string, name: string): Promise<void> {
  validateSkillName(name);
  const skillDirectory = join(root, name);
  const info = await lstat(skillDirectory).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error(`Refusing to remove symbolic link skill directory: ${skillDirectory}`);
  if (info) await rm(skillDirectory, { recursive: true, force: true });
}

export async function synchronizeInstalledSkills(pool: Pool, root: string): Promise<InstalledSkillScan> {
  await ensurePlatformSkillsInstalled(root);
  const scan = await scanInstalledSkills(root);
  for (const skill of scan.skills) {
    await pool.query(
      `INSERT INTO skills
         (name, description, instructions, files, enabled, platform_managed, default_for_agents)
       VALUES ($1, $2, $3, $4, true, $5, $6)
       ON CONFLICT (name) DO UPDATE
       SET description = EXCLUDED.description,
           instructions = EXCLUDED.instructions,
           files = EXCLUDED.files,
           platform_managed = EXCLUDED.platform_managed,
           default_for_agents = CASE
             WHEN EXCLUDED.platform_managed THEN EXCLUDED.default_for_agents
             ELSE skills.default_for_agents
           END,
           updated_at = CASE
             WHEN (skills.description, skills.instructions, skills.files, skills.platform_managed)
               IS DISTINCT FROM
                  (EXCLUDED.description, EXCLUDED.instructions, EXCLUDED.files, EXCLUDED.platform_managed)
             THEN now()
             ELSE skills.updated_at
           END`,
      [
        skill.name,
        skill.description,
        skill.instructions,
        JSON.stringify(skill.files),
        skill.platformManaged,
        skill.defaultForAgents
      ]
    );
  }

  const userPresentNames = scan.presentNames.filter(
    (name) => !scan.skills.some((skill) => skill.name === name && skill.platformManaged)
  );
  const existingUserSkills = await pool.query<{ name: string }>(
    "SELECT name FROM skills WHERE platform_managed = false ORDER BY name"
  );
  if (userPresentNames.length === 0 && existingUserSkills.rows.length > 0) {
    scan.errors.push({
      directory: "(catalog)",
      message: "Only platform skills were found; existing installed skills were preserved in case the skills directory is unavailable"
    });
    return scan;
  }

  await pool.query(
    `UPDATE skills
     SET enabled = false,
         updated_at = now()
     WHERE platform_managed = false
       AND enabled = true
       AND name ~ '^[a-z0-9][a-z0-9._-]*$'
       AND NOT (name = ANY($1::text[]))`,
    [userPresentNames]
  );
  return scan;
}

export async function migrateAndSynchronizeInstalledSkills(pool: Pool, root: string): Promise<InstalledSkillScan> {
  await mkdir(root, { recursive: true });
  const applied = await pool.query("SELECT 1 FROM app_migrations WHERE name = $1", [catalogMigration]);
  if (!applied.rows[0]) {
    const existing = await pool.query<{
      name: string;
      description: string;
      instructions: string;
      files: Record<string, string> | null;
    }>("SELECT name, description, instructions, files FROM skills ORDER BY name");
    for (const row of existing.rows) {
      if (!skillNamePattern.test(row.name) || await pathExists(join(root, row.name))) continue;
      await writeInstalledSkill(root, {
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        files: normalizeFiles(row.files)
      });
    }
    await pool.query("INSERT INTO app_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [catalogMigration]);
  }

  return synchronizeInstalledSkills(pool, root);
}

export function skillMarkdown(
  skill: Pick<InstalledSkillDefinition, "name" | "description" | "instructions">
): string {
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

export function parseSkillMarkdown(
  markdown: string
): Pick<InstalledSkillDefinition, "name" | "description" | "instructions"> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter");
  const frontmatter = match[1] ?? "";
  const instructions = (match[2] ?? "").trim();
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter);
  } catch (error) {
    throw new Error(`SKILL.md contains invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }
  const name = frontmatterField(metadata as Record<string, unknown>, "name");
  const description = frontmatterField(metadata as Record<string, unknown>, "description");
  validateSkillName(name);
  if (!instructions) throw new Error(`Installed skill ${name} has no instructions`);
  return { name, description, instructions };
}

function frontmatterField(frontmatter: Record<string, unknown>, field: string): string {
  const value = frontmatter[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`SKILL.md is missing ${field}`);
  return value.trim();
}

async function readSkillFiles(skillDirectory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in installed skills: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath);
      } else if (entry.isFile() && relativePath !== "SKILL.md") {
        validateSkillFilePath(relativePath);
        const content = await readFile(join(directory, entry.name), "utf8");
        if (content.includes("\0")) throw new Error(`Installed skill file must contain text: ${relativePath}`);
        files[relativePath] = content;
      }
    }
  }
  await visit(skillDirectory, "");
  return files;
}

async function removeUnexpectedFiles(directory: string, expectedFiles: Set<string>, prefix = ""): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in installed skills: ${relativePath}`);
    if (entry.isDirectory()) {
      await removeUnexpectedFiles(path, expectedFiles, relativePath);
      if ((await readdir(path)).length === 0) await rm(path, { recursive: false });
    } else if (entry.isFile() && !expectedFiles.has(relativePath)) {
      await rm(path);
    }
  }
}

async function ensureSafeDirectory(root: string, parts: string[]): Promise<void> {
  let current = root;
  await mkdir(current, { recursive: true });
  await assertDirectory(current);
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\")) {
      throw new Error(`Invalid installed skill path component: ${part}`);
    }
    const parent = current;
    current = join(parent, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await assertDirectory(current);
    await inheritOwnership(current, parent);
    await chmod(current, 0o775);
  }
}

async function inheritOwnership(path: string, parent: string): Promise<void> {
  const owner = await lstat(parent);
  await chown(path, owner.uid, owner.gid);
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Installed skill path is not a safe directory: ${path}`);
  }
}

async function assertSafeFile(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new Error(`Installed skill path is not a safe file: ${path}`);
  }
}

function validateSkillName(name: string): void {
  if (!skillNamePattern.test(name)) throw new Error(`Invalid installed skill name: ${name}`);
}

function validateSkillFilePath(relativePath: string): void {
  const parts = relativePath.split("/");
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath === "SKILL.md" ||
    relativePath.endsWith("/SKILL.md") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid installed skill file path: ${relativePath}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null));
}

function normalizeFiles(value: Record<string, string> | null): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === "string"));
}

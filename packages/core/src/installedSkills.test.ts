import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePlatformSkillsInstalled,
  installedSkillsRoot,
  loadPlatformSkills,
  platformSkillsSourceRoot,
  scanInstalledSkills,
  synchronizeInstalledSkills,
  writeInstalledSkill
} from "./installedSkills.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installed skills", () => {
  it("loads the release-provided Aisevak CLI skill", async () => {
    const skills = await loadPlatformSkills();

    expect(platformSkillsSourceRoot()).toMatch(/packages\/core\/platform-skills\/?$/);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "aisevak-cli",
      platformManaged: true,
      defaultForAgents: true
    });
    expect(skills[0]?.description).toContain("coordinate through durable threads");
    expect(skills[0]?.instructions).toContain("Do not call the CLI on every turn");
    expect(skills[0]?.files["agents/openai.yaml"]).toContain("$aisevak-cli");
    expect(skills[0]?.files["references/commands.md"]).toContain("aisevak threads create");
  });

  it("uses a persistent skills directory below the managed root", () => {
    expect(installedSkillsRoot("/srv/aisevak")).toBe("/srv/aisevak/skills");
  });

  it("scans skills created directly in the installed catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
    cleanup.push(root);
    await writeInstalledSkill(root, {
      name: "background-terminals",
      description: "Use for persistent background commands.",
      instructions: "Run long-lived commands in detached tmux sessions.",
      files: { "references/tmux.md": "Use a named session." }
    });

    const scan = await scanInstalledSkills(root);

    expect(scan.errors).toEqual([]);
    expect(scan.presentNames).toEqual(["background-terminals"]);
    expect(scan.skills[0]).toMatchObject({
      name: "background-terminals",
      platformManaged: false,
      defaultForAgents: false
    });
    expect(scan.skills[0]?.files).toEqual({ "references/tmux.md": "Use a named session." });
  });

  it.each(["../notes", "SKILL.md"])(
    "rejects invalid supporting path %s before creating the skill directory",
    async (relativePath) => {
      const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
      cleanup.push(root);

      await expect(writeInstalledSkill(root, {
        name: "background-terminals",
        description: "Use for persistent background commands.",
        instructions: "Run long-lived commands in detached tmux sessions.",
        files: { [relativePath]: "invalid" }
      })).rejects.toThrow(`Invalid installed skill file path: ${relativePath}`);

      await expect(lstat(join(root, "background-terminals"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("keeps an incomplete directory present without treating it as a valid skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
    cleanup.push(root);
    await mkdir(join(root, "being-created"));
    await writeFile(join(root, "being-created", "notes.md"), "not ready", "utf8");

    const scan = await scanInstalledSkills(root);

    expect(scan.presentNames).toEqual(["being-created"]);
    expect(scan.skills).toEqual([]);
    expect(scan.errors[0]?.directory).toBe("being-created");
  });

  it("parses folded YAML block descriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
    cleanup.push(root);
    await mkdir(join(root, "background-terminals"));
    await writeFile(
      join(root, "background-terminals", "SKILL.md"),
      [
        "---",
        "name: background-terminals",
        "description: >-",
        "  Keep commands running between",
        "  agent turns.",
        "---",
        "",
        "Use a detached terminal session.",
        ""
      ].join("\n"),
      "utf8"
    );

    const scan = await scanInstalledSkills(root);

    expect(scan.errors).toEqual([]);
    expect(scan.skills[0]?.description).toBe("Keep commands running between agent turns.");
  });

  it("preserves database skills when only the platform catalog is visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
    cleanup.push(root);
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("SELECT name FROM skills")) return { rows: [{ name: "background-terminals" }] };
        return { rows: [] };
      }
    } as unknown as Pool;

    const scan = await synchronizeInstalledSkills(pool, root);

    expect(scan.errors.at(-1)?.directory).toBe("(catalog)");
    expect(queries.some((query) => query.sql.includes("DELETE FROM skills"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("SET enabled = false"))).toBe(false);
  });

  it("soft-disables missing installed skills without deleting assignments", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
    cleanup.push(root);
    await writeInstalledSkill(root, {
      name: "available-skill",
      description: "Still installed.",
      instructions: "Use this skill.",
      files: {}
    });
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("SELECT name FROM skills")) {
          return { rows: [{ name: "available-skill" }, { name: "missing-skill" }, { name: "Legacy Skill" }] };
        }
        return { rows: [] };
      }
    } as unknown as Pool;

    await synchronizeInstalledSkills(pool, root);

    const reconciliation = queries.find((query) => query.sql.includes("SET enabled = false"));
    expect(reconciliation?.sql).not.toContain("DELETE FROM skills");
    expect(reconciliation?.sql).toContain("name ~ '^[a-z0-9][a-z0-9._-]*$'");
    expect(reconciliation?.params).toEqual([["available-skill"]]);
  });

  it("installs platform skills into the same catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
    cleanup.push(root);

    await ensurePlatformSkillsInstalled(root);

    expect(await readFile(join(root, "aisevak-cli", "SKILL.md"), "utf8")).toContain("# Aisevak CLI");
    const scan = await scanInstalledSkills(root);
    expect(scan.skills[0]).toMatchObject({ name: "aisevak-cli", platformManaged: true });
  });
});

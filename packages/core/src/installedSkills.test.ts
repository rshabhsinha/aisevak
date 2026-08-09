import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePlatformSkillsInstalled,
  installedSkillsRoot,
  loadPlatformSkills,
  platformSkillsSourceRoot,
  scanInstalledSkills,
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

  it("installs platform skills into the same catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-installed-skills-"));
    cleanup.push(root);

    await ensurePlatformSkillsInstalled(root);

    expect(await readFile(join(root, "aisevak-cli", "SKILL.md"), "utf8")).toContain("# Aisevak CLI");
    const scan = await scanInstalledSkills(root);
    expect(scan.skills[0]).toMatchObject({ name: "aisevak-cli", platformManaged: true });
  });
});

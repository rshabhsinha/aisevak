import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBundledSkills } from "@aisevak/core";
import { materializeSkills } from "./index.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("skill materialization", () => {
  it("installs the bundled Aisevak CLI skill into an isolated Codex home", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "aisevak-skill-home-"));
    cleanup.push(codexHome);
    const [skill] = await loadBundledSkills();
    if (!skill) throw new Error("Expected bundled Aisevak CLI skill");

    await materializeSkills(codexHome, [{
      id: "bundled-aisevak-cli",
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      files: skill.files,
      sources: ["default"]
    }]);

    const root = join(codexHome, ".agents", "skills", "aisevak-cli");
    expect(await readFile(join(root, "SKILL.md"), "utf8")).toContain("# Aisevak CLI");
    expect(await readFile(join(root, "references", "commands.md"), "utf8")).toContain("aisevak tasks create");
    expect(await readFile(join(root, "agents", "openai.yaml"), "utf8")).toContain("$aisevak-cli");
  });
});

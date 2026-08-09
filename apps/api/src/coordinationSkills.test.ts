import type { DbPool } from "@aisevak/core";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerCoordinationRoutes } from "./coordination.js";

const cleanup: string[] = [];
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function orchestratorPool(): DbPool {
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM agent_tool_tokens")) {
        return {
          rows: [{
            agent_id: "11111111-1111-4111-8111-111111111111",
            agent_thread_id: "22222222-2222-4222-8222-222222222222",
            coordination_thread_id: null,
            task_id: null,
            task_project_id: null,
            role: "dispatcher",
            kind: "dispatcher",
            name: "Orchestrator",
            description: "Coordinates work",
            capabilities: []
          }]
        };
      }
      if (sql.includes("SELECT name FROM skills WHERE platform_managed = false")) return { rows: [] };
      if (sql.includes("FROM skills WHERE name = $1")) {
        return {
          rows: [{
            id: "33333333-3333-4333-8333-333333333333",
            name: params?.[0],
            description: "Keep commands alive safely.",
            instructions: "# Background terminals",
            files: {},
            enabled: true,
            platform_managed: false,
            default_for_agents: false
          }]
        };
      }
      if (sql.includes("INSERT INTO skills") || sql.includes("UPDATE skills")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  } as unknown as DbPool;
}

async function coordinationApp(managedRoot: string): Promise<FastifyInstance> {
  const app = Fastify();
  openApps.push(app);
  await registerCoordinationRoutes(app, orchestratorPool(), { managedRoot });
  return app;
}

describe("agent skill publication", () => {
  it("lets the Orchestrator publish through the API without exposing the catalog path", async () => {
    const managedRoot = await mkdtemp(join(tmpdir(), "aisevak-coordination-skills-"));
    cleanup.push(managedRoot);
    const app = await coordinationApp(managedRoot);

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-tools/v1/skills",
      headers: { authorization: "Bearer orchestrator-token" },
      payload: {
        markdown: "---\nname: background-terminals\ndescription: Keep commands alive safely.\n---\n\n# Background terminals\n",
        files: { "references/tmux.md": "Use a detached tmux session.\n" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ skill: { key: "SKILL-background-terminals" } });
    expect(await readFile(join(managedRoot, "skills", "background-terminals", "SKILL.md"), "utf8"))
      .toContain("name: background-terminals");
  });

  it("rejects a NUL-containing API path without leaving a skill directory", async () => {
    const managedRoot = await mkdtemp(join(tmpdir(), "aisevak-coordination-skills-"));
    cleanup.push(managedRoot);
    const app = await coordinationApp(managedRoot);

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-tools/v1/skills",
      headers: { authorization: "Bearer orchestrator-token" },
      payload: {
        markdown: "---\nname: background-terminals\ndescription: Keep commands alive safely.\n---\n\n# Background terminals\n",
        files: { "references/notes\0.md": "invalid" }
      }
    });

    expect(response.statusCode).toBe(400);
    await expect(lstat(join(managedRoot, "skills", "background-terminals")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

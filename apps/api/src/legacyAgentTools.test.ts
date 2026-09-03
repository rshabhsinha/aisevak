import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function serverForCapabilities(capabilities: string[]): Promise<{ app: FastifyInstance; secretQueries: string[] }> {
  const secretQueries: string[] = [];
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM api_keys")) return { rows: [] };
      if (sql.includes("FROM agent_tool_tokens")) {
        return {
          rows: [{
            agent_id: "11111111-1111-4111-8111-111111111111",
            agent_thread_id: null,
            coordination_thread_id: null,
            task_id: null,
            task_project_id: null,
            role: "worker",
            kind: "worker",
            name: "Restricted worker",
            description: "Tests capability boundaries",
            capabilities
          }]
        };
      }
      if (sql.includes("FROM secrets") || sql.includes("INTO secrets")) {
        secretQueries.push(sql);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  } as unknown as DbPool;
  const app = await buildServer(pool);
  openApps.push(app);
  return { app, secretQueries };
}

describe("legacy agent-tool capability checks", () => {
  it("blocks credential reads without credentials:read", async () => {
    const { app, secretQueries } = await serverForCapabilities(["tasks:read"]);
    const response = await app.inject({
      method: "GET",
      url: "/api/agent-tools/credentials",
      headers: { authorization: "Bearer restricted-token" }
    });

    expect(response.statusCode).toBe(403);
    expect(secretQueries).toHaveLength(0);
  });

  it("blocks credential writes when an agent has read-only credential access", async () => {
    const { app, secretQueries } = await serverForCapabilities(["credentials:read"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-tools/credentials",
      headers: { authorization: "Bearer restricted-token" },
      payload: { name: "blocked", value: "must-not-be-stored" }
    });

    expect(response.statusCode).toBe(403);
    expect(secretQueries).toHaveLength(0);
  });

  it("allows credential metadata reads with credentials:read", async () => {
    const { app, secretQueries } = await serverForCapabilities(["credentials:read"]);
    const response = await app.inject({
      method: "GET",
      url: "/api/agent-tools/credentials",
      headers: { authorization: "Bearer restricted-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ credentials: [] });
    expect(secretQueries).toHaveLength(1);
  });

  it("blocks installed-skill publication without skills:write", async () => {
    const { app } = await serverForCapabilities(["skills:read"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-tools/v1/skills",
      headers: { authorization: "Bearer restricted-token" },
      payload: {
        markdown: "---\nname: unsafe\ndescription: Unsafe shared write.\n---\n\n# Unsafe\n",
        files: {}
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("does not let a stored legacy threads:create capability create detached threads", async () => {
    const { app } = await serverForCapabilities(["threads:create"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-tools/v1/threads",
      headers: { authorization: "Bearer restricted-token" },
      payload: {
        title: "Detached",
        description: "Should be rejected",
        purpose: "No unkeyed coordination",
        to: "11111111-1111-4111-8111-111111111111",
        workKey: "detached-v1"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("threads:create-detached");
  });

  it("requires a new keyed task capability even when old tasks:create is stored", async () => {
    const { app } = await serverForCapabilities(["tasks:create"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-tools/v1/tasks",
      headers: { authorization: "Bearer restricted-token" },
      payload: {
        title: "Unsafe root",
        body: "Should be rejected",
        workKey: "unsafe-root-v1"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("tasks:create-root");
  });
});

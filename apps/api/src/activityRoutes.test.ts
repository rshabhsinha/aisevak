import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function activityServer(): Promise<{ app: FastifyInstance; queries: string[]; parameters: unknown[][] }> {
  const queries: string[] = [];
  const parameters: unknown[][] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      parameters.push(params);
      if (sql.includes("FROM sessions")) {
        return {
          rows: [{
            id: "11111111-1111-4111-8111-111111111111",
            email: "owner@example.com",
            name: "Owner",
            role: "owner"
          }]
        };
      }
      if (sql.includes("FROM api_keys")) return { rows: [] };
      if (sql.includes("FROM agent_tool_tokens")) return { rows: [{ agent_id: "agent", kind: "worker", role: "worker", name: "Builder", capabilities: ["incidents:read"] }] };
      if (sql.includes("FROM reports")) {
        return { rows: [{ number: 7, title: "Daily review", markdown: "## Healthy" }] };
      }
      if (sql.includes("FROM incidents")) {
        return { rows: [{ number: 3, title: "Queue stalled", markdown: "## Investigating" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  } as unknown as DbPool;
  const app = await buildServer(pool);
  openApps.push(app);
  return { app, queries, parameters };
}

describe("web activity routes", () => {
  it("returns current CLI report revisions to signed-in users", async () => {
    const { app, queries } = await activityServer();
    const response = await app.inject({
      method: "GET",
      url: "/api/reports",
      headers: { cookie: "aisevak_session=test-session" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      reports: [{ number: 7, title: "Daily review", markdown: "## Healthy" }],
      nextCursor: null,
      hasMore: false
    });
    expect(queries.some((sql) => sql.includes("report_versions.revision = reports.current_revision"))).toBe(true);
  });

  it("returns the latest Markdown update for each incident", async () => {
    const { app, queries } = await activityServer();
    const response = await app.inject({
      method: "GET",
      url: "/api/incidents",
      headers: { cookie: "aisevak_session=test-session" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      incidents: [{ number: 3, title: "Queue stalled", markdown: "## Investigating" }],
      nextCursor: null,
      hasMore: false
    });
    expect(queries.some((sql) => sql.includes("ORDER BY incident_updates.created_at DESC"))).toBe(true);
  });

  it("does not expose reports without a user session", async () => {
    const { app } = await activityServer();
    const response = await app.inject({ method: "GET", url: "/api/reports" });
    expect(response.statusCode).toBe(401);
  });

  it("does not expose incidents without a user session", async () => {
    const { app } = await activityServer();
    const response = await app.inject({ method: "GET", url: "/api/incidents" });
    expect(response.statusCode).toBe(401);
  });
});


describe("resolved incident visibility", () => {
  it("hides resolved web incidents unless explicitly requested", async () => {
    const { app, queries } = await activityServer();
    const headers = { cookie: "aisevak_session=test-session" };
    await app.inject({ method: "GET", url: "/api/incidents", headers });
    expect(queries.at(-1)).toContain("incidents.status <> 'resolved'");
    await app.inject({ method: "GET", url: "/api/incidents?includeResolved=false", headers });
    expect(queries.at(-1)).toContain("incidents.status <> 'resolved'");
    await app.inject({ method: "GET", url: "/api/incidents?includeResolved=true", headers });
    expect(queries.at(-1)).not.toContain("incidents.status <> 'resolved'");
    await app.inject({ method: "GET", url: "/api/incidents?status=resolved", headers });
    expect(queries.at(-1)).not.toContain("incidents.status <> 'resolved'");
  });
  it("applies the same visibility policy to agent incident lists", async () => {
    const { app, queries, parameters } = await activityServer();
    await app.inject({ method: "GET", url: "/api/agent-tools/v1/incidents", headers: { authorization: "Bearer test" } });
    expect(parameters.at(-1)?.[5]).toBe(false);
    const response = await app.inject({ method: "GET", url: "/api/agent-tools/v1/incidents?includeResolved=true", headers: { authorization: "Bearer test" } });
    expect(response.statusCode).toBe(200);
    expect(parameters.at(-1)?.[5]).toBe(true);
    expect(queries.at(-1)).toContain("$6::boolean OR $1::text IS NOT NULL OR incidents.status <> 'resolved'");
  });
});

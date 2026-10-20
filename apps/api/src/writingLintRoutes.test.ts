import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

const openApps: FastifyInstance[] = [];
const headers = { authorization: "Bearer test" };

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function lintServer(reportMarkdown: string, publishMatches = true): Promise<{ app: FastifyInstance; queries: string[] }> {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM api_keys")) return { rows: [] };
      if (sql.includes("FROM agent_tool_tokens")) {
        return { rows: [{ agent_id: "agent", kind: "worker", role: "worker", name: "Builder", capabilities: ["reports:write", "incidents:write"] }] };
      }
      if (sql.startsWith("SELECT id FROM reports")) return { rows: [{ id: "report" }] };
      if (sql.startsWith("SELECT id FROM incidents")) return { rows: [{ id: "incident" }] };
      if (sql.includes("FROM reports")) {
        return { rows: [{ number: 9, current_revision: 2, title: "Daily review", description: "Scope.", markdown: reportMarkdown }] };
      }
      if (sql.includes("FROM incidents")) return { rows: [{ number: 3, title: "Queue stalled", thread_id: null }] };
      if (sql.startsWith("UPDATE reports")) return { rows: publishMatches ? [{ id: "report" }] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  } as unknown as DbPool;
  const app = await buildServer(pool);
  openApps.push(app);
  return { app, queries };
}

describe("writing lint on agent routes", () => {
  it("refuses to publish a report that breaks the writing rules", async () => {
    const { app, queries } = await lintServer(Array.from({ length: 450 }, () => "word").join(" "));
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "WRITING_LINT" });
    expect(response.json().message).toContain("REPORT-9 revision 2");
    expect(queries.some((sql) => sql.startsWith("UPDATE reports"))).toBe(false);
  });

  it("publishes a short report", async () => {
    const { app, queries } = await lintServer("All quiet. No action needed.");
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toMatchObject({ passed: true });
    expect(queries.some((sql) => sql.startsWith("UPDATE reports"))).toBe(true);
  });

  it("refuses to publish when the report was revised after linting", async () => {
    const { app, queries } = await lintServer("All quiet. No action needed.", false);
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(409);
    expect(queries.find((sql) => sql.startsWith("UPDATE reports"))).toContain("current_revision = $2");
  });

  it("rejects an incident update before recording it", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-tools/v1/incidents/INC-3/updates",
      headers,
      payload: { markdown: "Raw owner 981758a4-c188-4078-b1f3-8774a7272a46, 981758a4-c188-4078-b1f3-8774a7272a47, 981758a4-c188-4078-b1f3-8774a7272a48, 981758a4-c188-4078-b1f3-8774a7272a49." }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("INC-3 update");
    expect(queries.some((sql) => sql.includes("INSERT INTO incident_updates"))).toBe(false);
  });
});

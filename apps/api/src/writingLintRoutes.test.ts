import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

const openApps: FastifyInstance[] = [];
const headers = { authorization: "Bearer test" };
const tooLong = Array.from({ length: 450 }, () => "word").join(" ");
const rawIds = Array.from({ length: 4 }, (_, index) => `981758a4-c188-4078-b1f3-8774a7272a4${index}`).join(", ");
const originalMode = process.env.AISEVAK_WRITING_LINT;

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  if (originalMode === undefined) delete process.env.AISEVAK_WRITING_LINT;
  else process.env.AISEVAK_WRITING_LINT = originalMode;
});

async function lintServer(reportMarkdown: string, publishMatches = true): Promise<{ app: FastifyInstance; queries: string[] }> {
  const queries: string[] = [];
  async function query(sql: string) {
    queries.push(sql);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.includes("FROM api_keys")) return { rows: [] };
    if (sql.includes("FROM agent_tool_tokens")) {
      return { rows: [{ agent_id: "agent", kind: "worker", role: "worker", name: "Builder", capabilities: ["reports:write", "incidents:write"] }] };
    }
    if (sql.startsWith("SELECT id FROM reports")) return { rows: [{ id: "report" }] };
    if (sql.startsWith("SELECT id FROM incidents")) return { rows: [{ id: "incident" }] };
    if (sql.startsWith("SELECT current_revision, title, description FROM reports")) {
      return { rows: [{ current_revision: 2, title: "Daily review", description: "Scope." }] };
    }
    if (sql.includes("FROM reports")) {
      return { rows: [{ number: 9, current_revision: 2, title: "Daily review", description: "Scope.", markdown: reportMarkdown }] };
    }
    if (sql.includes("FROM incidents")) return { rows: [{ number: 3, title: "Queue stalled", thread_id: null }] };
    if (sql.startsWith("INSERT INTO report_versions")) return { rows: [] };
    if (sql.startsWith("UPDATE reports SET current_revision")) return { rows: [] };
    if (sql.startsWith("UPDATE reports")) return { rows: publishMatches ? [{ id: "report" }] : [] };
    if (sql.startsWith("UPDATE incidents")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  }
  const pool = { query, async connect() { return { query, release() {} }; } } as unknown as DbPool;
  const app = await buildServer(pool);
  openApps.push(app);
  return { app, queries };
}

const wrote = (queries: string[], prefix: string) => queries.some((sql) => sql.startsWith(prefix));

describe("writing lint on report routes", () => {
  it("refuses to publish a report that breaks the limits", async () => {
    const { app, queries } = await lintServer(tooLong);
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "WRITING_LINT" });
    expect(response.json().message).toContain("REPORT-9 revision 2");
    expect(wrote(queries, "UPDATE reports")).toBe(false);
  });

  it("publishes a short report", async () => {
    const { app, queries } = await lintServer("All quiet. No action needed.");
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toMatchObject({ passed: true });
    expect(wrote(queries, "UPDATE reports")).toBe(true);
  });

  it("refuses to publish when the report was revised after linting", async () => {
    const { app, queries } = await lintServer("All quiet. No action needed.", false);
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(409);
    expect(queries.find((sql) => sql.startsWith("UPDATE reports"))).toContain("current_revision = $2");
  });

  it("publishes anyway in warn mode, returning the findings", async () => {
    process.env.AISEVAK_WRITING_LINT = "warn";
    const { app } = await lintServer(tooLong);
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck.errors.map((item: { rule: string }) => item.rule)).toEqual(["length"]);
  });

  it("advises on the markdown a revise call wrote, not the stored revision", async () => {
    const { app, queries } = await lintServer("All quiet.");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/revisions", headers, payload: { markdown: tooLong }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toMatchObject({ passed: false });
    expect(response.json().report.markdown).toBeUndefined();
    expect(wrote(queries, "INSERT INTO report_versions")).toBe(true);
  });

  it("silences draft advice when the lint is off", async () => {
    process.env.AISEVAK_WRITING_LINT = "off";
    const { app } = await lintServer("All quiet.");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/revisions", headers, payload: { markdown: tooLong }
    });
    expect(response.json().writingCheck).toEqual({ passed: true, errors: [], warnings: [] });
  });
});

describe("writing lint on incident routes", () => {
  it("rejects a declaration before creating its thread or incident", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/incidents", headers,
      payload: { title: "x".repeat(90), description: "Why it matters.", markdown: "Queue is stalled." }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("Shorten the title");
    expect(queries.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("rejects an update before recording it", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/incidents/INC-3/updates", headers, payload: { markdown: `Raw owners ${rawIds}.` }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("INC-3 update");
    expect(queries.some((sql) => sql.includes("INSERT INTO incident_updates"))).toBe(false);
  });

  it("rejects a resolution note before resolving", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/incidents/INC-3/resolve", headers, payload: { markdown: tooLong }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("INC-3 resolution");
    expect(wrote(queries, "UPDATE incidents")).toBe(false);
  });

  it("resolves without a note and without linting", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/incidents/INC-3/resolve", headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toBeUndefined();
    expect(wrote(queries, "UPDATE incidents")).toBe(true);
  });
});

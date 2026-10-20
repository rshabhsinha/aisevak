import type { DbPool } from "@aisevak/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

const openApps: FastifyInstance[] = [];
const headers = { authorization: "Bearer test" };
const tooLong = Array.from({ length: 450 }, () => "word").join(" ");
const rawIds = Array.from({ length: 4 }, (_, index) => `981758a4-c188-4078-b1f3-8774a7272a4${index}`).join(", ");
const originalMode = process.env.AISEVAK_WRITING_LINT;

// Pin the mode so a developer's exported AISEVAK_WRITING_LINT=off cannot change these results.
beforeEach(() => {
  process.env.AISEVAK_WRITING_LINT = "warn";
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  if (originalMode === undefined) delete process.env.AISEVAK_WRITING_LINT;
  else process.env.AISEVAK_WRITING_LINT = originalMode;
});

async function lintServer(reportMarkdown: string, publishMatches = true): Promise<{ app: FastifyInstance; queries: string[] }> {
  const queries: string[] = [];
  async function query(raw: string) {
    const sql = raw.trimStart();
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
    if (sql.startsWith("INSERT INTO incident_updates")) return { rows: [] };
    // Incident declaration; the Orchestrator is the caller, so no delivery is queued.
    if (sql.startsWith("SELECT * FROM agents WHERE kind = 'dispatcher'")) return { rows: [{ id: "agent", kind: "dispatcher", name: "Orchestrator", capabilities: [] }] };
    if (sql.startsWith("INSERT INTO coordination_threads")) return { rows: [{ id: "thread", number: 12 }] };
    if (sql.startsWith("INSERT INTO incidents")) return { rows: [{ id: "incident" }] };
    if (sql.startsWith("INSERT INTO thread_participants") || sql.startsWith("UPDATE coordination_threads")) return { rows: [] };
    if (sql.startsWith("INSERT INTO thread_messages")) return { rows: [{ id: "message" }] };
    if (sql.includes("FROM coordination_threads")) return { rows: [{ id: "thread", number: 12, title: "Incident: Queue stalled" }] };
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

// The lint is advice only: every write goes through and returns its findings.
describe("writing lint on report routes", () => {
  it("publishes a report that breaks the limits and returns the findings", async () => {
    const { app, queries } = await lintServer(tooLong);
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toMatchObject({ passed: false });
    expect(response.json().writingCheck.errors.map((item: { rule: string }) => item.rule)).toEqual(["length"]);
    expect(wrote(queries, "UPDATE reports")).toBe(true);
  });

  it("publishes a short report with a clean check", async () => {
    const { app } = await lintServer("All quiet. No action needed.");
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toEqual({ passed: true, errors: [], warnings: [] });
  });

  it("refuses to publish when the report was revised after it was checked", async () => {
    const { app, queries } = await lintServer("All quiet. No action needed.", false);
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.statusCode).toBe(409);
    expect(queries.find((sql) => sql.startsWith("UPDATE reports"))).toContain("current_revision = $2");
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

  it("returns an empty check when the lint is off", async () => {
    process.env.AISEVAK_WRITING_LINT = "off";
    const { app } = await lintServer(tooLong);
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/reports/REPORT-9/publish", headers });
    expect(response.json().writingCheck).toEqual({ passed: true, errors: [], warnings: [] });
  });
});

describe("writing lint on incident routes", () => {
  it("declares an incident that breaks the limits and returns the findings", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/incidents", headers,
      payload: { title: "x".repeat(90), description: "Why it matters.", markdown: "Queue is stalled." }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck.errors.map((item: { rule: string }) => item.rule)).toEqual(["title-length"]);
    expect(wrote(queries, "INSERT INTO incidents")).toBe(true);
    expect(response.json().thread).toMatchObject({ key: "THREAD-12" });
  });

  it("records an update that breaks the limits and returns the findings", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/incidents/INC-3/updates", headers, payload: { markdown: `Raw owners ${rawIds}.` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck.errors.map((item: { rule: string }) => item.rule)).toEqual(["raw-ids"]);
    expect(queries.some((sql) => sql.includes("INSERT INTO incident_updates"))).toBe(true);
  });

  it("resolves with a long note and returns the findings", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({
      method: "POST", url: "/api/agent-tools/v1/incidents/INC-3/resolve", headers, payload: { markdown: tooLong }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toMatchObject({ passed: false });
    expect(wrote(queries, "UPDATE incidents")).toBe(true);
  });

  it("resolves without a note and without a check", async () => {
    const { app, queries } = await lintServer("");
    const response = await app.inject({ method: "POST", url: "/api/agent-tools/v1/incidents/INC-3/resolve", headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().writingCheck).toBeUndefined();
    expect(wrote(queries, "UPDATE incidents")).toBe(true);
  });
});

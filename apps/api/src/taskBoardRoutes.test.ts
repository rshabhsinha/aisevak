import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const task = (number: number, createdAt: string) => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  number,
  title: `Task ${number}`,
  created_at: createdAt
});

async function taskServer(rows: unknown[], total = rows.length) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM sessions")) {
        return { rows: [{ id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", name: "Owner", role: "owner" }] };
      }
      if (sql.includes("FROM api_keys")) return { rows: [] };
      if (sql.includes("count(*)::int AS total")) return { rows: [{ total }] };
      if (sql.includes("FROM tasks")) return { rows };
      throw new Error(`Unexpected query: ${sql}`);
    }
  } as unknown as DbPool;
  const app = await buildServer(pool);
  openApps.push(app);
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: "aisevak_session=test-session" } });
  return { get, calls };
}

describe("task board routes", () => {
  it("pages one column with a keyset cursor and a column total", async () => {
    const { get, calls } = await taskServer([task(3, "2026-10-03T00:00:00.000Z"), task(2, "2026-10-02T00:00:00.000Z"), task(1, "2026-10-01T00:00:00.000Z")], 40);
    const response = await get("/api/tasks?bucket=completed&limit=2");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tasks.map((row: { number: number }) => row.number)).toEqual([3, 2]);
    expect(body).toMatchObject({ hasMore: true, total: 40 });

    const list = calls.find((call) => call.sql.includes("LIMIT $"))!;
    expect(list.sql).toContain("COALESCE(latest.status::text, tasks.status::text) IN ('succeeded'");
    expect(list.params.at(-1)).toBe(3);

    calls.length = 0;
    await get(`/api/tasks?bucket=completed&limit=2&cursor=${body.nextCursor}`);
    const next = calls.find((call) => call.sql.includes("LIMIT $"))!;
    expect(next.sql).toContain("(tasks.created_at, tasks.id) < (");
    expect(next.params).toEqual(["2026-10-02T00:00:00.000Z", task(2, "").id, 3]);
    // The total ignores the cursor so the column badge stays stable while paging.
    expect(calls.find((call) => call.sql.includes("count(*)::int AS total"))!.sql).not.toContain("tasks.created_at, tasks.id");
  });

  it("puts tasks with an unknown or missing status in the Todo column", async () => {
    const { get, calls } = await taskServer([]);
    await get("/api/tasks?bucket=open");
    expect(calls.find((call) => call.sql.includes("LIMIT $"))!.sql).toMatch(/IS NULL OR COALESCE\(latest\.status::text, tasks\.status::text\) NOT IN \('queued'/);
  });

  it("searches on the server", async () => {
    const { get, calls } = await taskServer([]);
    await get("/api/tasks?bucket=failed&query=PCB");
    const list = calls.find((call) => call.sql.includes("LIMIT $"))!;
    expect(list.params[0]).toBe("%PCB%");
    expect(list.sql).toContain("tasks.title ILIKE $1");
  });

  it("keeps the unbounded list for clients that send no paging parameters", async () => {
    const { get, calls } = await taskServer([task(1, "2026-10-01T00:00:00.000Z")]);
    const response = await get("/api/tasks");
    expect(response.json()).toEqual({ tasks: [task(1, "2026-10-01T00:00:00.000Z")] });
    expect(calls.some((call) => call.sql.includes("LIMIT $"))).toBe(false);
  });

  it("rejects unknown buckets", async () => {
    const { get } = await taskServer([]);
    expect((await get("/api/tasks?bucket=archived")).statusCode).toBeGreaterThanOrEqual(400);
  });
});

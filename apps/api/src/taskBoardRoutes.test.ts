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
// Paged queries also select the exact microsecond timestamp for the cursor.
const pagedTask = (number: number, createdAt: string, cursorCreatedAt: string) => ({
  ...task(number, createdAt),
  cursor_created_at: cursorCreatedAt
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
    const { get, calls } = await taskServer([
      pagedTask(3, "2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000000Z"),
      pagedTask(2, "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000000Z"),
      pagedTask(1, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000000Z")
    ], 40);
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
    expect(next.params).toEqual(["2026-10-02T00:00:00.000000Z", task(2, "").id, 3]);
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

  it("builds the cursor from the exact microsecond timestamp, not the millisecond Date", async () => {
    // Two tasks inserted in one transaction share a millisecond; a millisecond
    // cursor would skip the second one on the next page.
    const { get, calls } = await taskServer([
      pagedTask(5, "2026-10-05T00:00:00.123Z", "2026-10-05T00:00:00.123456Z"),
      pagedTask(4, "2026-10-05T00:00:00.123Z", "2026-10-05T00:00:00.123100Z")
    ]);
    const body = (await get("/api/tasks?bucket=open&limit=1")).json();
    expect(body.tasks).toEqual([task(5, "2026-10-05T00:00:00.123Z")]);
    expect(calls.find((call) => call.sql.includes("LIMIT $"))!.sql).toContain("AS cursor_created_at");

    calls.length = 0;
    await get(`/api/tasks?bucket=open&limit=1&cursor=${body.nextCursor}`);
    const next = calls.find((call) => call.sql.includes("LIMIT $"))!;
    expect(next.params.slice(0, 2)).toEqual(["2026-10-05T00:00:00.123456Z", task(5, "").id]);
  });

  it("rejects invalid query parameters with 400", async () => {
    const { get } = await taskServer([]);
    expect((await get("/api/tasks?bucket=archived")).statusCode).toBe(400);
    expect((await get("/api/tasks?bucket=open&limit=0")).statusCode).toBe(400);
    expect((await get("/api/tasks?bucket=open&limit=500")).statusCode).toBe(400);
    expect((await get("/api/tasks?bucket=open&cursor=not-a-cursor")).statusCode).toBe(400);
  });

  it("serves bounded task references without matching the task detail route", async () => {
    const { get, calls } = await taskServer([{ id: task(1, "").id, number: 1, title: "Task 1" }]);
    const response = await get("/api/tasks/references");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tasks: [{ id: task(1, "").id, number: 1, title: "Task 1" }] });
    expect(calls.find((call) => call.sql.includes("FROM tasks"))!.sql).toContain("LIMIT 500");
  });
});

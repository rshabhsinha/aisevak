import type { DbPool } from "@aisevak/core";
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";

// The runner reads MANAGED_ROOT when its module loads; set it before the import.
const managedRoot = vi.hoisted(() => {
  const root = `/tmp/aisevak-dispatcher-heartbeat-test-${process.pid}`;
  process.env.MANAGED_ROOT = root;
  return root;
});

const { enqueueDispatcherHeartbeat } = await import("./index.js");

afterAll(async () => { await rm(managedRoot, { recursive: true, force: true }); });

describe("dispatcher heartbeat session", () => {
  it("queues every heartbeat on a fresh provider conversation", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("SELECT count(*) FROM dispatcher_runs")) return { rows: [{ count: "0" }] };
        if (sql.includes("max(created_at)")) return { rows: [{ last_run_at: null }] };
        if (sql.includes("SELECT count(*)")) return { rows: [{ count: "1" }] };
        if (sql.includes("kind = 'dispatcher' AND enabled = true")) {
          return { rows: [{ id: "dispatcher-id", model: "gpt-test", instructions: "route work" }] };
        }
        return { rows: [] };
      }
    } as unknown as DbPool;

    await enqueueDispatcherHeartbeat(pool);

    const insert = queries.find((query) => query.sql.includes("INSERT INTO dispatcher_runs"));
    expect(insert?.params?.[1]).toBe(`${managedRoot}/codex-homes/dispatcher-heartbeat`);
    expect(insert?.params?.[2]).toBeNull();
    expect(queries.some((query) => query.sql.includes("codex_thread_id") && !query.sql.includes("INSERT"))).toBe(false);
  });
});

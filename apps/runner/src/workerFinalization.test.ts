import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { finalizeWorkerRunState } from "./index.js";

function recordingPool(): { pool: DbPool; queries: Array<{ sql: string; params?: unknown[] }> } {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [] };
    },
    release() {}
  };
  return {
    pool: { async connect() { return client; } } as unknown as DbPool,
    queries
  };
}

describe("worker run finalization", () => {
  it("completes the run, task, and coordination thread in one transaction", async () => {
    const { pool, queries } = recordingPool();

    await finalizeWorkerRunState(pool, {
      runId: "run-id",
      taskId: "task-id",
      agentThreadId: "agent-thread-id",
      coordinationThreadId: "coordination-thread-id",
      finalStatus: "succeeded",
      stdout: "done",
      stderr: "",
      exitCode: 0
    });

    expect(queries.map((query) => query.sql.trim())).toEqual([
      "BEGIN",
      expect.stringContaining("UPDATE task_runs"),
      expect.stringContaining("UPDATE tasks"),
      expect.stringContaining("UPDATE coordination_threads"),
      expect.stringContaining("UPDATE agent_threads"),
      "COMMIT"
    ]);
    expect(queries[2]?.params).toEqual(["task-id", "completed"]);
    expect(queries[3]?.params).toEqual(["coordination-thread-id", "completed"]);
    expect(queries[2]?.sql).toContain("status = 'open'");
    expect(queries[3]?.sql).toContain("status = 'active'");
  });

  it.each(["failed", "cancelled"] as const)("blocks the thread when a run is %s", async (finalStatus) => {
    const { pool, queries } = recordingPool();

    await finalizeWorkerRunState(pool, {
      runId: "run-id",
      taskId: "task-id",
      agentThreadId: null,
      coordinationThreadId: "coordination-thread-id",
      finalStatus,
      stdout: "",
      stderr: "stopped",
      exitCode: null
    });

    expect(queries.find((query) => query.sql.includes("UPDATE tasks"))?.params).toEqual([
      "task-id",
      "needs_attention"
    ]);
    expect(queries.find((query) => query.sql.includes("UPDATE coordination_threads"))?.params).toEqual([
      "coordination-thread-id",
      "blocked"
    ]);
  });

  it("only applies automatic statuses while the task and thread remain unresolved", async () => {
    const { pool, queries } = recordingPool();

    await finalizeWorkerRunState(pool, {
      runId: "run-id",
      taskId: "task-id",
      agentThreadId: null,
      coordinationThreadId: "coordination-thread-id",
      finalStatus: "succeeded",
      stdout: "done",
      stderr: "",
      exitCode: 0
    });

    const taskUpdate = queries.find((query) => query.sql.includes("UPDATE tasks"));
    const threadUpdate = queries.find((query) => query.sql.includes("UPDATE coordination_threads"));
    expect(taskUpdate?.sql).toMatch(/WHERE id = \$1\s+AND status = 'open'/);
    expect(threadUpdate?.sql).toMatch(/WHERE id = \$1\s+AND status = 'active'/);
  });

  it("does not let a stale worker finalize the transferred task", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("SELECT ownership_generation")) return { rows: [{ ownership_generation: 8 }] };
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async connect() { return client; } } as unknown as DbPool;

    await finalizeWorkerRunState(pool, {
      runId: "run-id",
      taskId: "task-id",
      agentThreadId: "agent-thread-id",
      agentThreadGeneration: 7,
      coordinationThreadId: "coordination-thread-id",
      finalStatus: "succeeded",
      stdout: "stale",
      stderr: "",
      exitCode: 0
    });

    expect(queries.some((query) => query.sql.includes("UPDATE task_runs"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("UPDATE tasks"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("UPDATE coordination_threads"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("UPDATE agent_threads"))).toBe(false);
  });
});

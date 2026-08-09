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
});

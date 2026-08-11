import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import {
  acquireRunLaunchFence,
  dispatcherRunStillOwned,
  processOneDispatcherRun,
  processOneRunJob,
  startAvailableRunJobs,
  waitForRunJobs,
  workerRunStillOwned
} from "./index.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("bounded runner execution", () => {
  it("makes progress on distinct threads while keeping one active turn per thread", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const queue: Array<{ thread: string; gate: Deferred }> = [
      { thread: "thread-a", gate: gates[0]! },
      { thread: "thread-a", gate: gates[1]! },
      { thread: "thread-b", gate: gates[2]! }
    ];
    const activeThreads = new Set<string>();
    const started: string[] = [];
    let maximumThreadConcurrency = 0;
    const runOne = async () => {
      const candidate = queue.find((entry) => !activeThreads.has(entry.thread));
      if (!candidate) return;
      activeThreads.add(candidate.thread);
      started.push(candidate.thread);
      maximumThreadConcurrency = Math.max(maximumThreadConcurrency, activeThreads.size);
      await candidate.gate.promise;
      activeThreads.delete(candidate.thread);
    };
    const noDispatcher = async () => false;
    const activeJobs = new Set<Promise<void>>();

    startAvailableRunJobs({} as DbPool, activeJobs, 2, [noDispatcher, runOne]);
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["thread-a", "thread-b"]);
    expect(maximumThreadConcurrency).toBe(2);

    gates[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    startAvailableRunJobs({} as DbPool, activeJobs, 2, [noDispatcher, runOne]);
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["thread-a", "thread-b", "thread-a"]);
    expect(maximumThreadConcurrency).toBe(2);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await waitForRunJobs(activeJobs);
    expect(activeThreads.size).toBe(0);
  });

  it("claims only one active turn across worker and dispatcher runs for an agent thread", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await processOneDispatcherRun(pool);
    await processOneRunJob(pool);

    const dispatcherClaim = queries.find(
      (sql) => sql.includes("SELECT candidate.id") && sql.includes("FROM dispatcher_runs candidate")
    );
    const workerClaim = queries.find(
      (sql) => sql.includes("SELECT candidate.id") && sql.includes("FROM task_runs candidate")
    );
    expect(dispatcherClaim).toContain("active_worker.agent_thread_id = candidate.agent_thread_id");
    expect(dispatcherClaim).toContain("active_dispatcher.agent_thread_id = candidate.agent_thread_id");
    expect(workerClaim).toContain("active_worker.agent_thread_id = candidate.agent_thread_id");
    expect(workerClaim).toContain("active_dispatcher.agent_thread_id = candidate.agent_thread_id");
    expect(dispatcherClaim).toContain("active_project_turns.status IN ('running', 'cancel_requested')");
    expect(workerClaim).toContain("active_project_turns.status IN ('running', 'cancel_requested')");
    expect(dispatcherClaim).toContain("candidate.workspace_key, candidate.workspace_mode");
    expect(dispatcherClaim).toContain(
      "active_project_turns.workspace_key = candidate.workspace_key"
    );
    expect(workerClaim).toContain("candidate.workspace_key, candidate.workspace_mode");
    expect(workerClaim).toContain(
      "active_project_turns.workspace_key = candidate.workspace_key"
    );
    expect(dispatcherClaim).toContain("candidate.agent_thread_generation = candidate_thread.ownership_generation");
    expect(workerClaim).toContain("candidate.agent_thread_generation = candidate_thread.ownership_generation");

  });

  it("revalidates the run and task ownership immediately before provider launch", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return { rows: [{ id: "still-owned" }] };
      }
    } as unknown as DbPool;

    await expect(dispatcherRunStillOwned(pool, {
      id: "dispatcher-run",
      agent_thread_id: "thread-id",
      agent_thread_generation: 7,
      task_id: null,
      agent_id: "agent-id"
    })).resolves.toBe(true);
    await expect(workerRunStillOwned(pool, {
      id: "worker-run",
      agent_thread_id: "thread-id",
      agent_thread_generation: 7,
      agent_id: "agent-id"
    })).resolves.toBe(true);

    expect(queries[0]?.sql).toContain("dispatcher_runs.status = 'running'");
    expect(queries[0]?.sql).toContain("agent_threads.ownership_generation = $4");
    expect(queries[1]?.sql).toContain("task_runs.status = 'running'");
    expect(queries[1]?.sql).toContain("tasks.agent_id = $2");
    expect(queries[1]?.sql).toContain("agent_threads.ownership_generation = $4");
  });

  it("holds task and thread locks through the provider turn/start write", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("FROM tasks") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "task-id", agent_id: "agent-id" }] };
        }
        if (sql.includes("FROM agent_threads") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "thread-id", agent_id: "agent-id", ownership_generation: 7 }] };
        }
        if (sql.includes("FROM task_runs") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: "run-id",
              status: "running",
              task_id: "task-id",
              agent_thread_id: "thread-id",
              agent_thread_generation: 7
            }]
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release() {}
    };
    const pool = { async connect() { return client; } } as unknown as DbPool;

    const release = await acquireRunLaunchFence(pool, {
      kind: "worker",
      runId: "run-id",
      taskId: "task-id",
      agentThreadId: "thread-id",
      agentThreadGeneration: 7,
      agentId: "agent-id"
    });

    expect(release).toBeTypeOf("function");
    expect(queries.findIndex((sql) => sql.includes("FROM tasks"))).toBeLessThan(
      queries.findIndex((sql) => sql.includes("FROM agent_threads"))
    );
    expect(queries.findIndex((sql) => sql.includes("FROM agent_threads"))).toBeLessThan(
      queries.findIndex((sql) => sql.includes("FROM task_runs"))
    );
    await release?.();
    expect(queries.at(-1)).toBe("COMMIT");
  });
});

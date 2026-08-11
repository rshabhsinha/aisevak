import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { processOneDispatcherRun, processOneRunJob, startAvailableRunJobs, waitForRunJobs } from "./index.js";

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
    expect(dispatcherClaim).toContain(
      "COALESCE(candidate_thread.project_id, candidate_task.project_id) AS project_id"
    );
    expect(dispatcherClaim).toContain(
      "active_project_turns.project_id = COALESCE(candidate_thread.project_id, candidate_task.project_id)"
    );
    expect(dispatcherClaim).toContain("candidate.agent_thread_generation = candidate_thread.ownership_generation");
    expect(workerClaim).toContain("candidate.agent_thread_generation = candidate_thread.ownership_generation");

  });
});

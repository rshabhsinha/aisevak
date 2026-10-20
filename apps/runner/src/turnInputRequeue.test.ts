import type { DbPool } from "@aisevak/core";
import { describe, expect, it, onTestFinished } from "vitest";
import { recoverInterruptedCoordinationRuns } from "./index.js";

type Entry = { sql: string; params?: unknown[] };

interface Scenario {
  interruptedRun?: { launch_attempted_at: Date | null; presented_at: Date | null };
  terminalInputs?: Array<{ input_id: string; message_delivery_id: string; input_status: "queued" | "delivering"; run_status: string }>;
  activeRunId?: string | null;
  runQueuedInputs?: string[];
  sourceStatus?: string;
  providerThreadId?: string | null;
}

function recoveryPool(scenario: Scenario): { pool: DbPool; queries: Entry[] } {
  const queries: Entry[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    const normalized = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
    if (normalized.startsWith("SELECT id, status::text, message_delivery_id")) {
      return { rows: scenario.interruptedRun ? [{ id: "run", status: "running", message_delivery_id: "run-delivery" }] : [] };
    }
    if (normalized.startsWith("SELECT message_delivery_id, status::text")) {
      return { rows: [{ message_delivery_id: "run-delivery", status: "running" }] };
    }
    if (normalized.includes("SELECT delivery.status") && normalized.includes("launch_attempted_at")) {
      return {
        rows: [{
          status: "running",
          attempt_count: 1,
          presented_at: scenario.interruptedRun?.presented_at ?? null,
          launch_attempted_at: scenario.interruptedRun?.launch_attempted_at ?? null,
          agent_thread_id: "agent-thread",
          agent_thread_generation: 2,
          ownership_generation: 2
        }]
      };
    }
    if (normalized.startsWith("SELECT id") && normalized.includes("FROM agent_turn_inputs") && normalized.includes("dispatcher_run_id = $1")) {
      return { rows: (scenario.runQueuedInputs ?? []).map((id) => ({ id })) };
    }
    if (normalized.includes("SELECT agent_turn_inputs.id AS input_id")) {
      return { rows: scenario.terminalInputs ?? [] };
    }
    if (normalized.startsWith("SELECT agent_thread_id, message_delivery_id FROM agent_turn_inputs")) {
      return { rows: [{ agent_thread_id: "agent-thread", message_delivery_id: `${params?.[0]}-delivery` }] };
    }
    if (normalized.includes("FROM agent_threads") && normalized.includes("archived_at IS NULL") && normalized.includes("FOR UPDATE")) {
      return {
        rows: [{
          ownership_generation: 2,
          provider_thread_id: scenario.providerThreadId === undefined ? "provider-thread" : scenario.providerThreadId,
          task_id: null
        }]
      };
    }
    if (normalized.includes("FROM agent_turn_inputs input")) {
      const id = params?.[0];
      return {
        rows: [{
          message_delivery_id: `${id}-delivery`,
          assignment_id: null,
          message: `message for ${id}`,
          source_run_id: "ended-run",
          source_generation: 2,
          source_status: scenario.sourceStatus ?? "succeeded",
          delivery_status: "queued"
        }]
      };
    }
    if (normalized.includes("AND status IN ('queued', 'running')") && normalized.includes("AND id <> $3")) {
      return { rows: scenario.activeRunId ? [{ id: scenario.activeRunId }] : [] };
    }
    if (normalized.includes("INSERT INTO dispatcher_runs")) return { rows: [{ id: "new-run" }] };
    if (normalized.includes("UPDATE agent_turn_inputs") && normalized.includes("WHERE dispatcher_run_id = $1")) {
      return { rows: [] };
    }
    if (normalized.includes("UPDATE agent_turn_inputs") && normalized.includes("RETURNING message_delivery_id")) {
      return { rows: [{ message_delivery_id: `${params?.[0]}-delivery` }] };
    }
    if (normalized.includes("UPDATE dispatcher_runs") && normalized.includes("RETURNING id")) {
      return { rows: [{ id: "run" }] };
    }
    return { rows: [] };
  };
  const client = { query, release() {} };
  return { pool: { query, async connect() { return client; } } as unknown as DbPool, queries };
}

const targets = (param: unknown, id: string) => param === id || (Array.isArray(param) && param.includes(id));
const failedDelivery = (queries: Entry[], id: string) =>
  queries.some((entry) =>
    entry.sql.includes("UPDATE message_deliveries") &&
    entry.sql.includes("'failed'") &&
    targets(entry.params?.[0], id)
  ) ||
  queries.some((entry) =>
    entry.sql.includes("UPDATE message_deliveries") &&
    entry.sql.includes("SET status = $2") &&
    entry.params?.[0] === id &&
    entry.params?.[1] === "failed"
  );

describe("never-presented coordination messages", () => {
  it("retries an interrupted run's delivery when the run never launched its prompt", async () => {
    const { pool, queries } = recoveryPool({ interruptedRun: { launch_attempted_at: null, presented_at: null } });

    await recoverInterruptedCoordinationRuns(pool);

    const retry = queries.find((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"));
    expect(retry?.sql).toContain("'retry'");
    expect(retry?.params).toEqual(["run", "run-delivery"]);
    expect(queries.some((entry) =>
      entry.sql.includes("SET status = 'retrying'") && entry.params?.[0] === "run-delivery"
    )).toBe(true);
    expect(failedDelivery(queries, "run-delivery")).toBe(false);
  });

  // Phase 2 redelivers these instead (interruptedRedelivery.test.ts); the
  // legacy flag keeps the old outcome.
  it("still fails an interrupted delivery whose prompt may have reached the provider in legacy mode", async () => {
    process.env.AISEVAK_COORDINATION_LEGACY = "1";
    onTestFinished(() => { delete process.env.AISEVAK_COORDINATION_LEGACY; });
    for (const run of [
      { launch_attempted_at: new Date(), presented_at: null },
      { launch_attempted_at: new Date(), presented_at: new Date() }
    ]) {
      const { pool, queries } = recoveryPool({ interruptedRun: run });

      await recoverInterruptedCoordinationRuns(pool);

      expect(queries.some((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
      expect(failedDelivery(queries, "run-delivery")).toBe(true);
    }
  });

  it("requeues queued inputs from an ended run as a fresh turn and fails only delivering ones", async () => {
    const { pool, queries } = recoveryPool({
      terminalInputs: [
        { input_id: "queued-input", message_delivery_id: "queued-input-delivery", input_status: "queued", run_status: "succeeded" },
        { input_id: "delivering-input", message_delivery_id: "delivering-input-delivery", input_status: "delivering", run_status: "failed" }
      ]
    });

    await recoverInterruptedCoordinationRuns(pool);

    const created = queries.filter((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"));
    expect(created).toHaveLength(1);
    expect(created[0]?.sql).toContain("'message', 'coordination'");
    expect(created[0]?.params).toEqual([
      "ended-run", null, null, "queued-input-delivery", "provider-thread", "message for queued-input"
    ]);
    expect(queries.some((entry) =>
      entry.sql.startsWith("DELETE FROM agent_turn_inputs") && entry.params?.[0] === "queued-input"
    )).toBe(true);
    expect(failedDelivery(queries, "queued-input-delivery")).toBe(false);
    expect(failedDelivery(queries, "delivering-input-delivery")).toBe(true);
  });

  it("moves a queued input onto the thread's active run instead of starting another", async () => {
    const { pool, queries } = recoveryPool({
      terminalInputs: [
        { input_id: "queued-input", message_delivery_id: "queued-input-delivery", input_status: "queued", run_status: "failed" }
      ],
      activeRunId: "active-run"
    });

    await recoverInterruptedCoordinationRuns(pool);

    expect(queries.some((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(queries.some((entry) =>
      entry.sql.includes("SET dispatcher_run_id = $2") &&
      entry.params?.[0] === "queued-input" &&
      entry.params?.[1] === "active-run"
    )).toBe(true);
    expect(failedDelivery(queries, "queued-input-delivery")).toBe(false);
  });

  it("requeues inputs still queued on a run when the run ends instead of failing them", async () => {
    // Legacy mode, so the presented main delivery fails rather than being redelivered.
    process.env.AISEVAK_COORDINATION_LEGACY = "1";
    onTestFinished(() => { delete process.env.AISEVAK_COORDINATION_LEGACY; });
    const { pool, queries } = recoveryPool({
      interruptedRun: { launch_attempted_at: new Date(), presented_at: new Date() },
      runQueuedInputs: ["queued-input"]
    });

    await recoverInterruptedCoordinationRuns(pool);

    const created = queries.filter((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"));
    expect(created).toHaveLength(1);
    expect(created[0]?.params?.[3]).toBe("queued-input-delivery");
    expect(queries.some((entry) =>
      entry.sql.startsWith("DELETE FROM agent_turn_inputs") && entry.params?.[0] === "queued-input"
    )).toBe(true);
    expect(failedDelivery(queries, "queued-input-delivery")).toBe(false);
    expect(failedDelivery(queries, "run-delivery")).toBe(true);
  });

  it("fails messages pending on a run the user stopped instead of relaunching them", async () => {
    const { pool, queries } = recoveryPool({
      terminalInputs: [
        { input_id: "queued-input", message_delivery_id: "queued-input-delivery", input_status: "queued", run_status: "cancelled" }
      ],
      sourceStatus: "cancelled"
    });

    await recoverInterruptedCoordinationRuns(pool);

    expect(queries.some((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(queries.some((entry) => entry.sql.startsWith("DELETE FROM agent_turn_inputs"))).toBe(false);
    expect(failedDelivery(queries, "queued-input-delivery")).toBe(true);
  });

  it("does not start a fresh run from incremental text when the thread has no provider session", async () => {
    const { pool, queries } = recoveryPool({
      terminalInputs: [
        { input_id: "queued-input", message_delivery_id: "queued-input-delivery", input_status: "queued", run_status: "failed" }
      ],
      providerThreadId: null
    });

    await recoverInterruptedCoordinationRuns(pool);

    expect(queries.some((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(failedDelivery(queries, "queued-input-delivery")).toBe(true);
  });

  it("locks the delivery before the agent thread when requeueing", async () => {
    const { pool, queries } = recoveryPool({
      terminalInputs: [
        { input_id: "queued-input", message_delivery_id: "queued-input-delivery", input_status: "queued", run_status: "failed" }
      ]
    });

    await recoverInterruptedCoordinationRuns(pool);

    const deliveryLock = queries.findIndex((entry) =>
      entry.sql.includes("FROM message_deliveries WHERE id = $1 FOR UPDATE") && entry.params?.[0] === "queued-input-delivery"
    );
    const threadLock = queries.findIndex((entry) =>
      entry.sql.includes("FROM agent_threads") && entry.sql.includes("archived_at IS NULL") && entry.sql.includes("FOR UPDATE")
    );
    expect(deliveryLock).toBeGreaterThanOrEqual(0);
    expect(threadLock).toBeGreaterThan(deliveryLock);
  });
});

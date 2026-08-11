import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import {
  recoverAmbiguousWorkspaceRuns,
  recoverInterruptedCoordinationRuns,
  recoverStaleAgentThreadRuns
} from "./index.js";

describe("coordination startup recovery", () => {
  it("cancels detached task and project-thread runs whose workspace snapshot is ambiguous", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      const normalized = sql.trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (normalized.includes("UPDATE task_runs") && normalized.includes("RETURNING id")) {
        return { rows: [{ id: "ambiguous-worker" }] };
      }
      if (
        normalized.includes("UPDATE dispatcher_runs") &&
        normalized.includes("task_id IS NOT NULL") &&
        normalized.includes("RETURNING id")
      ) {
        return { rows: [{ id: "ambiguous-dispatcher", message_delivery_id: "delivery-id" }] };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await recoverAmbiguousWorkspaceRuns(pool);

    expect(queries.find((sql) => sql.includes("UPDATE task_runs"))).toContain("status = 'cancelled'");
    expect(queries.find((sql) => sql.includes("UPDATE task_runs"))).toContain(
      "workspace_mode = 'projectless'"
    );
    expect(queries.find((sql) => sql.includes("UPDATE task_runs"))).toContain(
      "workspace_source = 'projectless'"
    );
    expect(queries.find((sql) => sql.includes("UPDATE dispatcher_runs") && sql.includes("task_id IS NOT NULL"))).toContain(
      "workspace_source = 'unknown'"
    );
    expect(queries.find((sql) => sql.includes("UPDATE dispatcher_runs") && sql.includes("task_id IS NOT NULL"))).toContain(
      "OR agent_thread_id IS NOT NULL"
    );
    expect(queries.some((sql) => sql.includes("UPDATE message_deliveries") && sql.includes("status = 'failed'"))).toBe(true);
    expect(queries.some((sql) => sql.includes("status = 'queued' OR status = 'cancel_requested'"))).toBe(true);
  });

  it("fails closed for ambiguous runs and terminalizes queued and delivering inputs", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const inputUpdates: unknown[][] = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const normalized = sql.trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (normalized.startsWith("SELECT id, status::text, message_delivery_id")) {
        return { rows: [{ id: "interrupted-run", status: "running", message_delivery_id: "initial-delivery" }] };
      }
      if (normalized.includes("SELECT delivery.status")) {
        return {
          rows: [{
            status: "running",
            attempt_count: 1,
            presented_at: null,
            provider_thread_id: "established-provider-thread"
          }]
        };
      }
      if (normalized.includes("SELECT dispatcher_runs.id AS run_id")) return { rows: [] };
      if (normalized.includes("SELECT agent_turn_inputs.id AS input_id")) {
        return {
          rows: [
            {
              input_id: "queued-input",
              message_delivery_id: "queued-delivery",
              input_status: "queued",
              run_status: "succeeded"
            },
            {
              input_id: "delivering-input",
              message_delivery_id: "delivering-delivery",
              input_status: "delivering",
              run_status: "failed"
            }
          ]
        };
      }
      if (normalized.includes("UPDATE agent_turn_inputs") && normalized.includes("WHERE dispatcher_run_id")) {
        return { rows: [] };
      }
      if (normalized.includes("UPDATE agent_turn_inputs") && normalized.includes("RETURNING message_delivery_id")) {
        inputUpdates.push(params ?? []);
        return { rows: [{ message_delivery_id: params?.[0] === "queued-input" ? "queued-delivery" : "delivering-delivery" }] };
      }
      if (normalized.includes("UPDATE dispatcher_runs") && normalized.includes("RETURNING id")) {
        return { rows: [{ id: "interrupted-run" }] };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await recoverInterruptedCoordinationRuns(pool);

    expect(queries.some((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(inputUpdates).toEqual([
      ["queued-input", "failed", "The coordination turn finished before this message could be delivered"],
      ["delivering-input", "failed", "The coordination turn finished before this message could be delivered"]
    ]);
    expect(
      queries.filter((entry) => entry.sql.includes("status = 'queued' OR status = 'cancel_requested'"))
    ).not.toHaveLength(0);
  });

  it("cancels stale queued generations instead of promoting them after restart", async () => {
    const queries: string[] = [];
    let workerScanned = false;
    let dispatcherScanned = false;
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM agent_threads") && sql.includes("JOIN task_runs")) {
        if (workerScanned) return { rows: [] };
        workerScanned = true;
        return { rows: [{ id: "thread-id" }] };
      }
      if (sql.includes("FROM agent_threads") && sql.includes("JOIN dispatcher_runs")) {
        if (dispatcherScanned) return { rows: [] };
        dispatcherScanned = true;
        return { rows: [{ id: "thread-id" }] };
      }
      if (sql.includes("FROM task_runs") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "stale-worker" }] };
      }
      if (sql.includes("FROM dispatcher_runs") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "stale-dispatcher", message_delivery_id: null }] };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await recoverStaleAgentThreadRuns(pool);

    expect(queries.find((sql) => sql.includes("UPDATE task_runs"))).toContain("status = 'cancelled'");
    expect(queries.find((sql) => sql.includes("agent_thread_generation <>"))).toContain("agent_thread_generation <>");
    expect(queries.find((sql) => sql.includes("UPDATE dispatcher_runs"))).toContain("status = 'cancelled'");
    expect(queries.every((sql) => !sql.includes("SET agent_thread_generation ="))).toBe(true);
  });

  it("completes a successful coordination run's stranded initial delivery", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const normalized = sql.trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (normalized.startsWith("SELECT id, status::text, message_delivery_id")) return { rows: [] };
      if (normalized.includes("SELECT dispatcher_runs.id AS run_id")) {
        return {
          rows: [{
            run_id: "succeeded-run",
            message_delivery_id: "initial-delivery",
            run_status: "succeeded"
          }]
        };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await recoverInterruptedCoordinationRuns(pool);

    const completion = queries.find((entry) => entry.sql.includes("UPDATE message_deliveries"));
    expect(completion?.params).toEqual(["initial-delivery", "completed", null]);
    expect(queries.some((entry) => entry.sql.includes("status = 'queued' OR status = 'cancel_requested'"))).toBe(true);
  });

  it("leaves a stale run recoverable when dependent terminalization fails", async () => {
    let failTerminalization = true;
    let cancelled = false;
    const query = async (sql: string) => {
      const normalized = sql.trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (normalized.includes("FROM agent_threads") && normalized.includes("JOIN task_runs")) {
        return cancelled ? { rows: [] } : { rows: [{ id: "thread-id" }] };
      }
      if (normalized.includes("FROM task_runs") && normalized.includes("FOR UPDATE")) {
        return { rows: [{ id: "stale-worker" }] };
      }
      if (normalized.includes("UPDATE task_runs")) {
        if (failTerminalization) throw new Error("injected recovery failure");
        cancelled = true;
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await expect(recoverStaleAgentThreadRuns(pool)).rejects.toThrow("injected recovery failure");
    failTerminalization = false;
    await expect(recoverStaleAgentThreadRuns(pool)).resolves.toBeUndefined();
  });
});

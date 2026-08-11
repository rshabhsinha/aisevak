import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { recoverInterruptedCoordinationRuns, recoverStaleAgentThreadRuns } from "./index.js";

describe("coordination startup recovery", () => {
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
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("UPDATE task_runs") && sql.includes("RETURNING id")) {
        return { rows: [{ id: "stale-worker" }] };
      }
      if (sql.includes("UPDATE dispatcher_runs") && sql.includes("RETURNING id, message_delivery_id")) {
        return { rows: [{ id: "stale-dispatcher", message_delivery_id: null }] };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await recoverStaleAgentThreadRuns(pool);

    expect(queries[0]).toContain("status = 'cancelled'");
    expect(queries[0]).toContain("agent_thread_generation <>");
    expect(queries.find((sql) => sql.includes("UPDATE dispatcher_runs"))).toContain("status = 'cancelled'");
    expect(queries.every((sql) => !sql.includes("SET agent_thread_generation ="))).toBe(true);
  });
});

import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { queueAgentTurnInput, queueIncrementalAgentTurnInput } from "./server.js";

describe("agent turn input steering", () => {
  it("rejects an input when the selected run finishes before insertion", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT id FROM agent_threads") && sql.includes("FOR UPDATE")) return { rows: [{}] };
      if (sql.includes("active_turns")) return { rows: [{ id: "run-id", kind: "worker" }] };
      if (sql.includes("INSERT INTO agent_turn_inputs")) return { rows: [] };
      if (sql.includes("FROM agent_threads")) return { rows: [{}] };
      throw new Error(`Unexpected query: ${sql}`);
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await expect(queueAgentTurnInput(pool, "thread-id", "still there?")).rejects.toMatchObject({
      message: "This thread does not have an active turn to steer",
      statusCode: 400
    });
    expect(queries.find((query) => query.includes("INSERT INTO agent_turn_inputs"))).toContain("WHERE EXISTS");
  });

  it("queues an input only while its worker run is still active", async () => {
    const query = async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT id FROM agent_threads") && sql.includes("FOR UPDATE")) return { rows: [{}] };
      if (sql.includes("active_turns")) return { rows: [{ id: "run-id", kind: "worker" }] };
      if (sql.includes("INSERT INTO agent_turn_inputs")) {
        return { rows: [{ id: "input-id", message: "continue" }] };
      }
      if (sql.includes("FROM agent_threads")) return { rows: [{}] };
      throw new Error(`Unexpected query: ${sql}`);
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await expect(queueAgentTurnInput(pool, "thread-id", "continue")).resolves.toEqual({
      input: { id: "input-id", message: "continue" }
    });
  });

  it("reattaches preserved queued prompts to the active turn", async () => {
    const inserts: unknown[][] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("SELECT id FROM agent_threads") && sql.includes("FOR UPDATE")) {
          return { rows: [{}] };
        }
        if (sql.includes("FROM (") && sql.includes("status IN ('queued', 'running')")) {
          return {
            rows: [{
              id: "active-run",
              kind: "dispatcher",
              status: "running",
              prompt: "current",
              message_delivery_id: null,
              scope: "thread"
            }]
          };
        }
        if (sql.includes("WHERE id <> $2")) {
          return {
            rows: [{
              id: "stale-run",
              kind: "dispatcher",
              status: "queued",
              prompt: "stale envelope",
              message_delivery_id: "delivery-id",
              scope: "thread"
            }]
          };
        }
        if (sql.includes("FROM message_deliveries")) return { rows: [{ body: "stale message" }] };
        if (sql.includes("INSERT INTO agent_turn_inputs")) {
          inserts.push(params ?? []);
          return { rows: inserts.length === 2 ? [{ id: "new-input" }] : [] };
        }
        if (sql.includes("UPDATE dispatcher_runs")) return { rows: [] };
        if (sql.includes("SELECT * FROM dispatcher_runs")) {
          return { rows: [{ id: "active-run", status: "running" }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }
    };
    const pool = {
      async connect() {
        return { ...client, release() {} };
      }
    } as unknown as DbPool;

    await queueIncrementalAgentTurnInput(pool, "thread-id", "new message", {
      kind: "dispatcher",
      scope: "thread"
    });

    expect(inserts[0]?.slice(0, 4)).toEqual([
      "thread-id",
      null,
      "active-run",
      "delivery-id"
    ]);
  });
});

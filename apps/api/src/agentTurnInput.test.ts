import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { queueAgentTurnInput } from "./server.js";

describe("agent turn input steering", () => {
  it("rejects an input when the selected run finishes before insertion", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM agent_threads")) return { rows: [{}] };
        if (sql.includes("FROM task_runs") && sql.includes("active_turns")) {
          return { rows: [{ id: "run-id", kind: "worker" }] };
        }
        if (sql.includes("INSERT INTO agent_turn_inputs")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }
    } as unknown as DbPool;

    await expect(queueAgentTurnInput(pool, "thread-id", "still there?")).rejects.toMatchObject({
      message: "This thread does not have an active turn to steer",
      statusCode: 400
    });
    expect(queries.at(-1)).toContain("WHERE EXISTS");
  });

  it("queues an input only while its worker run is still active", async () => {
    const pool = {
      async query(sql: string) {
        if (sql.includes("FROM agent_threads")) return { rows: [{}] };
        if (sql.includes("FROM task_runs") && sql.includes("active_turns")) {
          return { rows: [{ id: "run-id", kind: "worker" }] };
        }
        if (sql.includes("INSERT INTO agent_turn_inputs")) {
          return { rows: [{ id: "input-id", message: "continue" }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }
    } as unknown as DbPool;

    await expect(queueAgentTurnInput(pool, "thread-id", "continue")).resolves.toEqual({
      input: { id: "input-id", message: "continue" }
    });
  });
});

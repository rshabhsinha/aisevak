import type { DbPool } from "@aisevak/core";
import { expect, it } from "vitest";
import { enqueueDueSchedule } from "./index.js";

it("queues a projectless schedule with a recoverable immutable workspace snapshot", async () => {
  let snapshot: unknown[] | undefined;
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM schedules") && sql.includes("JOIN agents")) return { rows: [{
      id: "schedule", title: "Cleanup", prompt: "inspect", agent_id: "agent", schedule_kind: "interval",
      next_run_at: new Date(), interval_seconds: 86400, model: "swe-2-high", model_options: [], provider_instance_id: "devin-local"
    }] };
    if (sql.includes("INSERT INTO tasks")) return { rows: [{ id: "task", number: 1 }] };
    if (sql.includes("INSERT INTO coordination_threads")) return { rows: [{ id: "coordination" }] };
    if (sql.includes("INSERT INTO agent_threads")) return { rows: [{ id: "thread", model: "swe-2-high", model_options: [], ownership_generation: 0 }] };
    if (sql.includes("INSERT INTO thread_messages") || sql.includes("INSERT INTO message_deliveries")) return { rows: [{ id: "message" }] };
    if (sql.includes("INSERT INTO dispatcher_runs")) { snapshot = params; return { rows: [{ id: "run" }] }; }
    return { rows: [] };
  };
  const pool = { connect: async () => ({ query, release() {} }), query } as unknown as DbPool;
  await enqueueDueSchedule(pool);
  expect(snapshot?.slice(3,6)).toEqual(["", "projectless", "projectless"]);
  expect(snapshot?.[10]).toBe("swe-2-high");
});

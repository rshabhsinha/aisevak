import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { finishMessageDelivery } from "./index.js";

function pool(assignmentStatus: string | null) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("SELECT delivery.status")) {
      return { rows: [{ status: "running", attempt_count: 1, presented_at: null, agent_thread_id: null, agent_thread_generation: 0, ownership_generation: null, provider_thread_id: null }] };
    }
    if (sql.includes("JOIN task_assignments ON task_assignments.id = message_deliveries.assignment_id")) {
      return { rows: assignmentStatus ? [{ status: assignmentStatus }] : [] };
    }
    if (sql.includes("INSERT INTO dispatcher_runs")) return { rows: [{ id: "retry-run" }] };
    return { rows: [] };
  };
  const client = { query, release() {} };
  return { pool: { query, async connect() { return client; } } as unknown as DbPool, queries };
}

const job = { id: "run", message_delivery_id: "delivery", assignment_id: "assignment" };
const deliveryUpdate = (queries: Array<{ sql: string; params?: unknown[] }>) =>
  queries.find((q) => q.sql.includes("UPDATE message_deliveries") && q.params?.[0] === "delivery");

describe("delivery settled by its assignment", () => {
  it("completes the delivery without a retry when the assignee completed the assignment before the turn failed", async () => {
    const { pool: db, queries } = pool("completed");

    await finishMessageDelivery(db, job, "failed", "ACP session closed");

    expect(queries.some((q) => q.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(deliveryUpdate(queries)?.params).toEqual(["delivery", "completed", null]);
  });

  it.each(["blocked", "cancelled"])("fails without a retry when the assignment was %s", async (status) => {
    const { pool: db, queries } = pool(status);

    await finishMessageDelivery(db, job, "failed", "boom");

    expect(queries.some((q) => q.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(deliveryUpdate(queries)?.params?.[1]).toBe("failed");
    expect(String(deliveryUpdate(queries)?.params?.[2])).toContain(`Assignment was ${status}`);
  });

  it("still retries a failed turn while its assignment is open", async () => {
    const { pool: db, queries } = pool("running");

    await finishMessageDelivery(db, job, "failed", "transient");

    expect(queries.some((q) => q.sql.includes("INSERT INTO dispatcher_runs"))).toBe(true);
  });
});

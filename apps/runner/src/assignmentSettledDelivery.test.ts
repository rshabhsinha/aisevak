import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { finishAgentTurnInput, finishMessageDelivery } from "./index.js";

type Entry = { sql: string; params?: unknown[] };

function pool(assignment: { status: string; superseded?: boolean } | null) {
  const queries: Entry[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("SELECT delivery.status")) {
      return { rows: [{ status: "running", attempt_count: 1, presented_at: null, agent_thread_id: null, agent_thread_generation: 0, ownership_generation: null, provider_thread_id: null }] };
    }
    if (sql.includes("JOIN task_assignments ON task_assignments.id = delivery.assignment_id")) {
      return { rows: assignment ? [{ assignment_status: assignment.status, superseded: assignment.superseded ?? false }] : [] };
    }
    if (sql.includes("SELECT delivery.assignment_id")) {
      return { rows: [{ assignment_id: "assignment", superseded: assignment?.superseded ?? false }] };
    }
    if (sql.includes("UPDATE agent_turn_inputs") && sql.includes("RETURNING message_delivery_id")) {
      return { rows: [{ message_delivery_id: "delivery" }] };
    }
    if (sql.includes("INSERT INTO dispatcher_runs")) return { rows: [{ id: "retry-run" }] };
    return { rows: [] };
  };
  const client = { query, release() {} };
  return { pool: { query, async connect() { return client; } } as unknown as DbPool, queries };
}

const job = { id: "run", message_delivery_id: "delivery", assignment_id: "assignment" };
const deliveryUpdate = (queries: Entry[]) =>
  queries.find((q) => q.sql.includes("UPDATE message_deliveries") && q.params?.[0] === "delivery");
const retried = (queries: Entry[]) => queries.some((q) => q.sql.includes("INSERT INTO dispatcher_runs"));
const assignmentChanged = (queries: Entry[]) =>
  queries.some((q) => q.sql.includes("UPDATE task_assignments") && q.sql.includes("SET status = $2"));

describe("delivery settled by its assignment", () => {
  it("completes the delivery without a retry when the assignee completed the assignment before the turn failed", async () => {
    const { pool: db, queries } = pool({ status: "completed" });

    await finishMessageDelivery(db, job, "failed", "ACP session closed");

    expect(retried(queries)).toBe(false);
    expect(deliveryUpdate(queries)?.params).toEqual(["delivery", "completed", null]);
  });

  it.each(["blocked", "cancelled"])("fails without a retry when the assignment was %s", async (status) => {
    const { pool: db, queries } = pool({ status });

    await finishMessageDelivery(db, job, "cancelled", "boom");

    expect(retried(queries)).toBe(false);
    expect(deliveryUpdate(queries)?.params?.[1]).toBe("failed");
    expect(String(deliveryUpdate(queries)?.params?.[2])).toContain(`Assignment was ${status}`);
    expect(assignmentChanged(queries)).toBe(false);
    // The assignment already decided the outcome: no delivery.failed notice.
    expect(deliveryUpdate(queries)?.sql).toContain("failure_notified_at = now()");
  });

  it("does not retry or touch the assignment when an owner retry superseded the delivery", async () => {
    // Block -> owner retry (assignment queued again, new delivery) -> the old
    // turn then fails or is stopped.
    for (const status of ["failed", "cancelled"] as const) {
      const { pool: db, queries } = pool({ status: "queued", superseded: true });

      await finishMessageDelivery(db, job, status, "old turn ended");

      expect(retried(queries)).toBe(false);
      expect(assignmentChanged(queries)).toBe(false);
      expect(String(deliveryUpdate(queries)?.params?.[2])).toContain("Superseded by a newer delivery");
    }
  });

  it("still retries a failed turn while its assignment is open", async () => {
    const { pool: db, queries } = pool({ status: "running" });

    await finishMessageDelivery(db, job, "failed", "transient");

    expect(retried(queries)).toBe(true);
  });

  it("settles an injected input's delivery by its completed assignment", async () => {
    const { pool: db, queries } = pool({ status: "completed" });

    await finishAgentTurnInput(db, { id: "input", message: "follow-up", messageDeliveryId: "delivery" }, "turn errored");

    expect(deliveryUpdate(queries)?.params).toEqual(["delivery", "completed", null]);
    expect(assignmentChanged(queries)).toBe(false);
  });

  it("blocks the assignment when an older turn fails after a newer delivery already finished", async () => {
    // superseded=false models: the newer delivery exists but is completed.
    const { pool: db, queries } = pool({ status: "running", superseded: false });

    await finishMessageDelivery(db, job, "cancelled", "old turn stopped");

    expect(retried(queries)).toBe(false);
    expect(assignmentChanged(queries)).toBe(true);
  });

  it("only treats a newer pending delivery as superseding", async () => {
    const { pool: db, queries } = pool({ status: "running", superseded: false });
    await finishMessageDelivery(db, job, "failed", "x");
    const check = queries.find((q) => q.sql.includes("newer.assignment_id = delivery.assignment_id"));
    expect(check?.sql).toContain("newer.status IN ('queued', 'retrying', 'running')");
  });
});

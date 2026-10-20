import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import { recoverInterruptedCoordinationRuns, recoverInterruptedWorkerRuns, redeliverInterruptedRun } from "./index.js";
import { INTERRUPTED_PREAMBLE } from "./runLeases.js";

type Entry = { sql: string; params?: unknown[] };

afterEach(() => { delete process.env.AISEVAK_COORDINATION_LEGACY; });

function fakePool(handler: (sql: string, params?: unknown[]) => { rows: any[] } | undefined) {
  const queries: Entry[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return handler(sql.trim(), params) ?? { rows: [] };
  };
  const client = { query, release() {} } as unknown as Pick<DbPool, "query"> & { release(): void };
  return { pool: { query, async connect() { return client; } } as unknown as DbPool, client, queries };
}

const interruptedDelivery = {
  status: "running",
  presented_at: new Date(),
  launch_attempted_at: new Date(),
  interrupted_count: 0,
  max_attempts: 3,
  agent_thread_id: "session",
  agent_thread_generation: 4,
  ownership_generation: 4,
  provider_thread_id: "provider-thread"
};

function redeliveryHandler(delivery: Record<string, unknown> = interruptedDelivery, presentedInputs: any[] = []) {
  return (sql: string) => {
    if (sql.includes("delivery.interrupted_count") && sql.includes("FOR UPDATE OF delivery")) return { rows: [delivery] };
    if (sql.startsWith("SELECT prompt FROM dispatcher_runs")) return { rows: [{ prompt: "Review ASSIGNMENT-70." }] };
    if (sql.includes("INSERT INTO dispatcher_runs")) return { rows: [{ id: "redelivery-run" }] };
    if (sql.includes("FROM agent_turn_inputs input") && sql.includes("input.status = 'delivering'")) return { rows: presentedInputs };
    return undefined;
  };
}

describe("interrupted turn redelivery", () => {
  it("queues the same delivery on a fresh run in the same session with an interrupted note", async () => {
    const { client, queries } = fakePool(redeliveryHandler());

    await expect(redeliverInterruptedRun(client, "interrupted-run", "delivery", "interrupted")).resolves.toBe(true);

    const insert = queries.find((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"))!;
    expect(insert.sql).toContain("'redelivery'");
    expect(insert.params?.slice(0, 3)).toEqual(["interrupted-run", "delivery", "provider-thread"]);
    expect(String(insert.params?.[3])).toMatch(new RegExp(`^${INTERRUPTED_PREAMBLE.slice(0, 40)}`));
    expect(String(insert.params?.[3])).toContain("Review ASSIGNMENT-70.");
    const requeue = queries.find((entry) => entry.sql.includes("interrupted_count = interrupted_count + 1"))!;
    expect(requeue.sql).toContain("status = 'retrying'");
    expect(requeue.params?.[0]).toBe("delivery");
    // The assignment is not touched: it stays running.
    expect(queries.some((entry) => entry.sql.includes("UPDATE task_assignments"))).toBe(false);
  });

  it("moves messages the interrupted turn had presented onto the fresh run", async () => {
    const { client, queries } = fakePool(redeliveryHandler(interruptedDelivery, [
      { id: "input-1", message_delivery_id: "ping-delivery", message: "Are you still on it?" }
    ]));

    await redeliverInterruptedRun(client, "interrupted-run", "delivery", "interrupted");

    const moved = queries.find((entry) => entry.sql.includes("UPDATE agent_turn_inputs") && entry.params?.[0] === "input-1")!;
    expect(moved.sql).toContain("status = 'queued'");
    expect(moved.params?.[1]).toBe("redelivery-run");
    expect(String(moved.params?.[2])).toContain("Are you still on it?");
    expect(String(moved.params?.[2]).startsWith(INTERRUPTED_PREAMBLE)).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("interrupted_count = interrupted_count + 1") && entry.params?.[0] === "ping-delivery")).toBe(true);
  });

  it.each([
    ["the attempt limit is reached", { interrupted_count: 3 }],
    ["thread ownership moved", { ownership_generation: 5 }],
    ["the agent thread is archived", { agent_thread_id: null, ownership_generation: null }],
    ["the delivery is already settled", { status: "completed" }],
    ["the turn never launched its prompt", { presented_at: null, launch_attempted_at: null }]
  ])("refuses when %s", async (_label, change) => {
    const { client, queries } = fakePool(redeliveryHandler({ ...interruptedDelivery, ...change }));
    await expect(redeliverInterruptedRun(client, "interrupted-run", "delivery", "interrupted")).resolves.toBe(false);
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
  });
});

describe("lease-gated restart recovery", () => {
  function recoveryHandler(extra: (sql: string) => { rows: any[] } | undefined = () => undefined) {
    return (sql: string) => {
      if (sql.startsWith("SELECT id, status::text, message_delivery_id")) {
        return { rows: [{ id: "interrupted-run", status: "running", message_delivery_id: "delivery" }] };
      }
      if (sql.startsWith("SELECT message_delivery_id, status::text")) return { rows: [{ message_delivery_id: "delivery", status: "running" }] };
      // Presented to an established session, so the never-presented retry does not apply.
      if (sql.includes("source_run.launch_attempted_at") && !sql.includes("interrupted_count")) return { rows: [{ status: "running", attempt_count: 1, presented_at: new Date(), launch_attempted_at: new Date() }] };
      return extra(sql) ?? redeliveryHandler()(sql);
    };
  }

  it("redelivers a presented delivery instead of failing it and blocking the assignment", async () => {
    const { pool, queries } = fakePool(recoveryHandler());

    await recoverInterruptedCoordinationRuns(pool, { runnerId: "runner-a", boot: true });

    const scan = queries.find((entry) => entry.sql.trim().startsWith("SELECT id, status::text, message_delivery_id"))!;
    expect(scan.sql).toContain("runner_id = $1 OR dispatcher_runs.lease_expires_at < now()");
    expect(scan.params).toEqual(["runner-a"]);
    expect(queries.some((entry) => entry.sql.includes("'redelivery'"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("UPDATE task_assignments") && entry.sql.includes("SET status = $2"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("UPDATE message_deliveries") && entry.sql.includes("SET status = 'failed'") && entry.params?.[0] === "delivery")).toBe(false);
  });

  it("fails and blocks as before in legacy mode", async () => {
    process.env.AISEVAK_COORDINATION_LEGACY = "1";
    const { pool, queries } = fakePool(recoveryHandler((sql) =>
      sql.includes("SELECT delivery.assignment_id") ? { rows: [{ assignment_id: "assignment", superseded: false }] } : undefined
    ));

    await recoverInterruptedCoordinationRuns(pool, { runnerId: "runner-a", boot: true });

    expect(queries.some((entry) => entry.sql.includes("'redelivery'"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("UPDATE task_assignments") && entry.params?.[1] === "blocked")).toBe(true);
  });

  it("does not repair delivery crash windows during a sweep", async () => {
    const { pool, queries } = fakePool(() => undefined);

    await recoverInterruptedCoordinationRuns(pool, { runnerId: "runner-a", boot: false });

    const scan = queries.find((entry) => entry.sql.trim().startsWith("SELECT id, status::text, message_delivery_id"))!;
    expect(scan.sql).toContain("dispatcher_runs.runner_id <> $1 AND dispatcher_runs.lease_expires_at < now()");
    expect(queries.some((entry) => entry.sql.includes("SELECT dispatcher_runs.id AS run_id"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("SELECT agent_turn_inputs.id AS input_id"))).toBe(false);
  });

  it("terminalizes worker turns a stopped runner left running", async () => {
    const { pool, queries } = fakePool((sql) => {
      if (sql.startsWith("SELECT id, status::text, agent_thread_id")) return { rows: [{ id: "worker-run", status: "running", agent_thread_id: "session" }] };
      if (sql.includes("UPDATE task_runs") && sql.includes("RETURNING id")) return { rows: [{ id: "worker-run" }] };
      return undefined;
    });

    await recoverInterruptedWorkerRuns(pool, { runnerId: "runner-a", boot: true });

    const update = queries.find((entry) => entry.sql.includes("UPDATE task_runs"))!;
    expect(update.params?.slice(0, 3)).toEqual(["worker-run", "failed", "The worker turn was interrupted when the runner stopped"]);
    expect(update.sql).toContain("task_runs.runner_id = $4");
    expect(queries.some((entry) => entry.sql.includes("UPDATE tasks"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("UPDATE agent_threads"))).toBe(true);
  });
});

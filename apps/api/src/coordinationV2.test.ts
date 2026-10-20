import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import {
  coordinationPrompt,
  DELIVERY_FAILED_TYPE,
  deliveryFailedNotice,
  deliveryState,
  notifyFailedDeliveries,
  participantState,
  resolveThreadRef,
  threadStatus,
  type Queryable
} from "./coordination.js";

type Handler = (sql: string, params?: unknown[]) => { rows: any[] } | undefined;

function fakeQueryable(handler: Handler): { queryable: Queryable; queries: Array<{ sql: string; params?: unknown[] }> } {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return handler(sql, params) ?? { rows: [] };
    }
  } as unknown as Queryable;
  return { queryable, queries };
}

const COORDINATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_THREAD_ID = "22222222-2222-4222-8222-222222222222";

describe("resolveThreadRef", () => {
  it("resolves THREAD-n and bare numbers by number", async () => {
    const { queryable, queries } = fakeQueryable((sql) =>
      sql.includes("FROM coordination_threads WHERE number") ? { rows: [{ id: COORDINATION_ID }] } : undefined
    );
    await expect(resolveThreadRef(queryable, "THREAD-12")).resolves.toBe(COORDINATION_ID);
    await expect(resolveThreadRef(queryable, "12")).resolves.toBe(COORDINATION_ID);
    expect(queries.map((query) => query.params?.[0])).toEqual([12, 12]);
  });

  it("resolves a task ref to the task's coordination thread", async () => {
    const { queryable } = fakeQueryable((sql) =>
      sql.includes("FROM tasks WHERE number") ? { rows: [{ coordination_thread_id: COORDINATION_ID }] } : undefined
    );
    await expect(resolveThreadRef(queryable, "TASK-1034")).resolves.toBe(COORDINATION_ID);
  });

  it("maps an agent thread id from the UI to its coordination thread instead of 404ing", async () => {
    const { queryable } = fakeQueryable((sql) =>
      sql.includes("FROM agent_threads") ? { rows: [{ coordination_thread_id: COORDINATION_ID, task_coordination_thread_id: null }] } : undefined
    );
    await expect(resolveThreadRef(queryable, AGENT_THREAD_ID)).resolves.toBe(COORDINATION_ID);
  });

  it("falls back to the task's coordination thread for a task-bound agent thread", async () => {
    const { queryable } = fakeQueryable((sql) =>
      sql.includes("FROM agent_threads") ? { rows: [{ coordination_thread_id: null, task_coordination_thread_id: COORDINATION_ID }] } : undefined
    );
    await expect(resolveThreadRef(queryable, AGENT_THREAD_ID)).resolves.toBe(COORDINATION_ID);
  });

  it("explains that a direct chat thread has no coordination thread", async () => {
    const { queryable } = fakeQueryable((sql) =>
      sql.includes("FROM agent_threads") ? { rows: [{ coordination_thread_id: null, task_coordination_thread_id: null }] } : undefined
    );
    await expect(resolveThreadRef(queryable, AGENT_THREAD_ID)).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining("direct chat") });
  });

  it("rejects malformed refs without sending them to a uuid cast", async () => {
    const { queryable, queries } = fakeQueryable(() => undefined);
    await expect(resolveThreadRef(queryable, "not-a-thread")).rejects.toMatchObject({ statusCode: 400 });
    expect(queries).toHaveLength(0);
  });
});

describe("deliveryState", () => {
  it.each([
    [null, null, "none"],
    ["queued", null, "queued"],
    ["retrying", null, "queued"],
    ["running", null, "delivering"],
    ["running", new Date(), "presented"],
    ["completed", new Date(), "delivered"],
    ["failed", null, "failed"]
  ])("maps %s (presented=%s) to %s", (status, presentedAt, state) => {
    expect(deliveryState({ status, presentedAt }).state).toBe(state);
  });

  it("shows the error only when it explains the current state", () => {
    expect(deliveryState({ status: "failed", error: "runner stopped" }).error).toBe("runner stopped");
    expect(deliveryState({ status: "retrying", error: "transient" }).error).toBe("transient");
    expect(deliveryState({ status: "completed", error: "old" }).error).toBeNull();
  });
});

describe("participantState", () => {
  const base = { activeTurn: false, queuedTurn: false, pendingMessages: 0, waitingOn: [], blockedReason: null };
  it("orders running > queued > blocked > waiting > idle", () => {
    expect(participantState({ ...base, activeTurn: true, pendingMessages: 2, blockedReason: "x" })).toBe("running");
    expect(participantState({ ...base, pendingMessages: 1, blockedReason: "x" })).toBe("queued");
    expect(participantState({ ...base, queuedTurn: true })).toBe("queued");
    expect(participantState({ ...base, blockedReason: "x", waitingOn: ["ASSIGNMENT-1"] })).toBe("blocked");
    expect(participantState({ ...base, waitingOn: ["ASSIGNMENT-1"] })).toBe("waiting");
    expect(participantState(base)).toBe("idle");
  });
});

describe("threadStatus", () => {
  it("reports each participant's state, pending inbox, and what the owner waits on", async () => {
    const { queryable } = fakeQueryable((sql) => {
      if (sql.includes("SELECT coordination_threads.*")) {
        return { rows: [{ id: COORDINATION_ID, number: 7, title: "Populate LM317", status: "active", task_id: "task", primary_agent_id: "owner", callback_agent_id: null }] };
      }
      if (sql.includes("FROM tasks WHERE id")) return { rows: [{ id: "task", number: 1034, status: "open", agent_id: "owner" }] };
      if (sql.includes("FROM thread_participants")) {
        return { rows: [
          { agent_id: "owner", agent_name: "Populator", role: "owner" },
          { agent_id: "owner", agent_name: "Populator", role: "primary" },
          { agent_id: "reviewer", agent_name: "Reviewer", role: "assignee" }
        ] };
      }
      if (sql.includes("FROM agent_threads")) {
        return { rows: [
          { agent_id: "owner", agent_thread_id: "owner-session", last_activity_at: new Date(0), archived_at: null, active_kind: null, active_id: null, active_started_at: null, queued_turns: 0 },
          { agent_id: "reviewer", agent_thread_id: "reviewer-session", last_activity_at: new Date(0), archived_at: null, active_kind: "coordination", active_id: "run", active_started_at: new Date(0), queued_turns: 0 }
        ] };
      }
      if (sql.includes("GROUP BY message_deliveries.recipient_agent_id")) return { rows: [{ recipient_agent_id: "reviewer", pending: 1 }] };
      if (sql.includes("DISTINCT ON")) return { rows: [] };
      if (sql.includes("FROM task_assignments")) {
        return { rows: [{ number: 70, assigned_agent_id: "reviewer", created_by_agent_id: "owner", status: "running" }] };
      }
      return undefined;
    });
    const status = await threadStatus(queryable, COORDINATION_ID);
    expect(status.thread).toMatchObject({ key: "THREAD-7", task: { key: "TASK-1034", status: "open" } });
    const owner = status.participants.find((item: any) => item.agent.name === "Populator");
    const reviewer = status.participants.find((item: any) => item.agent.name === "Reviewer");
    expect(owner).toMatchObject({ state: "waiting", waitingOn: ["ASSIGNMENT-70"], roles: ["owner", "primary"], agentThreadId: "owner-session" });
    expect(reviewer).toMatchObject({ state: "running", pendingMessages: 1, currentTurn: { kind: "coordination", id: "run" } });
  });
});

describe("delivery failure notices", () => {
  const failed = {
    delivery_id: "delivery",
    error: "The coordination turn was interrupted when the runner stopped",
    attempt_count: 1,
    assignment_id: "assignment",
    assignment_number: 70,
    assignment_status: "blocked",
    message_id: "message",
    message_number: 812,
    message_type: "assignment.created",
    thread_id: COORDINATION_ID,
    thread_number: 7,
    sender_agent_id: "orchestrator",
    recipient_agent_id: "reviewer",
    recipient_name: "Reviewer"
  };

  it("names the message, reason, assignment, and retry command", () => {
    const body = deliveryFailedNotice(failed);
    expect(body).toContain("MESSAGE-812 [assignment.created] on THREAD-7 to Reviewer was not delivered after 1 attempt.");
    expect(body).toContain("Reason: The coordination turn was interrupted when the runner stopped");
    expect(body).toContain("ASSIGNMENT-70 is now blocked.");
    expect(body).toContain("aisevak assignments retry ASSIGNMENT-70");
  });

  it("suggests resending a plain message", () => {
    const body = deliveryFailedNotice({ ...failed, assignment_id: null, assignment_number: null, assignment_status: null, attempt_count: 3 });
    expect(body).toContain("after 3 attempts");
    expect(body).toContain("aisevak threads send THREAD-7 --to AGENT-Reviewer --body-stdin");
  });

  function sweepPool(rows: any[], options: { failQueue?: boolean } = {}) {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("FROM message_deliveries delivery") && sql.includes("SKIP LOCKED")) return { rows };
        if (sql.includes("INSERT INTO thread_messages")) return { rows: [{ id: "notice" }] };
        if (options.failQueue && sql.includes("INSERT INTO message_deliveries")) throw new Error("thread archived");
        return { rows: [] };
      },
      release() {}
    };
    return { pool: { connect: async () => client } as unknown as DbPool, queries };
  }

  it("skips notices for platform senders, self-sends, and notices themselves, but marks every row", async () => {
    const { pool, queries } = sweepPool([
      { ...failed, delivery_id: "a", sender_agent_id: null },
      { ...failed, delivery_id: "b", sender_agent_id: "reviewer" },
      { ...failed, delivery_id: "c", message_type: DELIVERY_FAILED_TYPE }
    ]);
    await expect(notifyFailedDeliveries(pool, "/managed")).resolves.toBe(0);
    expect(queries.some((query) => query.sql.includes("INSERT INTO thread_messages"))).toBe(false);
    const marked = queries.filter((query) => query.sql.includes("SET failure_notified_at = now()")).map((query) => query.params?.[0]);
    expect(marked).toEqual(["a", "b", "c"]);
  });

  it("sends the notice to the original sender as a platform message on the same thread", async () => {
    const { pool, queries } = sweepPool([failed]);
    await notifyFailedDeliveries(pool, "/managed");
    const insert = queries.find((query) => query.sql.includes("INSERT INTO thread_messages"))!;
    // thread, sender, recipient, parent, type
    expect(insert.params?.slice(0, 5)).toEqual([COORDINATION_ID, null, "orchestrator", "message", DELIVERY_FAILED_TYPE]);
    const delivery = queries.find((query) => query.sql.includes("INSERT INTO message_deliveries"))!;
    expect(delivery.params?.slice(0, 2)).toEqual(["notice", "orchestrator"]);
  });

  it("rolls back a notice that cannot be queued and still marks the row", async () => {
    const { pool, queries } = sweepPool([failed], { failQueue: true });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await expect(notifyFailedDeliveries(pool, "/managed")).resolves.toBe(0);
    } finally {
      console.error = original;
    }
    expect(queries.some((query) => query.sql === "ROLLBACK TO SAVEPOINT delivery_failure_notice")).toBe(true);
    expect(queries.some((query) => query.sql.includes("SET failure_notified_at = now()"))).toBe(true);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(errors).toHaveLength(1);
  });

  it("frames the notice as a platform notice rather than new work", () => {
    const prompt = coordinationPrompt(
      { number: 7, title: "Populate", description: "", purpose: "p", task_id: "task", completion_instructions: "" },
      { name: "Orchestrator", description: "Routes work." },
      { message_type: DELIVERY_FAILED_TYPE, sender_agent_name: null, body: deliveryFailedNotice(failed) },
      []
    );
    expect(prompt).toContain("This is a platform notice");
    expect(prompt).toContain("Do not complete or block THREAD-7");
    expect(prompt).not.toContain("Use aisevak assignments create TASK-n");
  });
});

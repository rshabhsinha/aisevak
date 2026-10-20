import { describe, expect, it } from "vitest";
import { assertThreadCanFinalize, cancelPendingAssignmentDelivery, coordinationIncrementalPrompt, coordinationPrompt, reopenTask } from "./coordination.js";
import type { DbPool } from "@aisevak/core";

const thread = {
  number: 12,
  title: "Review parser",
  description: "Focused review",
  purpose: "Check the parser change.",
  status: "active",
  primary_agent_id: "child-agent",
  primary_agent_name: "Reviewer",
  callback_agent_name: "Builder",
  created_by_agent_name: "Builder",
  completion_instructions: "aisevak threads complete THREAD-12 --summary-stdin",
  origin_thread_id: null
};

const recipient = { name: "Reviewer", description: "Reviews changes." };

describe("coordination delivery prompts", () => {
  it("asks a triggered agent to send one final response", () => {
    const prompt = coordinationPrompt(thread, recipient, {
      message_type: "handoff",
      sender_agent_name: "Builder",
      body: "Review this parser."
    }, []);

    expect(prompt).toContain("Completion instruction: aisevak threads complete THREAD-12 --summary-stdin");
    expect(prompt).toContain("send the completed work back to the triggering agent");
    expect(prompt).toContain("Triggered agent: Reviewer");
    expect(prompt).toContain("Result recipient: Builder");
  });

  it.each(["completion", "blocked"])("treats %s as a result notification", (messageType) => {
    const prompt = coordinationPrompt(thread, { name: "Builder", description: "Implements changes." }, {
      message_type: messageType,
      sender_agent_name: "Reviewer",
      body: "Final result from Reviewer."
    }, []);

    expect(prompt).toContain(`This is a final ${messageType} response from the agent you triggered.`);
    expect(prompt).toContain("Do not complete or block THREAD-12");
    expect(prompt).toContain("aisevak threads send THREAD-12 --body-stdin");
    expect(prompt).not.toContain("Completion instruction:");
  });

  it("uses only the new message body after a provider session is established", () => {
    const prompt = coordinationIncrementalPrompt({ body: "Follow up with the requested checks." });
    expect(prompt).toContain("Live job envelope: task=none");
    expect(prompt).toContain("Follow up with the requested checks.");
  });

  it("keeps a live assignment envelope on fresh and incremental prompts", () => {
    const envelope = {
      taskId: "task-id",
      taskRef: "TASK-34",
      workScope: "project:parser",
      workKey: "parser-v1",
      parentTaskId: null,
      parentTaskRef: null,
      assignmentId: "assignment-id",
      assignmentRef: "ASSIGNMENT-7",
      assignmentKey: "parser-review",
      assignmentStatus: "running",
      attempt: 2,
      limits: { maxActiveAssignments: 5, maxActiveChildren: 5, maxChildDepth: 3, maxAssignmentAttempts: 3 },
      activeAssignments: 1,
      activeChildren: 0,
      safetyMode: "enforce",
      shutdownState: "running" as const,
      coordinationThreadId: "coordination-thread",
      agentThreadId: "agent-thread",
      providerThreadId: "provider-thread"
    };
    const fresh = coordinationPrompt(thread, recipient, {
      message_type: "handoff",
      sender_agent_name: "Builder",
      body: "Review this parser."
    }, [], envelope);
    expect(fresh).toContain("project:parser/parser-v1");
    expect(fresh).toContain("ASSIGNMENT-7");
    expect(fresh).toContain("coordination-thread=coordination-thread");
    expect(fresh).toContain("assignments complete ASSIGNMENT-7");
    expect(coordinationIncrementalPrompt({ body: "Follow up" }, envelope)).toContain("provider-session=provider-thread");
  });
});

describe("thread finalization policy", () => {
  it("allows the triggered agent to finalize an active thread", () => {
    expect(() => assertThreadCanFinalize(thread, "child-agent")).not.toThrow();
  });

  it("rejects finalization by the triggering agent", () => {
    expect(() => assertThreadCanFinalize(thread, "parent-agent")).toThrowError(
      /Only the agent triggered on THREAD-12/
    );
  });

  it.each(["completed", "blocked"])("rejects another finalization after the thread is %s", (status) => {
    expect(() => assertThreadCanFinalize({ ...thread, status }, "child-agent")).toThrowError(
      new RegExp(`THREAD-12 is already ${status}`)
    );
  });
});

describe("task reopening ownership", () => {
  it("locks and re-reads the task before creating its reopening delivery", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const task = {
      id: "task-id",
      number: 42,
      title: "Transferred task",
      agent_id: "new-agent",
      coordination_thread_id: "thread-id",
      body: "",
      content_preview: "",
      content_total_bytes: 0
    };
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("SELECT id FROM tasks WHERE id = $1 FOR UPDATE")) return { rows: [{ id: "task-id" }] };
      if (sql.includes("SELECT tasks.*")) return { rows: [task] };
      if (sql.includes("INSERT INTO thread_messages")) return { rows: [{ id: "message-id" }] };
      if (sql.includes("UPDATE tasks") || sql.includes("UPDATE coordination_threads")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await reopenTask(pool, {
      taskId: "task-id",
      senderAgentId: "new-agent",
      capabilities: ["tasks:update"],
      body: "Please continue after the transfer.",
      managedRoot: "/managed"
    });

    const firstApplicationQuery = queries.find(({ sql }) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(sql));
    expect(firstApplicationQuery?.sql).toContain("SELECT id FROM tasks WHERE id = $1 FOR UPDATE");
    const message = queries.find(({ sql }) => sql.includes("INSERT INTO thread_messages"));
    expect(message?.params).toEqual([
      "thread-id",
      "new-agent",
      "new-agent",
      null,
      "task.reopened",
      "Please continue after the transfer.",
      null
    ]);
  });

  it("rejects an old provider token after the task has been transferred", async () => {
    const task = {
      id: "task-id",
      number: 42,
      title: "Transferred task",
      agent_id: "new-agent",
      coordination_thread_id: "thread-id",
      body: "",
      content_preview: "",
      content_total_bytes: 0
    };
    const query = async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("SELECT id FROM tasks WHERE id = $1 FOR UPDATE")) return { rows: [{ id: "task-id" }] };
      if (sql.includes("SELECT tasks.*")) return { rows: [task] };
      throw new Error(`Unexpected query: ${sql}`);
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await expect(reopenTask(pool, {
      taskId: "task-id",
      senderAgentId: "old-agent",
      capabilities: ["tasks:update"],
      body: "stale reopen",
      managedRoot: "/managed"
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  function childTaskPool(queries: Array<{ sql: string; params?: unknown[] }>) {
    const task = {
      id: "task-id",
      number: 1034,
      title: "Populate component",
      agent_id: "populator",
      parent_task_agent_id: "orchestrator",
      coordination_thread_id: "thread-id",
      status: "completed",
      body: "",
      content_preview: "",
      content_total_bytes: 0
    };
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("SELECT id FROM tasks WHERE id = $1 FOR UPDATE")) return { rows: [{ id: "task-id" }] };
      if (sql.includes("SELECT tasks.*")) return { rows: [task] };
      if (sql.includes("INSERT INTO thread_messages")) return { rows: [{ id: "message-id" }] };
      // A settled delivery row stops queueDelivery before it launches a turn.
      if (sql.includes("INSERT INTO message_deliveries")) return { rows: [{ id: "delivery-id", status: "completed" }] };
      return { rows: [] };
    };
    const client = { query, release() {} };
    return { query, async connect() { return client; } } as unknown as DbPool;
  }

  it("lets the parent task's owner reopen a child it created and wakes the child's owner", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    await reopenTask(childTaskPool(queries), {
      taskId: "task-id",
      senderAgentId: "orchestrator",
      capabilities: ["tasks:create-child"],
      body: "TASK-1034 closed early; rerun request-review with its original key.",
      managedRoot: "/managed"
    });

    const reopen = queries.find(({ sql }) => sql.includes("UPDATE tasks SET status = 'open'"));
    expect(reopen?.params).toEqual(["task-id"]);
    const message = queries.find(({ sql }) => sql.includes("INSERT INTO thread_messages"));
    expect(message?.params?.slice(0, 2)).toEqual(["thread-id", "orchestrator"]);
    expect(message?.params?.[2]).toBe("populator");
    const delivery = queries.find(({ sql }) => sql.includes("INSERT INTO message_deliveries"));
    expect(delivery?.params?.slice(0, 2)).toEqual(["message-id", "populator"]);
  });

  it("refuses a parent owner without a task capability", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    await expect(reopenTask(childTaskPool(queries), {
      taskId: "task-id",
      senderAgentId: "orchestrator",
      capabilities: ["tasks:read"],
      managedRoot: "/managed"
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(queries.some(({ sql }) => sql.includes("UPDATE tasks SET status = 'open'"))).toBe(false);
  });

  it("still refuses an unrelated agent", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    await expect(reopenTask(childTaskPool(queries), {
      taskId: "task-id",
      senderAgentId: "someone-else",
      capabilities: ["tasks:update", "tasks:create-child"],
      managedRoot: "/managed"
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("coordination prompt de-duplication", () => {
  // Mirrors THREAD-954: every controller message restates the same job header
  // and source item, and the thread purpose is the opening task body.
  const header = [
    "Use $component-library-workflow and $component-library-populator. This is the authorized autonomous campaign.",
    "Immutable job_id: c90c20c4051e4ae8bfd0044cbdebf5cc",
    "Work directory: /srv/aisevak/component-library/work/c90c20c4051e4ae8bfd0044cbdebf5cc",
    "Assigned source item:",
    `{"aliasesFromBacklog": [], "category": "Power", "title": "ST USBLC6-2SC6 USB ESD protection array", "workItemId": "addition:usblc6-2sc6"}`
  ].join("\n");
  const taskBody = `Task TASK-1004: Populate ST USBLC6-2SC6\n\n${header}\nYou own this component task. Start this job, research and build it.`;
  const orchestrator = { id: "orchestrator", name: "Orchestrator", description: "Runs the queue." };
  const populator = { id: "populator", name: "Populator", description: "Builds components." };
  const msg = (id: string, number: number, from: any, to: any, type: string, body: string) => ({
    id, number, message_type: type, body,
    sender_agent_id: from.id, sender_agent_name: from.name,
    recipient_agent_id: to.id, recipient_agent_name: to.name
  });
  const reviewer = { id: "reviewer", name: "Reviewer" };
  const created = msg("m1", 4420, orchestrator, populator, "task.created", taskBody);
  const review = msg("m2", 4464, populator, reviewer, "assignment.created",
    `ASSIGNMENT-59 (review:job:2:4) for TASK-1004:\n\n${header}\nReview exact revision 1.1.1:review-4. Use controller review-start.`);
  const decision = msg("m3", 4469, reviewer, populator, "assignment.completed",
    `ASSIGNMENT-59 completed:\n\nchanges_requested\n\n${header}\nReviewer requested corrections: relabel VF and VCL as maximum values.`);
  const completion = msg("m4", 4481, populator, orchestrator, "completion",
    'Use $component-library-orchestrator. Individual component result.\n{"job_id": "c90c20c4051e4ae8bfd0044cbdebf5cc", "status": "published"}');
  const thread954 = { ...thread, number: 954, purpose: taskBody, task_id: "task-1004" };
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("does not repeat the triggering message, the purpose or shared boilerplate", () => {
    const prompt = coordinationPrompt(thread954, orchestrator, completion, [created, review, decision, completion]);

    expect(count(prompt, "Individual component result.")).toBe(1);
    expect(count(prompt, "Immutable job_id: c90c20c4051e4ae8bfd0044cbdebf5cc")).toBe(1);
    expect(count(prompt, '"workItemId": "addition:usblc6-2sc6"')).toBe(1);
    // The purpose (the opening task body) is printed once, in full.
    expect(prompt).toContain("Purpose: Task TASK-1004: Populate ST USBLC6-2SC6");
    expect(count(prompt, "You own this component task.")).toBe(1);
    expect(prompt).not.toContain("#4481");
  });

  it("omits repeated lines from messages the recipient is part of", () => {
    const followUp = msg("m5", 4478, reviewer, populator, "assignment.completed",
      `ASSIGNMENT-64 completed:\n\npublished\n\n${header}\nIndependent reviewer published and inspected the site.`);
    const prompt = coordinationPrompt(thread954, populator, followUp, [created, review, decision, followUp]);

    expect(count(prompt, "Immutable job_id: c90c20c4051e4ae8bfd0044cbdebf5cc")).toBe(1);
    expect(prompt).toContain("Reviewer requested corrections: relabel VF and VCL as maximum values.");
    expect(prompt).toContain("Review exact revision 1.1.1:review-4. Use controller review-start.");
    expect(prompt).toMatch(/\(\d+ lines already shown above omitted\)/);
  });

  it("summarizes exchanges between other agents instead of replaying their instructions", () => {
    const prompt = coordinationPrompt(thread954, orchestrator, completion, [created, review, decision, completion]);

    expect(prompt).toContain("#4464 Populator -> Reviewer [assignment.created]: ASSIGNMENT-59 (review:job:2:4) for TASK-1004: / Review exact revision 1.1.1:review-4. Use controller review-start.");
    expect(prompt).toContain("#4469 Reviewer -> Populator [assignment.completed]: ASSIGNMENT-59 completed: / changes_requested");
    expect(prompt).not.toContain("Reviewer requested corrections");
    // The recipient's own message stays listed even though the purpose
    // already showed all of its lines.
    expect(prompt).toContain("#4420 Orchestrator -> Populator [task.created]:");
    expect(prompt).toContain("aisevak threads messages THREAD-954");
  });

  it("shows the purpose once when it is the triggering message", () => {
    const prompt = coordinationPrompt(thread954, populator, created, [created]);

    expect(prompt).toContain("Purpose: same as the message that triggered you (below).");
    expect(count(prompt, "You own this component task.")).toBe(1);
    expect(prompt).toContain("- No earlier messages.");
  });

  it("keeps a purpose that is not repeated elsewhere", () => {
    const prompt = coordinationPrompt(thread, recipient, { id: "x", message_type: "handoff", body: "Review this parser." }, []);
    expect(prompt).toContain("Purpose: Check the parser change.");
  });
});

describe("assignment delivery cancellation", () => {
  const recorder = () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = { query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; } };
    return { queries, client: client as any };
  };

  it("lets the assignee's own running turn finish when it completes or blocks", async () => {
    const { queries, client } = recorder();
    await cancelPendingAssignmentDelivery(client, "delivery", "Assignment ASSIGNMENT-59 became completed", { stopRunningTurn: false });

    expect(queries.some((q) => q.sql.includes("SET status = 'cancel_requested'"))).toBe(false);
    const inputs = queries.find((q) => q.sql.includes("UPDATE agent_turn_inputs"));
    expect(inputs?.params?.[2]).toEqual(["queued"]);
    // Queued work for the delivery is still made inert.
    expect(queries.some((q) => q.sql.includes("status IN ('queued', 'retrying')"))).toBe(true);
  });

  it("stops the running turn for an owner-requested retry", async () => {
    const { queries, client } = recorder();
    await cancelPendingAssignmentDelivery(client, "delivery", "Retrying ASSIGNMENT-59", { stopRunningTurn: true });

    expect(queries.some((q) => q.sql.includes("SET status = 'cancel_requested'"))).toBe(true);
    const inputs = queries.find((q) => q.sql.includes("UPDATE agent_turn_inputs"));
    expect(inputs?.params?.[2]).toEqual(["queued", "delivering"]);
  });
});

describe("coordination prompt keeps information it has not shown", () => {
  const orch = { id: "orch", name: "Orch", description: "Coordinates." };
  const builder = { id: "builder", name: "Builder", description: "Builds." };
  const reviewerAgent = { id: "rev", name: "Reviewer", description: "Reviews." };
  const opening = "Ship the OAuth login flow for the web app.";
  const item = (id: string, number: number, from: any, to: any, type: string, body: string) => ({
    id, number, message_type: type, body,
    sender_agent_id: from.id, sender_agent_name: from.name,
    recipient_agent_id: to?.id ?? null, recipient_agent_name: to?.name ?? null
  });
  const history = [
    item("1", 1, orch, builder, "task.created", opening),
    item("2", 2, builder, orch, "message", "Status: blocked on missing CLIENT_ID env var\nchanges_requested"),
    item("3", 3, orch, null, "message", "Status: blocked on missing CLIENT_ID env var\nchanges_requested")
  ];
  const trigger = item("4", 4, builder, reviewerAgent, "handoff", "Please review PR #12");

  it("prints the purpose and the first occurrence of every line", () => {
    const prompt = coordinationPrompt({ ...thread, purpose: opening }, reviewerAgent, trigger, [...history, trigger]);

    expect(prompt).toContain(`Purpose: ${opening}`);
    expect(prompt).toContain("#2 Builder -> Orch [message]: Status: blocked on missing CLIENT_ID env var / changes_requested");
    // A thread-wide message is addressed to everyone and is kept in full.
    expect(prompt).toContain("#3 Orch -> thread [message]: Status: blocked on missing CLIENT_ID env var\nchanges_requested");
    // The opening message's only line is already in the purpose above.
    expect(prompt).toContain("#1 Orch -> Builder [task.created]: (no new content)");
  });
});


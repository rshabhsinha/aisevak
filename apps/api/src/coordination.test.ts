import { describe, expect, it } from "vitest";
import { assertThreadCanFinalize, coordinationIncrementalPrompt, coordinationPrompt, reopenTask } from "./coordination.js";
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
      body: "stale reopen",
      managedRoot: "/managed"
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});

import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { cancelStaleQueuedAgentThreadRuns, transferTaskAgentThread } from "./coordination.js";
import {
  ensureTaskAgentThread,
  getTaskSessionTimeline,
  isolateTaskNavigationThread,
  cancelAgentThread,
  synchronizeTaskSessionRuntime
} from "./server.js";

describe("coordinated task agent threads", () => {
  it("transfers the task navigation thread to a newly assigned agent", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return {
          rows: [{
            id: "thread-id",
            runtime_home: "/runtime/task",
            provider_thread_id: null,
            ownership_generation: 4,
            cwd: "/workspace"
          }]
        };
      }
    } as unknown as DbPool;

    const thread = await transferTaskAgentThread(pool, {
      threadId: "coordination-thread-id",
      taskId: "task-id",
      recipientAgentId: "builder-id",
      model: "gpt-test",
      modelOptions: [{ id: "reasoningEffort", value: "high" }],
      runtimeHome: "/runtime/task"
    });

    expect(queries[0]?.sql).toContain("agent_id = $3");
    expect(queries[0]?.sql).toContain("WHEN agent_id = $3 AND runtime_home = $6");
    expect(queries[0]?.sql).toContain("runtime_home = $6");
    expect(queries[0]?.sql).toContain("ownership_generation = ownership_generation + CASE");
    expect(queries[0]?.sql).toContain("WHERE task_id = $2");
    expect(queries[0]?.params).toEqual([
      "coordination-thread-id",
      "task-id",
      "builder-id",
      "gpt-test",
      JSON.stringify([{ id: "reasoningEffort", value: "high" }]),
      "/runtime/task"
    ]);
    expect(thread).toMatchObject({ id: "thread-id", provider_thread_id: null, ownership_generation: 4 });
  });

  it("keeps the task link and returns the existing coordinated runtime", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const task = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      number: 1,
      title: "Coordinated task",
      body: "",
      coordination_thread_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agent_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      agent_kind: "worker" as const,
      source: "local_path" as const,
      local_path: "/workspace",
      workspace_mode: "direct" as const,
      default_branch: null,
      agent_name: "Builder",
      agent_description: "Builds",
      agent_model: "gpt-5.6-luna",
      agent_model_options: [],
      agent_instructions: "Build it"
    };
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM tasks")) return { rows: [task] };
      if (sql.includes("INSERT INTO agent_threads")) {
        return {
          rows: [{
            id: "thread-id",
            model: "gpt-5.6-luna",
            model_options: [],
            runtime_home: "/runtime/coordinated-thread",
            provider_thread_id: "provider-thread-id",
            ownership_generation: 0
          }]
        };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = {
      query,
      async connect() { return client; }
    } as unknown as DbPool;

    const thread = await ensureTaskAgentThread(pool, {
      task,
      runtimeHome: "/runtime/task-default",
      providerThreadId: null,
      model: "gpt-5.6-luna",
      modelOptions: [],
      cwd: "/workspace",
      branch: null
    });

    const upsert = queries.find((query) => query.sql.includes("INSERT INTO agent_threads"));
    expect(upsert?.sql).toContain("title, agent_id, task_id, project_id");
    expect(upsert?.sql).toContain("task_id = EXCLUDED.task_id");
    expect(upsert?.sql).toContain("ELSE NULL");
    expect(upsert?.params?.[2]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(thread.runtime_home).toBe("/runtime/coordinated-thread");
    expect(thread.provider_thread_id).toBe("provider-thread-id");
  });

  it("moves the task session onto the coordinated runtime and provider thread", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      }
    } as unknown as DbPool;

    await synchronizeTaskSessionRuntime(
      pool,
      "session-id",
      "/runtime/coordinated-thread",
      "provider-thread-id"
    );

    expect(queries[0]?.sql).toContain("SET codex_home = $2");
    expect(queries[0]?.sql).toContain("codex_thread_id = $3");
    expect(queries[0]?.params).toEqual([
      "session-id",
      "/runtime/coordinated-thread",
      "provider-thread-id"
    ]);
  });

  it("cancels queued turns from the previous ownership generation", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("UPDATE task_runs") && sql.includes("RETURNING id")) {
          return { rows: [{ id: "stale-worker" }] };
        }
        if (sql.includes("UPDATE dispatcher_runs") && sql.includes("RETURNING id")) {
          return { rows: [{ id: "stale-dispatcher", message_delivery_id: null }] };
        }
        return { rows: [] };
      }
    } as unknown as DbPool;

    await cancelStaleQueuedAgentThreadRuns(pool, "thread-id", 8);

    expect(queries[0]).toContain("status = 'cancelled'");
    expect(queries[0]).toContain("agent_thread_generation <> $2");
    expect(queries.find((sql) => sql.includes("scope <> 'coordination'"))).toContain("scope <> 'coordination'");
    expect(queries.every((sql) => !sql.includes("SET agent_thread_generation = $2"))).toBe(true);
  });

  it("terminalizes stale coordination deliveries during ownership changes", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("UPDATE dispatcher_runs") && sql.includes("RETURNING id")) {
          return { rows: [{ id: "stale-coordination", message_delivery_id: "delivery-id" }] };
        }
        return { rows: [] };
      }
    } as unknown as DbPool;

    await cancelStaleQueuedAgentThreadRuns(pool, "thread-id", 8);

    expect(queries.some((sql) => sql.includes("UPDATE message_deliveries") && sql.includes("status = 'failed'"))).toBe(true);
    expect(queries.some((sql) => sql.includes("status IN ('queued', 'cancel_requested')"))).toBe(true);
  });

  it("clears a cached provider thread when a task owner changes", async () => {
    const queries: string[] = [];
    const task = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      number: 1,
      title: "Transferred task",
      body: "",
      coordination_thread_id: null,
      project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agent_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      agent_kind: "worker" as const,
      source: "local_path" as const,
      local_path: "/workspace",
      workspace_mode: "direct" as const,
      default_branch: null,
      agent_name: "Builder",
      agent_description: "Builds",
      agent_model: "gpt-test",
      agent_model_options: [],
      agent_instructions: "Build it"
    };
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM tasks")) return { rows: [task] };
      if (sql.includes("INSERT INTO agent_threads")) {
        return {
          rows: [{
            id: "thread-id",
            model: "gpt-test",
            model_options: [],
            runtime_home: "/runtime/task",
            provider_thread_id: null,
            ownership_generation: 3
          }]
        };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    const thread = await ensureTaskAgentThread(pool, {
      task,
      runtimeHome: "/runtime/task",
      providerThreadId: "old-provider-thread",
      model: "gpt-test",
      modelOptions: [],
      cwd: "/workspace",
      branch: null
    });

    expect(thread.provider_thread_id).toBeNull();
    const upsert = queries.find((query) => query.includes("INSERT INTO agent_threads"));
    expect(upsert).toContain("agent_threads.agent_id = EXCLUDED.agent_id");
    expect(upsert).toContain("ELSE NULL");
  });

  it("rolls back ownership changes when stale-run terminalization fails", async () => {
    const statements: string[] = [];
    const task = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      number: 1,
      title: "Transferred task",
      body: "",
      coordination_thread_id: null,
      project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agent_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      agent_kind: "worker" as const,
      source: "local_path" as const,
      local_path: "/workspace",
      workspace_mode: "direct" as const,
      default_branch: null,
      agent_name: "Builder",
      agent_description: "Builds",
      agent_model: "gpt-test",
      agent_model_options: [],
      agent_instructions: "Build it"
    };
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM tasks")) return { rows: [task] };
      if (sql.includes("INSERT INTO agent_threads")) {
        return {
          rows: [{
            id: "thread-id",
            model: "gpt-test",
            model_options: [],
            runtime_home: "/runtime/task",
            provider_thread_id: null,
            ownership_generation: 4
          }]
        };
      }
      if (sql.includes("UPDATE task_runs")) throw new Error("injected terminalization failure");
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await expect(ensureTaskAgentThread(pool, {
      task,
      runtimeHome: "/runtime/task",
      providerThreadId: null,
      model: "gpt-test",
      modelOptions: [],
      cwd: "/workspace",
      branch: null
    })).rejects.toThrow("injected terminalization failure");
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("detaches a task from a thread that contains unrelated provider runs", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      }
    } as unknown as DbPool;

    await isolateTaskNavigationThread(pool, {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      coordinationThreadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    });

    expect(queries[0]?.sql).toContain("SET task_id = NULL");
    expect(queries[0]?.sql).toContain("dispatcher_runs.task_id IS DISTINCT FROM $1");
    expect(queries[0]?.sql).toContain("dispatcher_runs.scope IN ('thread', 'heartbeat')");
    expect(queries[0]?.params).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    ]);
  });

  it("cancels the displayed active turn before a newer queued replacement", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("WITH latest")) {
          return { rows: [{ id: "running-run", kind: "dispatcher", status: "cancel_requested" }] };
        }
        return { rows: [{}] };
      }
    } as unknown as DbPool;

    await expect(cancelAgentThread(pool, "thread-id")).resolves.toEqual({
      turn: { id: "running-run", kind: "dispatcher", status: "cancel_requested" }
    });

    const cancellation = queries.find((query) => query.includes("WITH latest"));
    expect(cancellation).toContain("WHEN status IN ('running', 'cancel_requested') THEN 0");
    expect(cancellation).toContain("WHEN status = 'queued' THEN 1");
    expect(cancellation).toContain("WHEN status IN ('running', 'cancel_requested') THEN started_at");
  });

  it("filters task-linked conversation runs to the selected agent thread", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      }
    } as unknown as DbPool;

    const timeline = await getTaskSessionTimeline(
      pool,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      false
    );

    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain("task_runs.agent_thread_id = $2");
    expect(queries[0]?.sql).toContain("dispatcher_runs.agent_thread_id = $2");
    expect(queries[1]?.sql).toContain("dispatcher_runs.agent_thread_id = $2");
    expect(queries[0]?.params).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ]);
    expect(queries[2]?.sql).toContain("AND $2::boolean");
    expect(queries[2]?.params).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      false,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ]);
    expect(timeline).toEqual({ run: null, events: [] });
  });
});

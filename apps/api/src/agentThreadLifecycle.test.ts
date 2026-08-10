import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { transferTaskAgentThread } from "./coordination.js";
import {
  ensureTaskAgentThread,
  getTaskSessionTimeline,
  isolateTaskNavigationThread,
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
    expect(queries[0]?.sql).toContain("WHERE task_id = $2");
    expect(queries[0]?.params).toEqual([
      "coordination-thread-id",
      "task-id",
      "builder-id",
      "gpt-test",
      JSON.stringify([{ id: "reasoningEffort", value: "high" }]),
      "/runtime/task"
    ]);
    expect(thread).toMatchObject({ id: "thread-id", provider_thread_id: null });
  });

  it("keeps the task link and returns the existing coordinated runtime", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return {
          rows: [{
            id: "thread-id",
            model: "gpt-5.6-luna",
            model_options: [],
            runtime_home: "/runtime/coordinated-thread",
            provider_thread_id: "provider-thread-id"
          }]
        };
      }
    } as unknown as DbPool;

    const thread = await ensureTaskAgentThread(pool, {
      task: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        number: 1,
        title: "Coordinated task",
        body: "",
        coordination_thread_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        agent_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        agent_kind: "worker",
        source: "local_path",
        local_path: "/workspace",
        workspace_mode: "direct",
        default_branch: null,
        agent_name: "Builder",
        agent_description: "Builds",
        agent_model: "gpt-5.6-luna",
        agent_model_options: [],
        agent_instructions: "Build it"
      },
      runtimeHome: "/runtime/task-default",
      providerThreadId: null,
      model: "gpt-5.6-luna",
      modelOptions: [],
      cwd: "/workspace",
      branch: null
    });

    expect(queries[0]?.sql).toContain("title, agent_id, task_id, project_id");
    expect(queries[0]?.sql).toContain("task_id = EXCLUDED.task_id");
    expect(queries[0]?.params?.[2]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
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
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    );

    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain("task_runs.agent_thread_id = $2");
    expect(queries[0]?.sql).toContain("dispatcher_runs.agent_thread_id = $2");
    expect(queries[1]?.sql).toContain("dispatcher_runs.agent_thread_id = $2");
    expect(queries[0]?.params).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ]);
    expect(timeline).toEqual({ run: null, events: [] });
  });
});

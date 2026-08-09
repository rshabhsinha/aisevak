import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { ensureTaskAgentThread, synchronizeTaskSessionRuntime } from "./server.js";

describe("coordinated task agent threads", () => {
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
    expect(queries[0]?.sql).toContain("codex_thread_id = COALESCE($3, codex_thread_id)");
    expect(queries[0]?.params).toEqual([
      "session-id",
      "/runtime/coordinated-thread",
      "provider-thread-id"
    ]);
  });
});

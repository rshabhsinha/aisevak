import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { queueDispatcherMessage } from "./server.js";

const sourceRun = {
  id: "source-run",
  agent_thread_id: "thread-id",
  task_id: null,
  scope: "coordination",
  cwd: "/managed",
  codex_home: "/managed/codex",
  codex_thread_id: "provider-thread",
  workspace_key: "",
  workspace_mode: "projectless",
  workspace_source: "projectless",
  model: "gpt-5",
  model_options: [],
  prompt: "previous",
  status: "running",
  skills_snapshot: []
};

const thread = {
  id: "thread-id",
  title: "Coordination",
  agent_id: "agent-id",
  agent_name: "Dispatcher",
  agent_kind: "dispatcher" as const,
  display_agent_identity: true,
  task_id: null,
  task_number: null,
  project_id: null,
  project_name: null,
  workspace_mode: null,
  workspace_source: null,
  provider_instance_id: "codex-local",
  provider_driver: "codex",
  provider_name: "Codex",
  model: "gpt-5",
  model_options: [],
  cwd: "/managed",
  branch: null,
  runtime_home: "/managed/codex",
  provider_thread_id: "provider-thread",
  ownership_generation: 3,
  last_activity_at: new Date(0),
  created_at: new Date(0),
  updated_at: new Date(0),
  latest_run_id: "source-run",
  latest_run_kind: "dispatcher" as const,
  latest_status: "running",
  latest_error: null
};

describe("dispatcher source-run locking", () => {
  it("locks the source thread before the source dispatcher run", async () => {
    let threadLocked = false;
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      const normalized = sql.trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (sql.includes("SELECT id FROM agent_threads WHERE id = $1 FOR UPDATE")) {
        threadLocked = true;
        return { rows: [{ id: "thread-id" }] };
      }
      if (sql.includes("FROM dispatcher_runs") && sql.includes("WHERE id = $1") && sql.includes("FOR UPDATE")) {
        if (!threadLocked) throw new Error("source dispatcher run was locked before its agent thread");
        return { rows: [sourceRun] };
      }
      if (sql.includes("FROM dispatcher_runs") && sql.includes("WHERE id = $1")) return { rows: [sourceRun] };
      if (sql.includes("FROM agent_threads") && sql.includes("WHERE agent_threads.id = $1")) {
        return { rows: [thread] };
      }
      if (sql.includes("status IN ('queued', 'running')")) return { rows: [] };
      if (sql.includes("INSERT INTO dispatcher_runs")) return { rows: [{ ...sourceRun, id: "replacement-run" }] };
      if (sql.includes("INSERT INTO dispatcher_run_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    const result = await queueDispatcherMessage(pool, {
      sourceRunId: sourceRun.id,
      prompt: "follow up"
    });

    expect(result).toMatchObject({ id: "replacement-run" });
    expect(
      queries.findIndex((sql) => sql.includes("SELECT id FROM agent_threads WHERE id = $1 FOR UPDATE"))
    ).toBeLessThan(queries.findIndex((sql) => sql.includes("FROM dispatcher_runs") && sql.includes("FOR UPDATE")));
  });
});

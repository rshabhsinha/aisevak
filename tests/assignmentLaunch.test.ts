import { expect, it } from "vitest";
import type { DbPool } from "../packages/core/src/db.js";
import type { PoolClient } from "pg";
import { queueDelivery } from "../apps/api/src/coordination.js";
import { acquireRunLaunchFence } from "../apps/runner/src/index.js";

it("launches a specialist assignment without taking task navigation ownership", async () => {
  let snapshot: unknown[] = [];
  let launching = false;
  const thread = { id: "session", task_id: null, project_id: null, coordination_thread_id: "coordination",
    ownership_generation: 2, runtime_home: "/managed/codex-homes/thread-coordination-specialist", cwd: "/managed",
    provider_thread_id: null, model: "gpt-test", model_options: [] };
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO message_deliveries")) return { rows: [{ id: "delivery", status: "queued" }] };
    if (sql.includes("SELECT coordination_threads.*")) return { rows: [{ id: "coordination", number: 1, title: "Review", task_id: "task", project_id: null, purpose: "review" }] };
    if (sql.includes("FROM agents WHERE")) return { rows: [{ id: "specialist", name: "Reviewer", kind: "worker", model: "gpt-test", capabilities: [] }] };
    if (sql.includes("FROM task_assignments") && sql.includes("FOR UPDATE")) return { rows: [{ task_id: "task", assigned_agent_id: "specialist" }] };
    if (sql.includes("FROM tasks")) return { rows: [{ id: "task", agent_id: "owner", number: 1, status: "open", work_scope: "scope", work_key: "key" }] };
    if (sql.includes("FROM agent_threads") && sql.includes("FOR UPDATE")) return { rows: [{ ...thread, agent_id: "specialist" }] };
    if (sql.includes("SELECT thread_messages.*")) return { rows: [{ id: "message", body: "please review", message_type: "assignment", number: 1 }] };
    if (sql.includes("INSERT INTO dispatcher_runs")) { snapshot = params!; return { rows: [{ id: "run" }] }; }
    if (launching && sql.includes("FROM dispatcher_runs") && sql.includes("FOR UPDATE")) return { rows: [{
      id: "run", status: "running", task_id: snapshot[0], assignment_id: snapshot[1], agent_thread_id: "session", agent_thread_generation: 2
    }] };
    return { rows: [] };
  };
  const client = { query, release() {} } as unknown as PoolClient;
  await queueDelivery(client, "/managed", "coordination", "message", "specialist", "assignment");
  expect(snapshot[0]).toBe("task");
  expect(thread.task_id).toBeNull();
  launching = true;
  const release = await acquireRunLaunchFence({ connect: async () => client } as unknown as DbPool, {
    kind: "dispatcher", runId: "run", taskId: String(snapshot[0]), assignmentId: "assignment",
    agentThreadId: "session", agentThreadGeneration: 2, agentId: "specialist"
  });
  expect(release).toBeTypeOf("function");
  await release?.();
});

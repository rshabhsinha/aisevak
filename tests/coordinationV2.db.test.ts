import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations, withTransaction, type DbPool } from "../packages/core/src/index.js";
import {
  agentStatus,
  cancelStaleQueuedAgentThreadRuns,
  inbox,
  notifyFailedDeliveries,
  queueDelivery,
  resolveThreadRef,
  threadStatus
} from "../apps/api/src/coordination.js";
import {
  finalizeWorkerRunState,
  recoverExpiredRunLeases,
  recoverInterruptedCoordinationRuns,
  recoverInterruptedWorkerRuns
} from "../apps/runner/src/index.js";
import { setThreadArchived } from "../apps/api/src/threadArchive.js";
import { renewRunLeases } from "../apps/runner/src/runLeases.js";

// Runs the coordination v2 SQL against a real Postgres. Point
// AISEVAK_TEST_DATABASE_URL at a disposable database (for example
// `createdb aisevak_test`); every run uses fresh names, so it can be re-run.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;
const managedRoot = "/tmp/aisevak-coordination-v2-test";

describe.skipIf(!databaseUrl)("coordination v2 against Postgres", () => {
  let pool: DbPool;
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  beforeAll(async () => {
    process.env.MANAGED_ROOT = managedRoot;
    pool = createPool(databaseUrl);
    await runMigrations(pool);
  });
  afterAll(async () => { await pool?.end(); });

  async function scenario() {
    const suffix = randomUUID().slice(0, 8);
    const [orch] = await q("INSERT INTO agents (name, description, model, instructions) VALUES ($1,'o','gpt-test','x') RETURNING id, name", [`Orch-${suffix}`]);
    const [rev] = await q("INSERT INTO agents (name, description, model, instructions) VALUES ($1,'r','gpt-test','x') RETURNING id, name", [`Rev-${suffix}`]);
    const [task] = await q(
      "INSERT INTO tasks (title, agent_id, work_scope, work_key, work_fingerprint) VALUES ('T', $1, 'test', $2, 'f') RETURNING id, number",
      [orch.id, `coordination-v2-${suffix}`]
    );
    const [thread] = await q("INSERT INTO coordination_threads (title, task_id, primary_agent_id) VALUES ('T', $1, $2) RETURNING id, number", [task.id, orch.id]);
    await q("UPDATE tasks SET coordination_thread_id = $1 WHERE id = $2", [thread.id, task.id]);
    const [assignment] = await q(
      `INSERT INTO task_assignments (task_id, assignment_key, assigned_agent_id, created_by_agent_id, instructions, fingerprint)
       VALUES ($1, 'review', $2, $3, 'review it', 'fp') RETURNING id, number`,
      [task.id, rev.id, orch.id]
    );
    const send = (body: string, from: string, to: string, assignmentId: string | null) => withTransaction(pool, async (client) => {
      const [message] = (await client.query(
        "INSERT INTO thread_messages (thread_id, sender_agent_id, recipient_agent_id, message_type, body) VALUES ($1,$2,$3,'assignment.created',$4) RETURNING id, number",
        [thread.id, from, to, body]
      )).rows;
      const deliveryId = await queueDelivery(client, managedRoot, thread.id, message.id, to, assignmentId);
      return { messageId: message.id as string, messageNumber: message.number as number, deliveryId: deliveryId! };
    });
    return { orch, rev, task, thread, assignment, send };
  }

  it("resolves thread refs, binds inbox items, and reports status", async () => {
    const { orch, rev, task, thread, assignment, send } = await scenario();
    const first = await send("review it", orch.id, rev.id, assignment.id);
    const [bound] = await q("SELECT agent_thread_id, seq FROM message_deliveries WHERE id = $1", [first.deliveryId]);
    expect(bound.agent_thread_id).toBeTruthy();
    expect(Number(bound.seq)).toBeGreaterThan(0);

    expect(await resolveThreadRef(pool, `THREAD-${thread.number}`)).toBe(thread.id);
    expect(await resolveThreadRef(pool, `TASK-${task.number}`)).toBe(thread.id);
    expect(await resolveThreadRef(pool, bound.agent_thread_id)).toBe(thread.id);

    const second = await send("also check X", orch.id, rev.id, null);
    const box = await inbox(pool, rev.id, { threadId: null, limit: 20 });
    expect(box.items.map((item: any) => item.key)).toEqual([`MESSAGE-${first.messageNumber}`, `MESSAGE-${second.messageNumber}`]);
    expect((await agentStatus(pool, rev)).state).toBe("queued");
    const status = await threadStatus(pool, thread.id);
    const owner = status.participants.find((item: any) => item.agent.id === orch.id);
    expect(owner.waitingOn).toEqual([`ASSIGNMENT-${assignment.number}`]);
  });

  it("notifies the sender of a terminal failure once, and stays quiet for a cancelled turn", async () => {
    const { orch, rev, thread, assignment, send } = await scenario();
    const failed = await send("review it", orch.id, rev.id, assignment.id);
    const stopped = await send("ping", orch.id, rev.id, null);
    await q("UPDATE message_deliveries SET status = 'failed', completed_at = now(), error = 'interrupted' WHERE id = $1", [failed.deliveryId]);
    await q("UPDATE message_deliveries SET status = 'failed', completed_at = now(), error = 'stopped', failure_notified_at = now() WHERE id = $1", [stopped.deliveryId]);

    await notifyFailedDeliveries(pool, managedRoot, 200);
    await notifyFailedDeliveries(pool, managedRoot, 200);

    const notices = await q("SELECT recipient_agent_id, parent_message_id, body FROM thread_messages WHERE thread_id = $1 AND message_type = 'delivery.failed'", [thread.id]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipient_agent_id: orch.id, parent_message_id: failed.messageId });
    expect(notices[0].body).toContain("Platform notice (not new work, not a reply)");
  });

  it("sends no notice when a chat is archived mid-assignment", async () => {
    const { orch, rev, thread, assignment, send } = await scenario();
    const sent = await send("review it", orch.id, rev.id, assignment.id);
    const [bound] = await q("SELECT agent_thread_id FROM message_deliveries WHERE id = $1", [sent.deliveryId]);
    await q("UPDATE task_assignments SET active_delivery_id = $2 WHERE id = $1", [assignment.id, sent.deliveryId]);

    await setThreadArchived(pool, bound.agent_thread_id, true);
    await notifyFailedDeliveries(pool, managedRoot, 200);

    expect((await q("SELECT status, failure_notified_at IS NOT NULL AS quiet FROM message_deliveries WHERE id = $1", [sent.deliveryId]))[0])
      .toEqual({ status: "failed", quiet: true });
    expect(await q("SELECT 1 FROM thread_messages WHERE thread_id = $1 AND message_type = 'delivery.failed'", [thread.id])).toHaveLength(0);
  });

  it("notifies the sender when an internal ownership change cancels a queued delivery", async () => {
    const { orch, rev, thread, assignment, send } = await scenario();
    const sent = await send("review it", orch.id, rev.id, assignment.id);
    const [bound] = await q("SELECT agent_thread_id FROM message_deliveries WHERE id = $1", [sent.deliveryId]);
    const [moved] = await q(
      "UPDATE agent_threads SET ownership_generation = ownership_generation + 1 WHERE id = $1 RETURNING ownership_generation",
      [bound.agent_thread_id]
    );

    await cancelStaleQueuedAgentThreadRuns(pool, bound.agent_thread_id, moved.ownership_generation);
    await notifyFailedDeliveries(pool, managedRoot, 200);

    expect((await q("SELECT status FROM message_deliveries WHERE id = $1", [sent.deliveryId]))[0].status).toBe("failed");
    const notices = await q("SELECT recipient_agent_id FROM thread_messages WHERE thread_id = $1 AND message_type = 'delivery.failed'", [thread.id]);
    expect(notices).toEqual([{ recipient_agent_id: orch.id }]);
  });

  it("leaves live leases alone, redelivers an expired interrupted turn, and fences the old runner", async () => {
    const { orch, rev, task, assignment, send } = await scenario();
    const runnerId = `runner-other-${randomUUID().slice(0, 8)}`;
    const first = await send("review it", orch.id, rev.id, assignment.id);
    const [run] = await q("SELECT id, agent_thread_id FROM dispatcher_runs WHERE message_delivery_id = $1", [first.deliveryId]);
    await q(
      `UPDATE dispatcher_runs SET status = 'running', started_at = now(), runner_id = $2,
              lease_expires_at = now() + interval '1 minute', launch_attempted_at = now() WHERE id = $1`,
      [run.id, runnerId]
    );
    await q("UPDATE message_deliveries SET status = 'running', attempt_count = 1, presented_at = now() WHERE id = $1", [first.deliveryId]);
    await q("UPDATE task_assignments SET status = 'running', active_delivery_id = $2 WHERE id = $1", [assignment.id, first.deliveryId]);
    await q("UPDATE agent_threads SET provider_thread_id = 'provider-1' WHERE id = $1", [run.agent_thread_id]);
    const second = await send("also check X", orch.id, rev.id, null);
    const [input] = await q("SELECT id, dispatcher_run_id FROM agent_turn_inputs WHERE message_delivery_id = $1", [second.deliveryId]);
    expect(input.dispatcher_run_id).toBe(run.id);
    await q("UPDATE agent_turn_inputs SET status = 'delivering' WHERE id = $1", [input.id]);
    await q("UPDATE message_deliveries SET status = 'running', attempt_count = 1 WHERE id = $1", [second.deliveryId]);

    // A live lease survives a sweep and another runner's boot.
    await recoverExpiredRunLeases(pool, { runnerId: "runner-me", boot: false });
    await recoverInterruptedCoordinationRuns(pool, { runnerId: "runner-me", boot: true });
    expect((await q("SELECT status FROM dispatcher_runs WHERE id = $1", [run.id]))[0].status).toBe("running");
    await renewRunLeases(pool, runnerId, 60_000, { worker: [], dispatcher: [run.id] });

    // Expired, but inside the takeover grace: still left alone by sweeps.
    await q("UPDATE dispatcher_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [run.id]);
    await recoverExpiredRunLeases(pool, { runnerId: "runner-me", boot: false });
    expect((await q("SELECT status FROM dispatcher_runs WHERE id = $1", [run.id]))[0].status).toBe("running");

    await q("UPDATE dispatcher_runs SET lease_expires_at = now() - interval '10 minutes' WHERE id = $1", [run.id]);
    await recoverExpiredRunLeases(pool, { runnerId: "runner-me", boot: false });
    expect((await q("SELECT status FROM dispatcher_runs WHERE id = $1", [run.id]))[0].status).toBe("failed");
    const [redelivery] = await q(
      "SELECT id, status, trigger, codex_thread_id, prompt FROM dispatcher_runs WHERE message_delivery_id = $1 AND id <> $2",
      [first.deliveryId, run.id]
    );
    expect(redelivery).toMatchObject({ status: "queued", trigger: "redelivery", codex_thread_id: "provider-1" });
    expect(redelivery.prompt).toContain("interrupted by a platform restart");
    const deliveries = await q("SELECT id, status, interrupted_count FROM message_deliveries WHERE id = ANY($1::uuid[]) ORDER BY seq", [[first.deliveryId, second.deliveryId]]);
    expect(deliveries).toEqual([
      { id: first.deliveryId, status: "retrying", interrupted_count: 1 },
      { id: second.deliveryId, status: "retrying", interrupted_count: 1 }
    ]);
    expect((await q("SELECT status, dispatcher_run_id FROM agent_turn_inputs WHERE id = $1", [input.id]))[0])
      .toEqual({ status: "queued", dispatcher_run_id: redelivery.id });
    expect((await q("SELECT status FROM task_assignments WHERE id = $1", [assignment.id]))[0].status).toBe("running");

    // A worker turn whose runner died and came back is recovered at boot, and
    // the old process finishing late changes nothing.
    process.env.AISEVAK_RUNNER_ID = "runner-me";
    try {
      const [session] = await q("INSERT INTO task_sessions (task_id, agent_snapshot, codex_home) VALUES ($1, '{}', '/tmp/h') RETURNING id", [task.id]);
      const [workerRun] = await q(
        `INSERT INTO task_runs (task_id, task_session_id, status, cwd, model, prompt, runner_id, lease_expires_at, trigger)
         VALUES ($1, $2, 'running', '/tmp', 'gpt-test', 'p', 'runner-me', now() + interval '1 minute', 'message') RETURNING id`,
        [task.id, session.id]
      );
      await recoverInterruptedWorkerRuns(pool, { runnerId: "runner-me", boot: false });
      expect((await q("SELECT status FROM task_runs WHERE id = $1", [workerRun.id]))[0].status).toBe("running");
      await recoverInterruptedWorkerRuns(pool, { runnerId: "runner-me", boot: true });
      expect((await q("SELECT status FROM task_runs WHERE id = $1", [workerRun.id]))[0].status).toBe("failed");
      const finalized = await finalizeWorkerRunState(pool, {
        runId: workerRun.id, taskId: task.id, agentThreadId: null, coordinationThreadId: null,
        finalStatus: "succeeded", stdout: "", stderr: "", exitCode: 0
      });
      expect(finalized).toBe(false);
      expect((await q("SELECT status FROM task_runs WHERE id = $1", [workerRun.id]))[0].status).toBe("failed");
      expect((await q("SELECT status FROM tasks WHERE id = $1", [task.id]))[0].status).toBe("open");
    } finally {
      delete process.env.AISEVAK_RUNNER_ID;
    }
  });
});

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, hashToken, runMigrations, type DbPool } from "@aisevak/core";
import { expireRequests, registerCoordinationRoutes } from "./coordination.js";

// Phase 3 of coordination v2 through the real agent-tools routes and a real
// Postgres. Runs when AISEVAK_TEST_DATABASE_URL points at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;
const managedRoot = "/tmp/aisevak-coordination-v3-test";

describe.skipIf(!databaseUrl)("coordination v2 phase 3 against Postgres", () => {
  let pool: DbPool;
  let app: FastifyInstance;
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  beforeAll(async () => {
    process.env.MANAGED_ROOT = managedRoot;
    pool = createPool(databaseUrl);
    await runMigrations(pool);
    app = Fastify();
    await registerCoordinationRoutes(app, pool, { managedRoot });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  async function agent(name: string, kind: "worker" | "dispatcher" = "worker") {
    const [row] = await q(
      "INSERT INTO agents (name, description, model, instructions, kind) VALUES ($1, 'test', 'gpt-test', 'x', $2) RETURNING id, name",
      [`${name}-${randomUUID().slice(0, 8)}`, kind]
    );
    return row as { id: string; name: string };
  }

  async function task(owner: string, title: string, parentId: string | null = null) {
    const [row] = await q(
      `INSERT INTO tasks (title, agent_id, parent_task_id, work_scope, work_key, work_fingerprint)
       VALUES ($1, $2, $3, 'test', $4, 'f') RETURNING id, number`,
      [title, owner, parentId, `phase3-${randomUUID()}`]
    );
    const [thread] = await q("INSERT INTO coordination_threads (title, task_id, primary_agent_id) VALUES ($1, $2, $3) RETURNING id, number", [title, row.id, owner]);
    await q("UPDATE tasks SET coordination_thread_id = $1 WHERE id = $2", [thread.id, row.id]);
    return { id: row.id as string, number: row.number as number, threadId: thread.id as string, threadNumber: thread.number as number };
  }

  async function token(agentId: string, taskId: string | null = null, threadId: string | null = null) {
    const value = `test-${randomUUID()}`;
    await q(
      `INSERT INTO agent_tool_tokens (token_hash, task_id, agent_id, coordination_thread_id, role, expires_at)
       VALUES ($1, $2, $3, $4, 'worker', now() + interval '1 hour')`,
      [hashToken(value), taskId, agentId, threadId]
    );
    return value;
  }

  async function call(tokenValue: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
    const response = await app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${tokenValue}` } });
    return { status: response.statusCode, body: response.json() as any };
  }

  it("sends a keyed request, replies to it, and returns the reply to a waiter", async () => {
    const asker = await agent("Asker");
    const answerer = await agent("Answerer");
    const work = await task(asker.id, "Ask a question");
    const askerToken = await token(asker.id, work.id, work.threadId);
    const answererToken = await token(answerer.id);

    const sent = await call(askerToken, "POST", "/api/agent-tools/v1/send", { to: answerer.name, body: "Is LM317 in stock?", key: "stock-check", expectReply: true, timeoutSeconds: 600 });
    expect(sent.status).toBe(200);
    expect(sent.body.message).toMatchObject({ message_type: "request", request_state: "open", request_key: "stock-check" });
    const again = await call(askerToken, "POST", "/api/agent-tools/v1/send", { to: answerer.name, body: "Is LM317 in stock?", key: "stock-check", expectReply: true });
    expect(again.body).toMatchObject({ duplicate: true, message: { id: sent.body.message.id } });

    const pending = await call(askerToken, "GET", `/api/agent-tools/v1/messages/MESSAGE-${sent.body.message.number}/reply?wait=0`);
    expect(pending.body).toMatchObject({ state: "open", reply: null });
    // The request is delivered with the reply instruction.
    const [run] = await q("SELECT prompt FROM dispatcher_runs WHERE message_delivery_id = (SELECT id FROM message_deliveries WHERE message_id = $1)", [sent.body.message.id]);
    expect(run.prompt).toContain(`aisevak reply MESSAGE-${sent.body.message.number} --body-stdin`);

    const stranger = await agent("Stranger");
    const refused = await call(await token(stranger.id), "POST", `/api/agent-tools/v1/messages/MESSAGE-${sent.body.message.number}/reply`, { body: "me" });
    expect(refused.status).toBe(403);

    const replied = await call(answererToken, "POST", `/api/agent-tools/v1/messages/MESSAGE-${sent.body.message.number}/reply`, { body: "Yes, 40 units." });
    expect(replied.status).toBe(200);
    expect(replied.body.request.state).toBe("replied");
    const waited = await call(askerToken, "GET", `/api/agent-tools/v1/messages/MESSAGE-${sent.body.message.number}/reply?wait=5`);
    expect(waited.body).toMatchObject({ state: "replied", reply: { body: "Yes, 40 units.", recipient_agent_id: asker.id } });
  });

  it("times out an unanswered request and tells the requester", async () => {
    const asker = await agent("Asker");
    const answerer = await agent("Answerer");
    const work = await task(asker.id, "Ask and wait");
    const sent = await call(await token(asker.id, work.id, work.threadId), "POST", "/api/agent-tools/v1/send", { to: answerer.name, body: "ping?", expectReply: true, timeoutSeconds: 10 });
    await q("UPDATE thread_messages SET reply_by = now() - interval '1 second' WHERE id = $1", [sent.body.message.id]);
    await expireRequests(pool, managedRoot, 500);
    expect((await q("SELECT request_state FROM thread_messages WHERE id = $1", [sent.body.message.id]))[0].request_state).toBe("timed_out");
    const notices = await q("SELECT recipient_agent_id, body FROM thread_messages WHERE parent_message_id = $1 AND message_type = 'request.timed_out'", [sent.body.message.id]);
    expect(notices).toHaveLength(1);
    expect(notices[0].recipient_agent_id).toBe(asker.id);
  });

  it("treats an assignment as a request that completing it answers", async () => {
    const owner = await agent("Owner");
    const reviewer = await agent("Reviewer");
    const work = await task(owner.id, "Needs review");
    await q("UPDATE agents SET capabilities = '[\"assignments:create\", \"assignments:read\", \"tasks:read\", \"threads:read\", \"threads:send\"]' WHERE id = $1", [owner.id]);
    const created = await call(await token(owner.id, work.id, work.threadId), "POST", `/api/agent-tools/v1/tasks/TASK-${work.number}/assignments`, { key: "review", to: reviewer.name, instructions: "Review it" });
    expect(created.status).toBe(200);
    const [assignment] = await q("SELECT id, number, request_message_id FROM task_assignments WHERE task_id = $1", [work.id]);
    expect(assignment.request_message_id).toBeTruthy();
    const [requestMessage] = await q("SELECT number, request_state FROM thread_messages WHERE id = $1", [assignment.request_message_id]);
    expect(requestMessage.request_state).toBe("open");
    const reviewerToken = await token(reviewer.id);
    const wrongWay = await call(reviewerToken, "POST", `/api/agent-tools/v1/messages/MESSAGE-${requestMessage.number}/reply`, { body: "done" });
    expect(wrongWay.status).toBe(400);
    const done = await call(reviewerToken, "POST", `/api/agent-tools/v1/assignments/ASSIGNMENT-${assignment.number}/complete`, { result: "Looks good" });
    expect(done.status).toBe(200);
    expect((await q("SELECT request_state FROM thread_messages WHERE id = $1", [assignment.request_message_id]))[0].request_state).toBe("replied");
    const [reply] = await q("SELECT in_reply_to_message_id FROM thread_messages WHERE message_type = 'assignment.completed' AND thread_id = $1", [work.threadId]);
    expect(reply.in_reply_to_message_id).toBe(assignment.request_message_id);
  });

  it("runs a campaign: policy, reparent, ancestor authority, child events, schedule retarget", async () => {
    const controller = await agent("Controller");
    const oldRun = await agent("OldRun");
    const populator = await agent("Populator");
    await q("UPDATE agents SET capabilities = '[\"tasks:read\", \"tasks:update\", \"tasks:create-child\", \"tasks:complete\", \"threads:read\", \"threads:send\", \"schedules:write\", \"schedules:read\"]' WHERE id = $1", [controller.id]);
    const campaign = await task(controller.id, "Component Library campaign");
    const oldParent = await task(oldRun.id, "Old 30-minute run");
    const child = await task(populator.id, "Populate LM317", oldParent.id);
    const controllerToken = await token(controller.id, campaign.id, campaign.threadId);

    // Before the move the controller has no authority over the child.
    const tooEarly = await call(controllerToken, "POST", `/api/agent-tools/v1/tasks/TASK-${child.number}/complete`, { body: "done" });
    expect(tooEarly.status).toBe(403);

    // Raising limits needs tasks:update, which only the orchestrator has.
    const ownLimits = await call(controllerToken, "POST", `/api/agent-tools/v1/tasks/TASK-${campaign.number}/policy`, { maxActiveChildren: 200 });
    expect(ownLimits.status).toBe(403);
    const orchestrator = await agent("Orchestrator", "dispatcher");
    const policy = await call(await token(orchestrator.id), "POST", `/api/agent-tools/v1/tasks/TASK-${campaign.number}/policy`, { maxActiveChildren: 200 });
    expect(policy.body.orchestrationPolicy.maxActiveChildren).toBe(200);

    // Moving needs authority over the child's tree too: the old run's owner does it.
    const notMine = await call(controllerToken, "POST", `/api/agent-tools/v1/tasks/TASK-${child.number}/reparent`, { parent: `TASK-${campaign.number}` });
    expect(notMine.status).toBe(403);
    await q("UPDATE agents SET capabilities = '[\"tasks:read\", \"tasks:create-child\"]' WHERE id = $1", [oldRun.id]);
    await q("UPDATE tasks SET agent_id = $2 WHERE id = $1", [oldParent.id, controller.id]);
    const moved = await call(controllerToken, "POST", `/api/agent-tools/v1/tasks/TASK-${child.number}/reparent`, { parent: `TASK-${campaign.number}` });
    expect(moved.status).toBe(200);
    expect(moved.body.task.parent_task_id).toBe(campaign.id);
    const cycle = await call(controllerToken, "POST", `/api/agent-tools/v1/tasks/TASK-${campaign.number}/reparent`, { parent: `TASK-${child.number}` });
    expect(cycle.status).toBe(400);

    // As an ancestor owner the controller may now complete the child, and the
    // event reaches the campaign thread.
    const completed = await call(controllerToken, "POST", `/api/agent-tools/v1/tasks/TASK-${child.number}/complete`, { body: "Published." });
    expect(completed.status).toBe(200);
    expect(completed.body.task.status).toBe("completed");
    const events = await q("SELECT message_type, recipient_agent_id FROM thread_messages WHERE thread_id = $1 AND message_type LIKE 'child.%'", [campaign.threadId]);
    expect(events).toEqual([{ message_type: "child.completed", recipient_agent_id: controller.id }]);

    // A populator finishing its own child reports to the campaign thread too.
    const second = await task(populator.id, "Populate USBLC6", campaign.id);
    await q("UPDATE agents SET capabilities = '[\"tasks:read\", \"tasks:complete\", \"threads:read\", \"threads:send\"]' WHERE id = $1", [populator.id]);
    const own = await call(await token(populator.id, second.id, second.threadId), "POST", `/api/agent-tools/v1/tasks/TASK-${second.number}/complete`, { body: "Done" });
    expect(own.status).toBe(200);
    const [delivered] = await q(
      `SELECT message_deliveries.agent_thread_id FROM thread_messages JOIN message_deliveries ON message_deliveries.message_id = thread_messages.id
       WHERE thread_messages.thread_id = $1 AND thread_messages.message_type = 'child.completed' AND thread_messages.sender_agent_id = $2`,
      [campaign.threadId, populator.id]
    );
    expect(delivered.agent_thread_id).toBeTruthy();

    // The 30-minute schedule ticks into the campaign thread instead of creating tasks.
    const [schedule] = await q(
      `INSERT INTO schedules (title, prompt, agent_id, schedule_kind, next_run_at, interval_seconds)
       VALUES ('check', 'Check the campaign', $1, 'interval', now() + interval '1 hour', 1800) RETURNING number`,
      [controller.id]
    );
    const retarget = await call(controllerToken, "PATCH", `/api/agent-tools/v1/schedules/SCHEDULE-${schedule.number}`, { task: `TASK-${campaign.number}` });
    expect(retarget.status).toBe(200);
    expect(retarget.body.schedule.task_id).toBe(campaign.id);

    // Refresh policy on the controller's own session.
    await q(
      `INSERT INTO agent_threads (agent_id, task_id, provider_instance_id, model, cwd, runtime_home, coordination_thread_id, provider_thread_id)
       VALUES ($1, $2, 'codex-local', 'gpt-test', '/tmp', '/tmp/h', $3, 'provider-old')
       ON CONFLICT DO NOTHING`,
      [controller.id, campaign.id, campaign.threadId]
    );
    const refresh = await call(controllerToken, "POST", `/api/agent-tools/v1/threads/THREAD-${campaign.threadNumber}/refresh`, { everyTurns: 2 });
    expect(refresh.body.contextPolicy).toMatchObject({ maxTurns: 2 });
  });

  it("never lets an archived parent session block a child's completion", async () => {
    const controller = await agent("Controller");
    const populator = await agent("Populator");
    const campaign = await task(controller.id, "Campaign with archived chat");
    const child = await task(populator.id, "Child", campaign.id);
    await q(
      `INSERT INTO agent_threads (agent_id, task_id, provider_instance_id, model, cwd, runtime_home, coordination_thread_id, archived_at, cleanup_state)
       VALUES ($1, $2, 'codex-local', 'gpt-test', '/tmp', '/tmp/h', $3, now(), 'pending')`,
      [controller.id, campaign.id, campaign.threadId]
    );
    await q("UPDATE agents SET capabilities = '[\"tasks:read\", \"tasks:complete\"]' WHERE id = $1", [populator.id]);
    const done = await call(await token(populator.id, child.id, child.threadId), "POST", `/api/agent-tools/v1/tasks/TASK-${child.number}/complete`, { body: "Done" });
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe("completed");
    const events = await q("SELECT message_type FROM thread_messages WHERE thread_id = $1 AND message_type = 'child.completed'", [campaign.threadId]);
    expect(events).toHaveLength(1);
  });

  it("does not let a child's owner move it out of its controller's tree", async () => {
    const controller = await agent("Controller");
    const populator = await agent("Populator");
    const campaign = await task(controller.id, "Campaign");
    const child = await task(populator.id, "Child", campaign.id);
    const elsewhere = await task(populator.id, "Populator's own root");
    await q("UPDATE agents SET capabilities = '[\"tasks:read\", \"tasks:create-child\"]' WHERE id = $1", [populator.id]);
    const escape = await call(await token(populator.id, child.id, child.threadId), "POST", `/api/agent-tools/v1/tasks/TASK-${child.number}/reparent`, { parent: `TASK-${elsewhere.number}` });
    expect(escape.status).toBe(403);
    expect((await q("SELECT parent_task_id FROM tasks WHERE id = $1", [child.id]))[0].parent_task_id).toBe(campaign.id);
  });

  it("sends an assignment's result to whoever asked for it", async () => {
    const controller = await agent("Controller");
    const populator = await agent("Populator");
    const reviewer = await agent("Reviewer");
    const campaign = await task(controller.id, "Campaign");
    const child = await task(populator.id, "Child", campaign.id);
    await q("UPDATE agents SET capabilities = '[\"assignments:create\", \"assignments:read\", \"tasks:read\"]' WHERE id = $1", [controller.id]);
    const created = await call(await token(controller.id, campaign.id, campaign.threadId), "POST", `/api/agent-tools/v1/tasks/TASK-${child.number}/assignments`, { key: "review", to: reviewer.name, instructions: "Review the child" });
    expect(created.status).toBe(200);
    const done = await call(await token(reviewer.id), "POST", `/api/agent-tools/v1/assignments/ASSIGNMENT-${created.body.assignment.number}/complete`, { result: "Approved" });
    expect(done.status).toBe(200);
    const [result] = await q("SELECT recipient_agent_id FROM thread_messages WHERE thread_id = $1 AND message_type = 'assignment.completed'", [child.threadId]);
    expect(result.recipient_agent_id).toBe(controller.id);
  });

  it("waits for new inbox items, and keeps a refresh period when refreshing now", async () => {
    const asker = await agent("Asker");
    const listener = await agent("Listener");
    const work = await task(asker.id, "Inbox wait");
    const listenerToken = await token(listener.id);
    await call(await token(asker.id, work.id, work.threadId), "POST", "/api/agent-tools/v1/send", { to: listener.name, body: "already pending" });
    const waiting = call(listenerToken, "GET", "/api/agent-tools/v1/inbox?wait=10");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const started = Date.now();
    await call(await token(asker.id, work.id, work.threadId), "POST", "/api/agent-tools/v1/send", { to: listener.name, body: "new one" });
    const result = await waiting;
    expect(result.body.arrived).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);

    await q(
      `INSERT INTO agent_threads (agent_id, task_id, provider_instance_id, model, cwd, runtime_home, coordination_thread_id)
       VALUES ($1, $2, 'codex-local', 'gpt-test', '/tmp', '/tmp/h', $3) ON CONFLICT DO NOTHING`,
      [asker.id, work.id, work.threadId]
    );
    const askerToken = await token(asker.id, work.id, work.threadId);
    await call(askerToken, "POST", `/api/agent-tools/v1/threads/THREAD-${work.threadNumber}/refresh`, { everyTurns: 40 });
    const now = await call(askerToken, "POST", `/api/agent-tools/v1/threads/THREAD-${work.threadNumber}/refresh`, { now: true });
    expect(now.body.contextPolicy).toMatchObject({ maxTurns: 40, refreshNow: true });
    const cleared = await call(askerToken, "POST", `/api/agent-tools/v1/threads/THREAD-${work.threadNumber}/refresh`, { everyTurns: null });
    expect(cleared.body.contextPolicy.maxTurns).toBeUndefined();
  });
});

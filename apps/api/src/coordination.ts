import {
  contentPage,
  decodePageCursor,
  defaultCodexModelOptions,
  encodeCursor,
  hashToken,
  installedSkillsRoot,
  managedCodexHome,
  pageLimit,
  parseSkillMarkdown,
  serializeCodexSkillSnapshots,
  synchronizeInstalledSkills,
  withTransaction,
  writeInstalledSkill,
  type CodexSkillSnapshot,
  type DbPool
} from "@aisevak/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg, { type PoolClient } from "pg";
import { z } from "zod";
import {
  assignmentFingerprint,
  childDepth,
  detachedWorkScope,
  jobSafetyMode,
  normalizeWorkKey,
  normalizeWorkScope,
  orchestrationPolicy,
  safetyConflict,
  safetyForbidden,
  stableFingerprint,
  taskFingerprint,
  taskWorkScope,
  type OrchestrationPolicy
} from "./jobSafety.js";

const DEFAULT_WORKER_CAPABILITIES = [
  "agents:read",
  "credentials:read",
  "projects:read",
  "threads:read",
  "threads:send",
  "tasks:read",
  "tasks:complete",
  "assignments:read",
  "assignments:send",
  "assignments:complete",
  "assignments:block",
  "schedules:read",
  "reports:read",
  "reports:write",
  "incidents:read",
  "incidents:write"
] as const;

const ORCHESTRATOR_CAPABILITIES = [
  ...DEFAULT_WORKER_CAPABILITIES,
  "threads:complete",
  "credentials:write",
  "skills:write",
  "tasks:create-root",
  "tasks:create-child",
  "tasks:update",
  "tasks:assign",
  "assignments:create",
  "assignments:manage",
  "assignments:retry",
  "schedules:write",
  "orchestration:route"
] as const;

export interface AgentContext {
  agentId: string;
  agentThreadId: string | null;
  coordinationThreadId: string | null;
  taskId: string | null;
  taskProjectId: string | null;
  kind: "worker" | "dispatcher";
  name: string;
  description: string;
  capabilities: string[];
  assignmentId: string | null;
  assignmentKey: string | null;
  assignmentStatus: string | null;
  assignmentAttempt: number | null;
  providerThreadId: string | null;
}

export type Queryable = DbPool | PoolClient;

interface AgentThreadSession {
  id: string;
  task_id: string | null;
  project_id: string | null;
  ownership_generation: number;
  runtime_home: string;
  provider_thread_id: string | null;
  cwd: string;
}

const pageSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().optional(),
  status: z.string().optional(),
  query: z.string().trim().optional()
});
const refParams = z.object({ ref: z.string().min(1) });
const threadCreateSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  purpose: z.string().min(1),
  to: z.string().min(1),
  projectId: z.string().uuid().optional(),
  task: z.string().optional(),
  originThread: z.string().optional(),
  originMessage: z.string().optional(),
  workKey: z.string().trim().min(1).max(200).optional(),
  workScope: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().max(200).optional()
});
const messageSchema = z.object({
  body: z.string().min(1),
  to: z.string().optional(),
  parentMessage: z.string().optional(),
  idempotencyKey: z.string().max(200).optional()
});
const finalMessageSchema = z.object({ body: z.string().min(1), idempotencyKey: z.string().max(200).optional() });
const taskCreateSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  body: z.string().default(""),
  status: z.string().default("open"),
  projectId: z.string().uuid().optional(),
  agent: z.string().optional(),
  workKey: z.string().trim().min(1).max(200).optional(),
  workScope: z.string().trim().min(1).max(200).optional(),
  parentTask: z.string().optional(),
  idempotencyKey: z.string().max(200).optional()
});
const taskPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  body: z.string().optional(),
  status: z.string().optional()
});
const assignSchema = z.object({ agent: z.string().min(1) });
const assignmentCreateSchema = z.object({
  key: z.string().trim().min(1).max(200),
  to: z.string().min(1),
  instructions: z.string().min(1).max(50_000),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
});
const assignmentMessageSchema = z.object({
  body: z.string().min(1).max(50_000),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
});
const assignmentResultSchema = z.object({
  result: z.string().min(1).max(100_000),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
});
const optionalBodySchema = z.object({ body: z.string().optional() });
const reportCreateSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  markdown: z.string().min(1),
  projectId: z.string().uuid().optional(),
  thread: z.string().optional()
});
const markdownSchema = z.object({ markdown: z.string().min(1) });
const incidentCreateSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  markdown: z.string().min(1),
  projectId: z.string().uuid().optional(),
  to: z.string().optional()
});
const optionalMarkdownSchema = z.object({ markdown: z.string().optional() });
const scheduleCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(50_000),
  agent: z.string().min(1),
  at: z.string().datetime(),
  intervalSeconds: z.coerce.number().int().min(60).max(31_536_000).optional(),
  task: z.string().optional(),
  overlapPolicy: z.enum(["skip", "queue", "allow"]).default("skip"),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
});
const skillInstallSchema = z.object({
  markdown: z.string().min(1).max(100_000),
  files: z.record(z.string().max(100_000)).default({})
}).superRefine((body, context) => {
  const entries = Object.entries(body.files);
  if (entries.length > 64) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A skill may contain at most 64 supporting files" });
  }
  const totalBytes = Buffer.byteLength(body.markdown) + entries.reduce(
    (sum, [path, content]) => sum + Buffer.byteLength(path) + Buffer.byteLength(content),
    0
  );
  if (totalBytes > 500_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Installed skill content may not exceed 500 KB" });
  }
});

export async function reopenTask(
  pool: DbPool,
  input: { taskId: string; senderAgentId: string; body?: string; managedRoot: string }
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [input.taskId]);
    const task = await showTask(client, input.taskId);
    if (task.agent_id !== input.senderAgentId) {
      forbidden(`Task ${task.key ?? input.taskId} is assigned to another agent`);
    }
    await client.query("UPDATE tasks SET status = 'open', updated_at = now() WHERE id = $1", [input.taskId]);
    if (!task.coordination_thread_id) return;
    await client.query("UPDATE coordination_threads SET status = 'active', updated_at = now(), last_activity_at = now() WHERE id = $1", [task.coordination_thread_id]);
    const message = await insertMessage(client, {
      threadId: task.coordination_thread_id,
      senderAgentId: input.senderAgentId,
      recipientAgentId: task.agent_id,
      body: input.body || `TASK-${task.number} was reopened.`,
      type: "task.reopened"
    });
    if (task.agent_id !== input.senderAgentId) {
      await queueDelivery(client, input.managedRoot, task.coordination_thread_id, message.id, task.agent_id);
    }
  });
}

export async function registerCoordinationRoutes(
  app: FastifyInstance,
  pool: DbPool,
  options: { managedRoot: string }
): Promise<void> {
  app.get("/api/agent-tools/v1/whoami", async (request) => {
    const context = await requireAgent(pool, request);
    const envelope = await loadJobEnvelope(pool, context.taskId, context.assignmentId, {
      coordinationThreadId: context.coordinationThreadId,
      agentThreadId: context.agentThreadId,
      providerThreadId: context.providerThreadId
    });
    return { agent: agentIdentity(context), current: currentContext(context, envelope) };
  });

  app.get("/api/agent-tools/v1/capabilities", async (request) => {
    const context = await requireAgent(pool, request);
    const skills = await resolveAgentSkills(pool, context.agentId, context.taskProjectId, context.taskId);
    return {
      agent: agentIdentity(context),
      capabilities: context.capabilities,
      skills: skills.map(({ name, description, sources }) => ({ name, description, sources }))
    };
  });

  app.post("/api/agent-tools/v1/skills", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "skills:write");
    const body = skillInstallSchema.parse(request.body);
    let skill: ReturnType<typeof parseSkillMarkdown>;
    try {
      skill = parseSkillMarkdown(body.markdown);
    } catch (error) {
      badRequest(error instanceof Error ? error.message : String(error));
    }
    const root = installedSkillsRoot(options.managedRoot);
    try {
      await writeInstalledSkill(root, { ...skill, files: body.files });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Installed skill directory already exists:")) {
        throw httpError(409, `Installed skill ${skill.name} already exists`);
      }
      badRequest(message);
    }
    await synchronizeInstalledSkills(pool, root);
    const result = await pool.query(
      `SELECT id, name, description, instructions, files, enabled, platform_managed,
              default_for_agents, created_at, updated_at
       FROM skills WHERE name = $1`,
      [skill.name]
    );
    const installed = result.rows[0] ?? notFound("Installed skill");
    return { skill: { ...installed, key: `SKILL-${skill.name}` } };
  });

  app.get("/api/agent-tools/v1/agents", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "agents:read");
    const query = pageSchema.parse(request.query);
    const cursor = parseCursor(query.cursor);
    const limit = pageLimit(query.limit);
    const result = await pool.query(
      `SELECT id, kind, name, description, model, capabilities, enabled, created_at, updated_at
       FROM agents
       WHERE enabled = true
         AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
         AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2, $3::uuid))
       ORDER BY updated_at DESC, id DESC
       LIMIT $4`,
      [query.query || null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return listResponse(result.rows, limit, "updated_at", (row) => ({
      ...row,
      key: `AGENT-${row.name}`,
      capabilities: effectiveCapabilities(String(row.kind), row.capabilities)
    }));
  });

  app.get("/api/agent-tools/v1/agents/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "agents:read");
    return { agent: await getAgent(pool, refParams.parse(request.params).ref) };
  });

  app.get("/api/agent-tools/v1/threads", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "threads:read");
    const query = pageSchema.parse(request.query);
    const cursor = parseCursor(query.cursor);
    const limit = pageLimit(query.limit);
    const result = await pool.query(
      `SELECT coordination_threads.*,
              primary_agent.name AS primary_agent_name,
              callback_agent.name AS callback_agent_name,
              creator_agent.name AS created_by_agent_name,
              origin_thread.number AS origin_thread_number,
              left(coordination_threads.purpose, 1000) AS content_preview,
              octet_length(coordination_threads.purpose) AS content_total_bytes
       FROM coordination_threads
       LEFT JOIN agents primary_agent ON primary_agent.id = coordination_threads.primary_agent_id
       LEFT JOIN agents callback_agent ON callback_agent.id = coordination_threads.callback_agent_id
       LEFT JOIN agents creator_agent ON creator_agent.id = coordination_threads.created_by_agent_id
       LEFT JOIN coordination_threads origin_thread ON origin_thread.id = coordination_threads.origin_thread_id
       WHERE ($1::text IS NULL OR coordination_threads.status = $1)
         AND ($2::text IS NULL OR coordination_threads.title ILIKE '%' || $2 || '%' OR coordination_threads.description ILIKE '%' || $2 || '%')
         AND ($3::timestamptz IS NULL OR (coordination_threads.last_activity_at, coordination_threads.id) < ($3, $4::uuid))
       ORDER BY coordination_threads.last_activity_at DESC, coordination_threads.id DESC
       LIMIT $5`,
      [query.status || null, query.query || null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return listResponse(result.rows, limit, "last_activity_at", threadResource);
  });

  app.post("/api/agent-tools/v1/threads", async (request) => {
    const context = await requireAgent(pool, request);
    if (context.taskId) {
      await withTransaction(pool, async (client) => {
        await recordSafetyEvent(client, {
          operation: "thread.create.inside-task",
          context,
          taskId: context.taskId,
          message: "This agent is inside an active task. Use a keyed assignment or child task; detached coordination threads are not allowed here."
        });
      });
    }
    requireCapability(context, "threads:create-detached");
    const body = threadCreateSchema.parse(request.body);
    if (!body.workKey) badRequest("Detached thread creation requires a stable workKey; use an assignment or keyed child task inside an active task");
    const recipient = await getAgent(pool, body.to);
    if (!recipient.enabled) badRequest(`Agent ${recipient.name} is disabled`);
    let originThread = body.originThread
      ? await resolveResourceId(pool, "coordination_threads", "THREAD", body.originThread)
      : context.coordinationThreadId;
    const originMessage = body.originMessage
      ? await resolveResourceId(pool, "thread_messages", "MESSAGE", body.originMessage)
      : null;
    if (originMessage && !originThread) {
      const messageThread = await pool.query<{ thread_id: string }>(
        "SELECT thread_id FROM thread_messages WHERE id = $1",
        [originMessage]
      );
      originThread = messageThread.rows[0]?.thread_id ?? null;
    }
    if (originMessage && originThread) {
      const belongs = await pool.query(
        "SELECT 1 FROM thread_messages WHERE id = $1 AND thread_id = $2",
        [originMessage, originThread]
      );
      if (!belongs.rows[0]) badRequest("Origin message does not belong to the origin thread");
    }
    const taskId = body.task ? await resolveResourceId(pool, "tasks", "TASK", body.task) : null;
    if (taskId) badRequest("threads create cannot attach to a task; use tasks create --work-key or assignments create");
    const projectId = body.projectId ?? context.taskProjectId;
    const workKey = normalizeWorkKey(body.workKey);
    const workScope = normalizeWorkScope(body.workScope, detachedWorkScope(context.agentId));
    const workFingerprint = stableFingerprint({ title: body.title, description: body.description, purpose: body.purpose, to: recipient.id, projectId });
    const result = await withTransaction(pool, async (client) => {
      const existing = await client.query<{ id: string; number: number; work_fingerprint: string }>(
        `SELECT id, number, work_fingerprint FROM coordination_threads
         WHERE task_id IS NULL AND work_scope = $1 AND work_key = $2 FOR UPDATE`, [workScope, workKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].work_fingerprint !== workFingerprint) {
          await recordSafetyEvent(client, {
            operation: "thread.create.identity-conflict",
            context,
            workScope,
            workKey,
            details: { existingFingerprint: existing.rows[0].work_fingerprint, requestedFingerprint: workFingerprint },
            message: `Detached work key ${workScope}/${workKey} already belongs to THREAD-${existing.rows[0].number} with different immutable input`
          });
        }
        const prior = await client.query<{ id: string }>(
          "SELECT id FROM thread_messages WHERE thread_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1", [existing.rows[0].id]
        );
        return { threadId: existing.rows[0].id, messageId: prior.rows[0]?.id ?? "", duplicate: true };
      }
      const duplicate = await existingIdempotentMessage(client, context.agentId, body.idempotencyKey);
      if (duplicate) return { threadId: duplicate.thread_id, messageId: duplicate.id, duplicate: true };
      const inserted = await client.query<{ id: string; number: number }>(
        `INSERT INTO coordination_threads
           (title, description, purpose, project_id, task_id, created_by_agent_id, primary_agent_id,
            callback_agent_id, origin_thread_id, origin_message_id, work_scope, work_key, work_fingerprint, completion_instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $8, $9, $10, $11, $12,
                 'When complete, send the result back to ' || $13 || ' with: aisevak threads complete THREAD-<number> --summary-stdin')
         ON CONFLICT (work_scope, work_key)
           WHERE task_id IS NULL AND work_scope IS NOT NULL AND work_key IS NOT NULL
         DO NOTHING
         RETURNING id, number`,
        [
          body.title,
          body.description,
          body.purpose,
          projectId,
          taskId,
          context.agentId,
          recipient.id,
          originThread,
          originMessage,
          workScope,
          workKey,
          workFingerprint,
          context.name
        ]
      );
      if (!inserted.rows[0]) {
        const concurrent = await client.query<{ id: string; number: number; work_fingerprint: string }>(
          `SELECT id, number, work_fingerprint FROM coordination_threads
           WHERE task_id IS NULL AND work_scope = $1 AND work_key = $2 FOR UPDATE`, [workScope, workKey]
        );
        const row = concurrent.rows[0] ?? notFound("Thread created by concurrent request");
        if (row.work_fingerprint !== workFingerprint) {
          await recordSafetyEvent(client, {
            operation: "thread.create.identity-conflict",
            context,
            workScope,
            workKey,
            details: { existingFingerprint: row.work_fingerprint, requestedFingerprint: workFingerprint, concurrent: true },
            message: `Detached work key ${workScope}/${workKey} already belongs to THREAD-${row.number} with different immutable input`
          });
        }
        const prior = await client.query<{ id: string }>(
          "SELECT id FROM thread_messages WHERE thread_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1", [row.id]
        );
        return { threadId: row.id, messageId: prior.rows[0]?.id ?? "", duplicate: true };
      }
      const thread = inserted.rows[0]!;
      await client.query(
        `UPDATE coordination_threads
         SET completion_instructions = 'When complete, send the result back to ' || $2 || ' with: aisevak threads complete THREAD-' || $3 || ' --summary-stdin'
         WHERE id = $1`,
        [thread.id, context.name, thread.number]
      );
      await addParticipants(client, thread.id, [
        [context.agentId, "initiator"],
        [recipient.id, "assignee"]
      ]);
      const message = await insertMessage(client, {
        threadId: thread.id,
        senderAgentId: context.agentId,
        recipientAgentId: recipient.id,
        body: body.purpose,
        type: "handoff",
        idempotencyKey: body.idempotencyKey
      });
      if (recipient.id !== context.agentId) {
        await queueDelivery(client, options.managedRoot, thread.id, message.id, recipient.id);
      }
      return { threadId: thread.id, messageId: message.id, duplicate: false };
    });
    return {
      thread: await showThread(pool, result.threadId),
      message: await showMessage(pool, result.messageId),
      duplicate: result.duplicate
    };
  });

  app.get("/api/agent-tools/v1/threads/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "threads:read");
    const id = await resolveResourceId(pool, "coordination_threads", "THREAD", refParams.parse(request.params).ref);
    return { thread: await showThread(pool, id) };
  });

  app.get("/api/agent-tools/v1/threads/:ref/messages", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "threads:read");
    const id = await resolveResourceId(pool, "coordination_threads", "THREAD", refParams.parse(request.params).ref);
    const query = pageSchema.parse(request.query);
    const cursor = parseCursor(query.cursor);
    const limit = pageLimit(query.limit, 20, 100);
    const result = await pool.query(
      `SELECT thread_messages.*,
              sender.name AS sender_agent_name,
              recipient.name AS recipient_agent_name,
              message_deliveries.status AS delivery_status,
              message_deliveries.attempt_count AS delivery_attempt_count
       FROM thread_messages
       LEFT JOIN agents sender ON sender.id = thread_messages.sender_agent_id
       LEFT JOIN agents recipient ON recipient.id = thread_messages.recipient_agent_id
       LEFT JOIN message_deliveries ON message_deliveries.message_id = thread_messages.id
       WHERE thread_messages.thread_id = $1
         AND ($2::timestamptz IS NULL OR (thread_messages.created_at, thread_messages.id) < ($2, $3::uuid))
       ORDER BY thread_messages.created_at DESC, thread_messages.id DESC
       LIMIT $4`,
      [id, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    const page = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;
    const last = page.at(-1);
    return {
      messages: page.reverse().map((row) => messageResource(row)),
      previousCursor: hasMore && last ? encodeCursor({ at: iso(last.created_at), id: String(last.id) }) : null,
      hasEarlier: hasMore
    };
  });

  app.post("/api/agent-tools/v1/threads/:ref/messages", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "threads:send");
    const threadId = await resolveResourceId(pool, "coordination_threads", "THREAD", refParams.parse(request.params).ref);
    const body = messageSchema.parse(request.body);
    const output = await withTransaction(pool, async (client) => {
      const thread = await lockThread(client, threadId);
      const duplicate = await existingIdempotentMessage(client, context.agentId, body.idempotencyKey);
      if (duplicate) return { messageId: duplicate.id, duplicate: true };
      const recipient = body.to
        ? await getAgent(client, body.to)
        : await defaultRecipient(client, thread, context.agentId);
      const parentId = body.parentMessage
        ? await resolveResourceId(client, "thread_messages", "MESSAGE", body.parentMessage)
        : null;
      const message = await insertMessage(client, {
        threadId,
        senderAgentId: context.agentId,
        recipientAgentId: recipient?.id ?? null,
        body: body.body,
        type: "message",
        parentMessageId: parentId,
        idempotencyKey: body.idempotencyKey
      });
      await client.query(
        `UPDATE coordination_threads SET status = 'active', last_activity_at = now(), updated_at = now() WHERE id = $1`,
        [threadId]
      );
      if (recipient && recipient.id !== context.agentId) {
        await addParticipants(client, threadId, [[recipient.id, "participant"]]);
        await queueDelivery(client, options.managedRoot, threadId, message.id, recipient.id);
      }
      return { messageId: message.id, duplicate: false };
    });
    return { message: await showMessage(pool, output.messageId), duplicate: output.duplicate };
  });

  for (const action of ["complete", "block"] as const) {
    app.post(`/api/agent-tools/v1/threads/:ref/${action}`, async (request) => {
      const context = await requireAgent(pool, request);
      requireCapability(context, "threads:complete");
      const threadId = await resolveResourceId(pool, "coordination_threads", "THREAD", refParams.parse(request.params).ref);
      const body = finalMessageSchema.parse(request.body);
      const messageId = await finalizeThread(
        pool,
        options.managedRoot,
        context,
        threadId,
        action === "complete" ? "completed" : "blocked",
        body.body,
        body.idempotencyKey
      );
      return { thread: await showThread(pool, threadId), message: await showMessage(pool, messageId) };
    });
  }

  app.get("/api/agent-tools/v1/tasks", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "tasks:read");
    const query = pageSchema.parse(request.query);
    const cursor = parseCursor(query.cursor);
    const limit = pageLimit(query.limit);
    const result = await pool.query(
      `SELECT tasks.*, agents.name AS agent_name, projects.name AS project_name,
              left(tasks.body, 1000) AS content_preview, octet_length(tasks.body) AS content_total_bytes
       FROM tasks
       JOIN agents ON agents.id = tasks.agent_id
       LEFT JOIN projects ON projects.id = tasks.project_id
       WHERE ($1::text IS NULL OR tasks.status = $1)
         AND ($2::text IS NULL OR tasks.title ILIKE '%' || $2 || '%' OR tasks.description ILIKE '%' || $2 || '%')
         AND ($3::timestamptz IS NULL OR (tasks.updated_at, tasks.id) < ($3, $4::uuid))
       ORDER BY tasks.updated_at DESC, tasks.id DESC
       LIMIT $5`,
      [query.status || null, query.query || null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return listResponse(result.rows, limit, "updated_at", taskResource);
  });

  app.post("/api/agent-tools/v1/tasks", async (request) => {
    const context = await requireAgent(pool, request);
    // Check capability before validating the body so stale/unauthorized
    // callers cannot turn a forbidden mutation into a schema error (or learn
    // more about the route than their capability permits).
    const rawBody = request.body && typeof request.body === "object"
      ? request.body as { parentTask?: unknown }
      : {};
    const hasParentTask = typeof rawBody.parentTask === "string" && rawBody.parentTask.trim().length > 0;
    requireCapability(context, hasParentTask ? "tasks:create-child" : "tasks:create-root");
    const body = taskCreateSchema.parse(request.body);
    if (!body.workKey) badRequest("Agent-created tasks require a stable workKey; use assignments for specialist work");
    const recipient = body.agent ? await getAgent(pool, body.agent) : await getOrchestrator(pool);
    const projectId = body.projectId ?? context.taskProjectId;
    const parentTaskId = body.parentTask ? await resolveResourceId(pool, "tasks", "TASK", body.parentTask) : null;
    const ids = await withTransaction(pool, async (client) => {
      await assertTaskCreationAllowed(client, context, parentTaskId);
      return createOrReuseTaskInTransaction(client, {
        context,
        title: body.title,
        description: body.description,
        body: body.body,
        status: body.status,
        projectId,
        recipient,
        parentTaskId,
        workKey: body.workKey!,
        workScope: body.workScope,
        idempotencyKey: body.idempotencyKey,
        managedRoot: options.managedRoot
      });
    });
    if (ids.conflict) return { task: await showTask(pool, ids.taskId), thread: ids.threadId ? await showThread(pool, ids.threadId) : null, duplicate: true, conflict: true };
    return {
      task: await showTask(pool, ids.taskId),
      thread: await showThread(pool, ids.threadId),
      duplicate: ids.duplicate
    };
  });

  app.get("/api/agent-tools/v1/tasks/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "tasks:read");
    const id = await resolveResourceId(pool, "tasks", "TASK", refParams.parse(request.params).ref);
    return { task: await showTask(pool, id) };
  });

  app.patch("/api/agent-tools/v1/tasks/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "tasks:update");
    const id = await resolveResourceId(pool, "tasks", "TASK", refParams.parse(request.params).ref);
    const body = taskPatchSchema.parse(request.body);
    const currentTask = await pool.query<{ agent_id: string }>("SELECT agent_id FROM tasks WHERE id = $1", [id]);
    requireTaskOwner(context, currentTask.rows[0] ?? notFound("Task"), "update this task");
    if (["completed", "blocked", "cancelled"].includes(body.status ?? "")) {
      const active = await pool.query<{ count: string }>(
        "SELECT count(*)::int AS count FROM task_assignments WHERE task_id = $1 AND status IN ('queued', 'running')", [id]
      );
      if (Number(active.rows[0]?.count ?? 0) > 0) {
        await recordSafetyEvent(pool, {
          operation: "task.complete.active-assignments",
          context,
          taskId: id,
          details: { requestedStatus: body.status, activeAssignments: Number(active.rows[0]?.count ?? 0) },
          message: `Task cannot be marked ${body.status} while assignments are active; complete or block each assignment first`
        });
      }
    }
    const result = await pool.query(
      `UPDATE tasks SET title = COALESCE($2, title), description = COALESCE($3, description),
              body = COALESCE($4, body), status = COALESCE($5, status), updated_at = now()
       WHERE id = $1 RETURNING id`,
      [id, body.title ?? null, body.description ?? null, body.body ?? null, body.status ?? null]
    );
    if (!result.rows[0]) notFound("Task");
    await pool.query(
      `UPDATE coordination_threads
       SET title = COALESCE($2, title), description = COALESCE($3, description),
           purpose = COALESCE($4, purpose),
           status = CASE
             WHEN $5::text = 'completed' THEN 'completed'
             WHEN $5::text = 'blocked' THEN 'blocked'
             WHEN $5::text IS NOT NULL THEN 'active'
             ELSE status
           END,
           updated_at = now()
       WHERE task_id = $1`,
      [id, body.title ?? null, body.description ?? null, body.body ?? null, body.status ?? null]
    );
    return { task: await showTask(pool, id) };
  });

  app.post("/api/agent-tools/v1/tasks/:ref/assign", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "tasks:assign");
    const id = await resolveResourceId(pool, "tasks", "TASK", refParams.parse(request.params).ref);
    const body = assignSchema.parse(request.body);
    const recipient = await getAgent(pool, body.agent);
    const owner = await pool.query<{ agent_id: string }>("SELECT agent_id FROM tasks WHERE id = $1", [id]);
    requireTaskOwner(context, owner.rows[0] ?? notFound("Task"), "reassign this task");
    const output = await withTransaction(pool, async (client) => {
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [id]);
      const task = await client.query<{ number: number; title: string; coordination_thread_id: string }>(
        `UPDATE tasks SET agent_id = $2, status = 'open', updated_at = now() WHERE id = $1
         RETURNING number, title, coordination_thread_id`,
        [id, recipient.id]
      );
      const row = task.rows[0] ?? notFound("Task");
      await client.query(
        `UPDATE coordination_threads SET primary_agent_id = $2, status = 'active', updated_at = now(), last_activity_at = now() WHERE id = $1`,
        [row.coordination_thread_id, recipient.id]
      );
      await transferTaskAgentThread(client, {
        threadId: row.coordination_thread_id,
        taskId: id,
        recipientAgentId: recipient.id,
        model: recipient.model,
        modelOptions: modelOptionsFor(recipient.model, recipient.model_options),
        runtimeHome: managedCodexHome(options.managedRoot, id),
        preserveCoordination: recipient.id !== context.agentId
      });
      await addParticipants(client, row.coordination_thread_id, [[recipient.id, "assignee"]]);
      const message = await insertMessage(client, {
        threadId: row.coordination_thread_id,
        senderAgentId: context.agentId,
        recipientAgentId: recipient.id,
        body: `You are now assigned TASK-${row.number}: ${row.title}. Inspect the task and thread, complete the work, then report back through this thread.`,
        type: "task.assigned"
      });
      if (recipient.id !== context.agentId) {
        await queueDelivery(client, options.managedRoot, row.coordination_thread_id, message.id, recipient.id);
      }
      return { threadId: row.coordination_thread_id };
    });
    return { task: await showTask(pool, id), thread: await showThread(pool, output.threadId) };
  });

  app.get("/api/agent-tools/v1/tasks/:ref/assignments", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "assignments:read");
    const taskId = await resolveResourceId(pool, "tasks", "TASK", refParams.parse(request.params).ref);
    const result = await pool.query(
      `SELECT task_assignments.*, tasks.number AS task_number, tasks.title AS task_title,
              tasks.coordination_thread_id, agents.name AS assigned_agent_name,
              creator.name AS created_by_agent_name, message_deliveries.status AS delivery_status
       FROM task_assignments
       JOIN tasks ON tasks.id = task_assignments.task_id
       JOIN agents ON agents.id = task_assignments.assigned_agent_id
       LEFT JOIN agents creator ON creator.id = task_assignments.created_by_agent_id
       LEFT JOIN message_deliveries ON message_deliveries.id = task_assignments.active_delivery_id
       WHERE task_assignments.task_id = $1
       ORDER BY task_assignments.number ASC`, [taskId]
    );
    return { assignments: result.rows.map((row) => assignmentResource(row)) };
  });

  app.get("/api/agent-tools/v1/assignments/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "assignments:read");
    const id = await resolveResourceId(pool, "task_assignments", "ASSIGNMENT", refParams.parse(request.params).ref);
    return { assignment: await showAssignment(pool, id, true) };
  });

  app.post("/api/agent-tools/v1/tasks/:ref/assignments", async (request) => {
    const context = await requireAgent(pool, request);
    requireAnyCapability(context, ["assignments:create", "assignments:manage"]);
    const taskId = await resolveResourceId(pool, "tasks", "TASK", refParams.parse(request.params).ref);
    const body = assignmentCreateSchema.parse(request.body);
    const recipient = await getAgent(pool, body.to);
    if (!recipient.enabled) badRequest(`Agent ${recipient.name} is disabled`);
    if (recipient.kind === "dispatcher") badRequest("Assignments must target an enabled worker agent");
    const result = await withTransaction(pool, async (client) => {
      const taskResult = await client.query<{
        id: string; number: number; title: string; status: string; agent_id: string; coordination_thread_id: string | null; orchestration_policy: unknown;
      }>("SELECT id, number, title, status, agent_id, coordination_thread_id, orchestration_policy FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
      const task = taskResult.rows[0] ?? notFound("Task");
      requireTaskOwner(context, task, "create assignments for this task");
      if (["completed", "blocked", "cancelled"].includes(task.status)) throw safetyConflict(`Cannot add an assignment to a ${task.status} task`);
      if (!task.coordination_thread_id) badRequest("This task has no coordination thread; migrate the task before adding an assignment");
      const key = normalizeWorkKey(body.key);
      const fingerprint = assignmentFingerprint({ taskId, assignmentKey: key, assignedAgentId: recipient.id, instructions: body.instructions });
      const existing = await client.query<{ id: string; fingerprint: string }>(
        "SELECT id, fingerprint FROM task_assignments WHERE task_id = $1 AND assignment_key = $2 FOR UPDATE", [taskId, key]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint) {
          await recordSafetyEvent(client, {
            operation: "assignment.create.identity-conflict",
            context,
            taskId,
            assignmentId: existing.rows[0].id,
            workKey: key,
            details: { existingFingerprint: existing.rows[0].fingerprint, requestedFingerprint: fingerprint },
            message: `Assignment key ${key} already exists on TASK-${task.number} with different immutable input`
          });
        }
        return { assignmentId: existing.rows[0].id, duplicate: true };
      }
      const policy = orchestrationPolicy(task.orchestration_policy);
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::int AS count FROM task_assignments WHERE task_id = $1 AND status IN ('queued', 'running')", [taskId]
      );
      if (Number(active.rows[0]?.count ?? 0) >= policy.maxActiveAssignments) {
        await recordSafetyEvent(client, {
          operation: "assignment.create.active-limit",
          context,
          taskId,
          workKey: key,
          details: { limit: policy.maxActiveAssignments },
          message: `Task has reached its active assignment limit (${policy.maxActiveAssignments})`
        });
      }
      const inserted = await client.query<{ id: string; number: number }>(
         `INSERT INTO task_assignments
           (task_id, assignment_key, assigned_agent_id, created_by_agent_id, instructions, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (task_id, assignment_key) DO NOTHING
         RETURNING id, number`,
        [taskId, key, recipient.id, context.agentId, body.instructions, fingerprint]
      );
      if (!inserted.rows[0]) {
        // A concurrent request may have passed the initial SELECT before the
        // other transaction committed. The unique key is the final arbiter;
        // reuse that assignment instead of creating a second delivery/session.
        const concurrent = await client.query<{ id: string; fingerprint: string }>(
          "SELECT id, fingerprint FROM task_assignments WHERE task_id = $1 AND assignment_key = $2 FOR UPDATE",
          [taskId, key]
        );
        const row = concurrent.rows[0] ?? notFound("Assignment created by concurrent request");
        if (row.fingerprint !== fingerprint) {
          await recordSafetyEvent(client, {
            operation: "assignment.create.identity-conflict",
            context,
            taskId,
            assignmentId: row.id,
            workKey: key,
            details: { existingFingerprint: row.fingerprint, requestedFingerprint: fingerprint, concurrent: true },
            message: `Assignment key ${key} already exists on TASK-${task.number} with different immutable input`
          });
        }
        return { assignmentId: row.id, duplicate: true };
      }
      const assignment = inserted.rows[0];
      const message = await insertMessage(client, {
        threadId: task.coordination_thread_id,
        senderAgentId: context.agentId,
        recipientAgentId: recipient.id,
        body: `ASSIGNMENT-${assignment.number} (${key}) for TASK-${task.number}:\n\n${body.instructions}\n\nUse the same assignment to report completion; do not create a recovery or review thread.`,
        type: "assignment.created",
        idempotencyKey: body.idempotencyKey
      });
      await client.query("UPDATE task_assignments SET last_message_id = $2 WHERE id = $1", [assignment.id, message.id]);
      const deliveryId = recipient.id === context.agentId
        ? null
        : await queueDelivery(client, options.managedRoot, task.coordination_thread_id, message.id, recipient.id, assignment.id);
      if (deliveryId) {
        await client.query("UPDATE task_assignments SET active_delivery_id = $2 WHERE id = $1", [assignment.id, deliveryId]);
      }
      return { assignmentId: assignment.id, duplicate: false };
    });
    return { assignment: await showAssignment(pool, result.assignmentId, true), duplicate: result.duplicate };
  });

  app.post("/api/agent-tools/v1/assignments/:ref/send", async (request) => {
    const context = await requireAgent(pool, request);
    requireAnyCapability(context, ["assignments:send", "assignments:manage"]);
    const id = await resolveResourceId(pool, "task_assignments", "ASSIGNMENT", refParams.parse(request.params).ref);
    const body = assignmentMessageSchema.parse(request.body);
    await withTransaction(pool, async (client) => {
      const row = await client.query<{ task_id: string; assigned_agent_id: string; status: string; coordination_thread_id: string; task_agent_id: string; task_status: string }>(
        `SELECT task_assignments.task_id, task_assignments.assigned_agent_id, task_assignments.status,
                tasks.coordination_thread_id, tasks.agent_id AS task_agent_id, tasks.status AS task_status
         FROM task_assignments JOIN tasks ON tasks.id = task_assignments.task_id
         WHERE task_assignments.id = $1 FOR UPDATE`, [id]
      );
      const assignment = row.rows[0] ?? notFound("Assignment");
      if (context.agentId !== assignment.assigned_agent_id && context.agentId !== assignment.task_agent_id && context.kind !== "dispatcher") {
        forbidden("Only the assigned agent, task owner, or orchestrator may send assignment instructions");
      }
      const duplicate = await existingIdempotentMessage(client, context.agentId, body.idempotencyKey);
      if (duplicate) return;
      if (["completed", "cancelled"].includes(assignment.task_status)) throw safetyConflict(`Cannot send instructions on a ${assignment.task_status} task`);
      if (["completed", "cancelled"].includes(assignment.status)) throw safetyConflict("A terminal assignment cannot receive more instructions");
      const message = await insertMessage(client, {
        threadId: assignment.coordination_thread_id,
        senderAgentId: context.agentId,
        recipientAgentId: assignment.assigned_agent_id,
        body: body.body,
        type: "assignment.message",
        idempotencyKey: body.idempotencyKey
      });
      const deliveryId = context.agentId === assignment.assigned_agent_id
        ? null
        : await queueDelivery(client, options.managedRoot, assignment.coordination_thread_id, message.id, assignment.assigned_agent_id, id);
      await client.query("UPDATE task_assignments SET last_message_id = $2, active_delivery_id = $3, status = CASE WHEN status = 'blocked' THEN 'queued' ELSE status END, updated_at = now() WHERE id = $1", [id, message.id, deliveryId]);
    });
    return { assignment: await showAssignment(pool, id, true) };
  });

  app.post("/api/agent-tools/v1/assignments/:ref/retry", async (request) => {
    const context = await requireAgent(pool, request);
    requireAnyCapability(context, ["assignments:retry", "assignments:manage"]);
    const id = await resolveResourceId(pool, "task_assignments", "ASSIGNMENT", refParams.parse(request.params).ref);
    const body = assignmentMessageSchema.partial().parse(request.body ?? {});
    await withTransaction(pool, async (client) => {
      const row = await client.query<{
        task_id: string; task_number: number; assignment_number: number; assigned_agent_id: string; status: string; attempt_count: number;
        max_attempts: unknown; coordination_thread_id: string; task_agent_id: string; task_status: string; assignment_key: string; instructions: string; active_delivery_id: string | null;
      }>(
        `SELECT task_assignments.task_id, tasks.number AS task_number, task_assignments.number AS assignment_number, task_assignments.assigned_agent_id,
                task_assignments.status, task_assignments.attempt_count, tasks.orchestration_policy AS max_attempts,
                tasks.coordination_thread_id, tasks.agent_id AS task_agent_id, tasks.status AS task_status, task_assignments.assignment_key, task_assignments.instructions,
                task_assignments.active_delivery_id
         FROM task_assignments JOIN tasks ON tasks.id = task_assignments.task_id
         WHERE task_assignments.id = $1 FOR UPDATE`, [id]
      );
      const assignment = row.rows[0] ?? notFound("Assignment");
      requireTaskOwner(context, { agent_id: assignment.task_agent_id }, "retry this assignment");
      if (["completed", "cancelled"].includes(assignment.task_status)) throw safetyConflict(`Cannot retry an assignment on a ${assignment.task_status} task`);
      if (["completed", "cancelled"].includes(assignment.status)) throw safetyConflict("A terminal assignment cannot be retried");
      if (assignment.status === "running") throw safetyConflict("The assignment is already running; wait for it to finish or fail");
      const policy = orchestrationPolicy(assignment.max_attempts);
      if (assignment.attempt_count >= policy.maxAssignmentAttempts) {
        await recordSafetyEvent(client, {
          operation: "assignment.retry.attempt-limit",
          context,
          taskId: assignment.task_id,
          assignmentId: id,
          details: { limit: policy.maxAssignmentAttempts },
          message: `Assignment has reached its retry limit (${policy.maxAssignmentAttempts})`
        });
      }
      const nextAttempt = assignment.attempt_count + 1;
      const retryIdempotencyKey = body.idempotencyKey || `assignment:${id}:attempt:${nextAttempt}`;
      const duplicate = await existingIdempotentMessage(client, context.agentId, retryIdempotencyKey);
      if (duplicate) return;
      if (assignment.active_delivery_id) await cancelPendingAssignmentDelivery(client, assignment.active_delivery_id, `Retrying ASSIGNMENT-${assignment.assignment_number}`);
      await client.query("UPDATE task_assignments SET attempt_count = $2, status = 'queued', result = NULL, active_delivery_id = NULL, updated_at = now() WHERE id = $1", [id, nextAttempt]);
      const message = await insertMessage(client, {
        threadId: assignment.coordination_thread_id,
        senderAgentId: context.agentId,
        recipientAgentId: assignment.assigned_agent_id,
        body: body.body || `Retry ASSIGNMENT-${assignment.assignment_number} (${assignment.assignment_key}) attempt ${nextAttempt}. Continue the same assignment and provider session when resumable.`,
        type: "assignment.retry",
        idempotencyKey: retryIdempotencyKey
      });
      await client.query("UPDATE task_assignments SET last_message_id = $2 WHERE id = $1", [id, message.id]);
      const deliveryId = context.agentId === assignment.assigned_agent_id
        ? null
        : await queueDelivery(client, options.managedRoot, assignment.coordination_thread_id, message.id, assignment.assigned_agent_id, id);
      if (deliveryId) await client.query("UPDATE task_assignments SET active_delivery_id = $2 WHERE id = $1", [id, deliveryId]);
    });
    return { assignment: await showAssignment(pool, id, true) };
  });

  for (const action of ["complete", "block"] as const) {
    app.post(`/api/agent-tools/v1/assignments/:ref/${action}`, async (request) => {
      const context = await requireAgent(pool, request);
      requireCapability(context, action === "complete" ? "assignments:complete" : "assignments:block");
      const id = await resolveResourceId(pool, "task_assignments", "ASSIGNMENT", refParams.parse(request.params).ref);
      const body = assignmentResultSchema.parse(request.body);
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          task_id: string; assignment_number: number; assigned_agent_id: string; status: string; coordination_thread_id: string; task_agent_id: string; task_number: number; active_delivery_id: string | null;
        }>(
          `SELECT task_assignments.task_id, task_assignments.number AS assignment_number, task_assignments.assigned_agent_id, task_assignments.status,
                  task_assignments.active_delivery_id,
                  tasks.coordination_thread_id, tasks.agent_id AS task_agent_id, tasks.number AS task_number
           FROM task_assignments JOIN tasks ON tasks.id = task_assignments.task_id
           WHERE task_assignments.id = $1 FOR UPDATE`, [id]
        );
        const assignment = row.rows[0] ?? notFound("Assignment");
        if (assignment.assigned_agent_id !== context.agentId) forbidden("Only the assigned specialist may complete or block this assignment");
        if (["completed", "blocked", "cancelled"].includes(assignment.status)) return;
        const duplicate = await existingIdempotentMessage(client, context.agentId, body.idempotencyKey);
        if (duplicate) return;
        await client.query("UPDATE task_assignments SET status = $2, result = $3, active_delivery_id = NULL, updated_at = now() WHERE id = $1", [id, action === "complete" ? "completed" : "blocked", body.result]);
        if (assignment.active_delivery_id) await cancelPendingAssignmentDelivery(client, assignment.active_delivery_id, `Assignment ASSIGNMENT-${assignment.assignment_number} became ${action === "complete" ? "completed" : "blocked"}`);
        if (assignment.task_agent_id !== context.agentId) {
          const message = await insertMessage(client, {
            threadId: assignment.coordination_thread_id,
            senderAgentId: context.agentId,
            recipientAgentId: assignment.task_agent_id,
          body: `ASSIGNMENT-${assignment.assignment_number} ${action === "complete" ? "completed" : "blocked"}:\n\n${body.result}`,
            type: action === "complete" ? "assignment.completed" : "assignment.blocked",
            idempotencyKey: body.idempotencyKey
          });
          await queueDelivery(client, options.managedRoot, assignment.coordination_thread_id, message.id, assignment.task_agent_id);
        }
      });
      return { assignment: await showAssignment(pool, id, true) };
    });
  }

  app.post("/api/agent-tools/v1/tasks/:ref/complete", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "tasks:complete");
    const id = await resolveResourceId(pool, "tasks", "TASK", refParams.parse(request.params).ref);
    const body = optionalBodySchema.parse(request.body ?? {});
    const owner = await pool.query<{ agent_id: string }>("SELECT agent_id FROM tasks WHERE id = $1", [id]);
    requireTaskOwner(context, owner.rows[0] ?? notFound("Task"), "complete this task");
    const active = await pool.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM task_assignments WHERE task_id = $1 AND status IN ('queued', 'running')", [id]
    );
    if (Number(active.rows[0]?.count ?? 0) > 0) {
      await recordSafetyEvent(pool, {
        operation: "task.complete.active-assignments",
        context,
        taskId: id,
        details: { requestedStatus: "completed", activeAssignments: Number(active.rows[0]?.count ?? 0) },
        message: "Task cannot be completed while assignments are queued or running; complete or block each assignment first"
      });
    }
    const task = await showTask(pool, id);
    if (task.coordination_thread_id) {
      await finalizeThread(pool, options.managedRoot, context, task.coordination_thread_id, "completed", body.body || "Task completed.");
    } else {
      await pool.query("UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = $1", [id]);
    }
    return { task: await showTask(pool, id) };
  });

  app.post("/api/agent-tools/v1/tasks/:ref/reopen", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "tasks:update");
    const id = await resolveResourceId(pool, "tasks", "TASK", refParams.parse(request.params).ref);
    const body = optionalBodySchema.parse(request.body ?? {});
    await reopenTask(pool, {
      taskId: id,
      senderAgentId: context.agentId,
      body: body.body,
      managedRoot: options.managedRoot
    });
    return { task: await showTask(pool, id) };
  });

  registerReportRoutes(app, pool);
  registerIncidentRoutes(app, pool, options.managedRoot);
  registerScheduleRoutes(app, pool);

  app.get("/api/agent-tools/v1/resources/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    const ref = refParams.parse(request.params).ref;
    return { resource: await showResource(pool, context, ref) };
  });

  app.get("/api/agent-tools/v1/resources/:ref/content", async (request) => {
    const context = await requireAgent(pool, request);
    const ref = refParams.parse(request.params).ref;
    const query = z.object({ cursor: z.string().optional(), limit: z.coerce.number().optional() }).parse(request.query);
    const resource = await contentResource(pool, context, ref);
    try {
      return { ref: resource.ref, title: resource.title, ...contentPage(resource.content, {
        cursor: query.cursor,
        maxBytes: query.limit,
        revision: resource.revision
      }) };
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid cursor");
    }
  });
}

function registerScheduleRoutes(app: FastifyInstance, pool: DbPool): void {
  app.get("/api/agent-tools/v1/schedules", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "schedules:read");
    const query = pageSchema.parse(request.query);
    const cursor = parseCursor(query.cursor);
    const limit = pageLimit(query.limit);
    const result = await pool.query(
      `SELECT schedules.*,
              agents.name AS agent_name,
              creator.name AS created_by_agent_name,
              agent_threads.title AS last_thread_title,
              latest.status AS last_run_status,
              left(schedules.prompt, 1000) AS content_preview,
              octet_length(schedules.prompt) AS content_total_bytes,
              CASE
                WHEN schedules.enabled THEN 'scheduled'
                WHEN schedules.schedule_kind = 'once' AND schedules.last_run_at IS NOT NULL THEN 'completed'
                ELSE 'paused'
              END AS status
       FROM schedules
       JOIN agents ON agents.id = schedules.agent_id
       LEFT JOIN agents creator ON creator.id = schedules.created_by_agent_id
       LEFT JOIN agent_threads ON agent_threads.id = schedules.last_agent_thread_id
       LEFT JOIN LATERAL (
         SELECT dispatcher_runs.status
         FROM schedule_runs
         JOIN dispatcher_runs ON dispatcher_runs.id = schedule_runs.dispatcher_run_id
         WHERE schedule_runs.schedule_id = schedules.id
         ORDER BY schedule_runs.scheduled_for DESC
         LIMIT 1
       ) latest ON true
       WHERE ($1::text IS NULL OR CASE
                WHEN schedules.enabled THEN 'scheduled'
                WHEN schedules.schedule_kind = 'once' AND schedules.last_run_at IS NOT NULL THEN 'completed'
                ELSE 'paused'
              END = $1)
         AND ($2::text IS NULL OR schedules.title ILIKE '%' || $2 || '%' OR schedules.prompt ILIKE '%' || $2 || '%' OR agents.name ILIKE '%' || $2 || '%')
         AND ($3::timestamptz IS NULL OR (schedules.updated_at, schedules.id) < ($3, $4::uuid))
       ORDER BY schedules.updated_at DESC, schedules.id DESC
       LIMIT $5`,
      [query.status || null, query.query || null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return listResponse(result.rows, limit, "updated_at", scheduleResource);
  });

  app.post("/api/agent-tools/v1/schedules", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "schedules:write");
    const body = scheduleCreateSchema.parse(request.body);
    const agent = await getAgent(pool, body.agent);
    if (!agent.enabled) badRequest(`Agent ${agent.name} is disabled`);
    const runAt = new Date(body.at);
    if (runAt.getTime() <= Date.now()) badRequest("Schedule time must be in the future");
    const taskId = body.task ? await resolveResourceId(pool, "tasks", "TASK", body.task) : null;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO schedules
         (title, prompt, agent_id, schedule_kind, next_run_at, interval_seconds,
          created_by_agent_id, idempotency_key, task_id, overlap_policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (created_by_agent_id, idempotency_key)
       WHERE created_by_agent_id IS NOT NULL AND idempotency_key IS NOT NULL
       DO UPDATE SET updated_at = schedules.updated_at
       RETURNING id`,
      [
        body.title,
        body.prompt,
        agent.id,
        body.intervalSeconds ? "interval" : "once",
        runAt,
        body.intervalSeconds ?? null,
        context.agentId,
        body.idempotencyKey ?? null,
        taskId,
        body.overlapPolicy
      ]
    );
    return { schedule: await showSchedule(pool, result.rows[0]!.id) };
  });

  app.get("/api/agent-tools/v1/schedules/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "schedules:read");
    const id = await resolveResourceId(pool, "schedules", "SCHEDULE", refParams.parse(request.params).ref);
    return { schedule: await showSchedule(pool, id) };
  });

  app.post("/api/agent-tools/v1/schedules/:ref/pause", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "schedules:write");
    const id = await resolveResourceId(pool, "schedules", "SCHEDULE", refParams.parse(request.params).ref);
    await pool.query("UPDATE schedules SET enabled = false, updated_at = now() WHERE id = $1", [id]);
    return { schedule: await showSchedule(pool, id) };
  });

  app.post("/api/agent-tools/v1/schedules/:ref/resume", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "schedules:write");
    const id = await resolveResourceId(pool, "schedules", "SCHEDULE", refParams.parse(request.params).ref);
    await withTransaction(pool, async (client) => {
      const result = await client.query<{
        schedule_kind: "once" | "interval";
        interval_seconds: number | null;
        next_run_at: Date;
        last_run_at: Date | null;
      }>("SELECT schedule_kind, interval_seconds, next_run_at, last_run_at FROM schedules WHERE id = $1 FOR UPDATE", [id]);
      const schedule = result.rows[0] ?? notFound("Schedule");
      if (schedule.schedule_kind === "once" && schedule.last_run_at) {
        badRequest("A completed one-time schedule cannot be resumed; create a new schedule");
      }
      let nextRunAt = schedule.next_run_at;
      if (nextRunAt.getTime() <= Date.now()) {
        if (schedule.schedule_kind === "once") badRequest("A one-time schedule needs a new future time");
        nextRunAt = new Date(Date.now() + Number(schedule.interval_seconds) * 1000);
      }
      await client.query(
        "UPDATE schedules SET enabled = true, next_run_at = $2, updated_at = now() WHERE id = $1",
        [id, nextRunAt]
      );
    });
    return { schedule: await showSchedule(pool, id) };
  });

  app.delete("/api/agent-tools/v1/schedules/:ref", async (request) => {
    const context = await requireAgent(pool, request);
    requireCapability(context, "schedules:write");
    const id = await resolveResourceId(pool, "schedules", "SCHEDULE", refParams.parse(request.params).ref);
    const result = await pool.query<{ number: number; title: string }>(
      "DELETE FROM schedules WHERE id = $1 RETURNING number, title",
      [id]
    );
    const schedule = result.rows[0] ?? notFound("Schedule");
    return { deleted: true, schedule: { key: `SCHEDULE-${schedule.number}`, title: schedule.title } };
  });
}

function registerReportRoutes(app: FastifyInstance, pool: DbPool): void {
  app.get("/api/agent-tools/v1/reports", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "reports:read");
    const query = pageSchema.parse(request.query); const cursor = parseCursor(query.cursor); const limit = pageLimit(query.limit);
    const result = await pool.query(
      `SELECT reports.*, agents.name AS author_agent_name, left(report_versions.markdown, 1000) AS content_preview,
              octet_length(report_versions.markdown) AS content_total_bytes
       FROM reports LEFT JOIN agents ON agents.id = reports.author_agent_id
       JOIN report_versions ON report_versions.report_id = reports.id AND report_versions.revision = reports.current_revision
       WHERE ($1::text IS NULL OR reports.status = $1)
         AND ($2::text IS NULL OR reports.title ILIKE '%' || $2 || '%' OR reports.description ILIKE '%' || $2 || '%')
         AND ($3::timestamptz IS NULL OR (reports.updated_at, reports.id) < ($3, $4::uuid))
       ORDER BY reports.updated_at DESC, reports.id DESC LIMIT $5`,
      [query.status || null, query.query || null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return listResponse(result.rows, limit, "updated_at", reportResource);
  });
  app.post("/api/agent-tools/v1/reports", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "reports:write");
    const body = reportCreateSchema.parse(request.body);
    const threadId = body.thread ? await resolveResourceId(pool, "coordination_threads", "THREAD", body.thread) : context.coordinationThreadId;
    const id = await withTransaction(pool, async (client) => {
      const report = await client.query<{ id: string }>(
        `INSERT INTO reports (title, description, project_id, thread_id, author_agent_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [body.title, body.description, body.projectId ?? context.taskProjectId, threadId, context.agentId]
      );
      await client.query("INSERT INTO report_versions (report_id, revision, markdown, created_by_agent_id) VALUES ($1, 1, $2, $3)", [report.rows[0]!.id, body.markdown, context.agentId]);
      return report.rows[0]!.id;
    });
    return { report: await showReport(pool, id) };
  });
  app.get("/api/agent-tools/v1/reports/:ref", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "reports:read");
    return { report: await showReport(pool, await resolveResourceId(pool, "reports", "REPORT", refParams.parse(request.params).ref)) };
  });
  app.post("/api/agent-tools/v1/reports/:ref/revisions", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "reports:write");
    const id = await resolveResourceId(pool, "reports", "REPORT", refParams.parse(request.params).ref); const body = markdownSchema.parse(request.body);
    await withTransaction(pool, async (client) => {
      const locked = await client.query<{ current_revision: number }>("SELECT current_revision FROM reports WHERE id = $1 FOR UPDATE", [id]);
      const revision = (locked.rows[0] ?? notFound("Report")).current_revision + 1;
      await client.query("INSERT INTO report_versions (report_id, revision, markdown, created_by_agent_id) VALUES ($1, $2, $3, $4)", [id, revision, body.markdown, context.agentId]);
      await client.query("UPDATE reports SET current_revision = $2, status = 'draft', updated_at = now() WHERE id = $1", [id, revision]);
    });
    return { report: await showReport(pool, id) };
  });
  app.post("/api/agent-tools/v1/reports/:ref/publish", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "reports:write");
    const id = await resolveResourceId(pool, "reports", "REPORT", refParams.parse(request.params).ref);
    await pool.query("UPDATE reports SET status = 'published', updated_at = now() WHERE id = $1", [id]);
    return { report: await showReport(pool, id) };
  });
}

function registerIncidentRoutes(app: FastifyInstance, pool: DbPool, managedRoot: string): void {
  app.get("/api/agent-tools/v1/incidents", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "incidents:read");
    const query = pageSchema.parse(request.query); const cursor = parseCursor(query.cursor); const limit = pageLimit(query.limit);
    const result = await pool.query(
      `SELECT incidents.*, commander.name AS commander_agent_name, creator.name AS created_by_agent_name,
              left(latest.markdown, 1000) AS content_preview, octet_length(latest.markdown) AS content_total_bytes
       FROM incidents LEFT JOIN agents commander ON commander.id = incidents.commander_agent_id
       LEFT JOIN agents creator ON creator.id = incidents.created_by_agent_id
       LEFT JOIN LATERAL (SELECT markdown FROM incident_updates WHERE incident_id = incidents.id ORDER BY created_at DESC, id DESC LIMIT 1) latest ON true
       WHERE ($1::text IS NULL OR incidents.status = $1)
         AND ($2::text IS NULL OR incidents.title ILIKE '%' || $2 || '%' OR incidents.description ILIKE '%' || $2 || '%')
         AND ($3::timestamptz IS NULL OR (incidents.updated_at, incidents.id) < ($3, $4::uuid))
       ORDER BY incidents.updated_at DESC, incidents.id DESC LIMIT $5`,
      [query.status || null, query.query || null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return listResponse(result.rows, limit, "updated_at", incidentResource);
  });
  app.post("/api/agent-tools/v1/incidents", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "incidents:write"); const body = incidentCreateSchema.parse(request.body);
    const commander = body.to ? await getAgent(pool, body.to) : await getOrchestrator(pool);
    const ids = await withTransaction(pool, async (client) => {
      const thread = await client.query<{ id: string; number: number }>(
        `INSERT INTO coordination_threads
           (title, description, purpose, project_id, created_by_agent_id, primary_agent_id,
            callback_agent_id, origin_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $5, $7) RETURNING id, number`,
        [`Incident: ${body.title}`, body.description, body.markdown, body.projectId ?? context.taskProjectId, context.agentId, commander.id, context.coordinationThreadId]
      );
      const incident = await client.query<{ id: string }>(
        `INSERT INTO incidents (title, description, severity, project_id, thread_id, commander_agent_id, created_by_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [body.title, body.description, body.severity, body.projectId ?? context.taskProjectId, thread.rows[0]!.id, commander.id, context.agentId]
      );
      await client.query(
        `UPDATE coordination_threads
         SET completion_instructions = 'When the incident work is complete, report back to ' || $2 ||
           ' with: aisevak threads complete THREAD-' || $3 || ' --summary-stdin'
         WHERE id = $1`,
        [thread.rows[0]!.id, context.name, thread.rows[0]!.number]
      );
      await client.query("INSERT INTO incident_updates (incident_id, author_agent_id, markdown) VALUES ($1, $2, $3)", [incident.rows[0]!.id, context.agentId, body.markdown]);
      await addParticipants(client, thread.rows[0]!.id, [[context.agentId, "reporter"], [commander.id, "commander"]]);
      const message = await insertMessage(client, { threadId: thread.rows[0]!.id, senderAgentId: context.agentId, recipientAgentId: commander.id, body: body.markdown, type: "incident.declared" });
      if (commander.id !== context.agentId) await queueDelivery(client, managedRoot, thread.rows[0]!.id, message.id, commander.id);
      return { incidentId: incident.rows[0]!.id, threadId: thread.rows[0]!.id };
    });
    return { incident: await showIncident(pool, ids.incidentId), thread: await showThread(pool, ids.threadId) };
  });
  app.get("/api/agent-tools/v1/incidents/:ref", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "incidents:read");
    return { incident: await showIncident(pool, await resolveResourceId(pool, "incidents", "INC", refParams.parse(request.params).ref)) };
  });
  app.post("/api/agent-tools/v1/incidents/:ref/updates", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "incidents:write");
    const id = await resolveResourceId(pool, "incidents", "INC", refParams.parse(request.params).ref); const body = markdownSchema.parse(request.body);
    const incident = await showIncident(pool, id);
    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO incident_updates (incident_id, author_agent_id, markdown) VALUES ($1, $2, $3)", [id, context.agentId, body.markdown]);
      await client.query("UPDATE incidents SET updated_at = now() WHERE id = $1", [id]);
      if (incident.thread_id) {
        const recipientId = incident.commander_agent_id !== context.agentId
          ? incident.commander_agent_id
          : incident.created_by_agent_id !== context.agentId
            ? incident.created_by_agent_id
            : null;
        const message = await insertMessage(client, {
          threadId: incident.thread_id,
          senderAgentId: context.agentId,
          recipientAgentId: recipientId,
          body: body.markdown,
          type: "incident.update"
        });
        if (recipientId) await queueDelivery(client, managedRoot, incident.thread_id, message.id, recipientId);
      }
    });
    return { incident: await showIncident(pool, id) };
  });
  app.post("/api/agent-tools/v1/incidents/:ref/resolve", async (request) => {
    const context = await requireAgent(pool, request); requireCapability(context, "incidents:write");
    const id = await resolveResourceId(pool, "incidents", "INC", refParams.parse(request.params).ref); const body = optionalMarkdownSchema.parse(request.body ?? {});
    const incident = await showIncident(pool, id);
    if (incident.thread_id) {
      await finalizeThread(
        pool,
        managedRoot,
        context,
        incident.thread_id,
        "completed",
        body.markdown || "Incident resolved.",
        undefined,
        async (client) => {
          await client.query("SELECT id FROM incidents WHERE id = $1 FOR UPDATE", [id]);
          if (body.markdown) {
            await client.query("INSERT INTO incident_updates (incident_id, author_agent_id, markdown) VALUES ($1, $2, $3)", [id, context.agentId, body.markdown]);
          }
          await client.query("UPDATE incidents SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1", [id]);
        }
      );
    } else {
      await withTransaction(pool, async (client) => {
        await client.query("SELECT id FROM incidents WHERE id = $1 FOR UPDATE", [id]);
        if (body.markdown) {
          await client.query("INSERT INTO incident_updates (incident_id, author_agent_id, markdown) VALUES ($1, $2, $3)", [id, context.agentId, body.markdown]);
        }
        await client.query("UPDATE incidents SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1", [id]);
      });
    }
    return { incident: await showIncident(pool, id) };
  });
}

export async function requireAgent(pool: DbPool, request: FastifyRequest): Promise<AgentContext> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!token) unauthorized("Agent tool token required");
  const result = await pool.query<{
    agent_id: string | null; agent_thread_id: string | null; coordination_thread_id: string | null;
    task_id: string | null; task_project_id: string | null; role: "worker" | "dispatcher";
    kind: "worker" | "dispatcher" | null; name: string | null; description: string | null; capabilities: unknown;
    assignment_id: string | null; assignment_key: string | null; assignment_status: string | null; assignment_attempt: number | null;
    provider_thread_id: string | null;
  }>(
    `SELECT agent_tool_tokens.agent_id, agent_tool_tokens.agent_thread_id,
            COALESCE(agent_tool_tokens.coordination_thread_id, agent_threads.coordination_thread_id) AS coordination_thread_id,
            agent_tool_tokens.task_id, tasks.project_id AS task_project_id, agent_tool_tokens.role,
            agents.kind, agents.name, agents.description, agents.capabilities,
            COALESCE(agent_tool_tokens.assignment_id, dispatcher_runs.assignment_id, message_deliveries.assignment_id) AS assignment_id,
            task_assignments.assignment_key, task_assignments.status AS assignment_status,
            task_assignments.attempt_count AS assignment_attempt,
            agent_threads.provider_thread_id
     FROM agent_tool_tokens
     LEFT JOIN agents ON agents.id = agent_tool_tokens.agent_id
     LEFT JOIN tasks ON tasks.id = agent_tool_tokens.task_id
     LEFT JOIN agent_threads ON agent_threads.id = agent_tool_tokens.agent_thread_id
     LEFT JOIN dispatcher_runs ON dispatcher_runs.id = agent_tool_tokens.dispatcher_run_id
     LEFT JOIN message_deliveries ON message_deliveries.id = dispatcher_runs.message_delivery_id
     LEFT JOIN task_assignments ON task_assignments.id = COALESCE(agent_tool_tokens.assignment_id, dispatcher_runs.assignment_id, message_deliveries.assignment_id)
       AND (agent_tool_tokens.task_id IS NULL OR task_assignments.task_id = agent_tool_tokens.task_id)
     WHERE agent_tool_tokens.token_hash = $1 AND agent_tool_tokens.expires_at > now() LIMIT 1`,
    [hashToken(token!)]
  );
  const row = result.rows[0];
  if (!row) unauthorized("Invalid agent tool token");
  let agentId = row.agent_id;
  let kind = row.kind ?? row.role;
  let name = row.name;
  let description = row.description;
  let capabilities = row.capabilities;
  if (!agentId) {
    const fallback = row.role === "dispatcher" ? await getOrchestrator(pool) : await agentForTask(pool, row.task_id);
    agentId = fallback.id; kind = fallback.kind; name = fallback.name; description = fallback.description; capabilities = fallback.capabilities;
  }
  return {
    agentId: agentId!, agentThreadId: row.agent_thread_id, coordinationThreadId: row.coordination_thread_id,
    taskId: row.task_id, taskProjectId: row.task_project_id, kind,
    name: name ?? (kind === "dispatcher" ? "Orchestrator" : "Agent"), description: description ?? "",
    capabilities: effectiveCapabilities(kind, capabilities),
    assignmentId: row.assignment_key ? row.assignment_id : null,
    assignmentKey: row.assignment_key,
    assignmentStatus: row.assignment_status,
    assignmentAttempt: row.assignment_attempt,
    providerThreadId: row.provider_thread_id
  };
}

function agentIdentity(context: AgentContext) {
  return { id: context.agentId, name: context.name, description: context.description, kind: context.kind };
}
function currentContext(context: AgentContext, envelope?: JobEnvelope | null) {
  return {
    taskId: context.taskId,
    threadId: context.coordinationThreadId,
    providerSessionId: context.agentThreadId,
    assignmentId: context.assignmentId,
    assignmentKey: context.assignmentKey,
    assignmentStatus: context.assignmentStatus,
    assignmentAttempt: context.assignmentAttempt,
    job: envelope,
    safetyMode: jobSafetyMode(),
    allowedNextCommands: context.assignmentId
      ? ["aisevak assignments show ASSIGNMENT-n", "aisevak assignments send ASSIGNMENT-n --instructions-stdin", "aisevak assignments complete ASSIGNMENT-n --result-stdin", "aisevak assignments block ASSIGNMENT-n --result-stdin"]
      : context.kind === "dispatcher"
        ? ["aisevak tasks create --work-key ...", "aisevak assignments create TASK-n --key ... --to ... --instructions-stdin"]
        : ["aisevak assignments list TASK-n", "aisevak assignments show ASSIGNMENT-n"]
  };
}
function effectiveCapabilities(kind: string, value: unknown): string[] {
  const baseline = kind === "dispatcher" ? ORCHESTRATOR_CAPABILITIES : DEFAULT_WORKER_CAPABILITIES;
  const explicit = Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0
    ? value.filter((item): item is string => typeof item === "string")
    : baseline;
  const caps = new Set(explicit);
  // Stored legacy capabilities are data, not authority. The new route guards
  // deliberately remove bare thread/task creation even when old skills remain.
  caps.delete("threads:create");
  caps.delete("tasks:create");
  if (kind !== "dispatcher") {
    caps.delete("threads:complete");
    caps.delete("tasks:update");
    for (const capability of ["tasks:complete", "assignments:read", "assignments:send", "assignments:complete", "assignments:block"]) caps.add(capability);
  } else {
    for (const capability of ["tasks:create-root", "tasks:create-child", "tasks:update", "assignments:create", "assignments:manage", "assignments:retry"]) caps.add(capability);
  }
  return [...caps];
}
export function requireCapability(context: AgentContext, capability: string): void {
  if (!context.capabilities.includes(capability)) forbidden(`Agent ${context.name} does not have ${capability}`);
}
function requireAnyCapability(context: AgentContext, capabilities: string[]): void {
  if (!capabilities.some((capability) => context.capabilities.includes(capability))) {
    forbidden(`Agent ${context.name} does not have any of: ${capabilities.join(", ")}`);
  }
}

async function recordSafetyEvent(
  client: Queryable,
  input: {
    operation: string;
    context?: Pick<AgentContext, "agentId">;
    taskId?: string | null;
    assignmentId?: string | null;
    workScope?: string | null;
    workKey?: string | null;
    details?: Record<string, unknown>;
    message: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO job_safety_events
       (operation, actor_agent_id, task_id, assignment_id, work_scope, work_key, would_reject, details)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
    [input.operation, input.context?.agentId ?? null, input.taskId ?? null, input.assignmentId ?? null,
      input.workScope ?? null, input.workKey ?? null, JSON.stringify(input.details ?? {})]
  );
  if (jobSafetyMode() === "enforce") throw safetyConflict(input.message);
}

async function cancelPendingAssignmentDelivery(
  client: PoolClient,
  deliveryId: string,
  reason: string
): Promise<void> {
  // Completing/blocking an assignment must make an already-queued delivery
  // inert. A running provider turn is allowed to finish its current turn;
  // its terminalizer observes the failed delivery and will not enqueue a
  // duplicate retry.
  await client.query(
    `UPDATE message_deliveries
     SET status = 'failed', completed_at = now(), error = $2, updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'retrying')`,
    [deliveryId, reason]
  );
  await client.query(
    `UPDATE dispatcher_runs
     SET status = 'cancelled', finished_at = COALESCE(finished_at, now()),
         error = COALESCE(error, $2), updated_at = now()
     WHERE message_delivery_id = $1 AND status IN ('queued', 'cancel_requested')`,
    [deliveryId, reason]
  );
  await client.query(
    `UPDATE dispatcher_runs
     SET status = 'cancel_requested', error = COALESCE(error, $2), updated_at = now()
     WHERE message_delivery_id = $1 AND status = 'running'`,
    [deliveryId, reason]
  );
  await client.query(
    `UPDATE agent_turn_inputs
     SET status = 'failed', error = $2, updated_at = now()
     WHERE message_delivery_id = $1 AND status IN ('queued', 'delivering')`,
    [deliveryId, reason]
  );
}

export function requireTaskOwner(context: AgentContext, task: { agent_id: string }, operation: string): void {
  if (context.kind !== "dispatcher" && context.agentId !== task.agent_id) {
    throw safetyForbidden(`Only the task owner or orchestrator may ${operation}`);
  }
}

async function assertTaskCreationAllowed(
  client: PoolClient,
  context: AgentContext,
  parentTaskId: string | null
): Promise<void> {
  if (parentTaskId) {
    requireCapability(context, "tasks:create-child");
    if (context.taskId && context.taskId !== parentTaskId && context.kind !== "dispatcher") {
      await recordSafetyEvent(client, {
        operation: "task.create.child.context-mismatch",
        context,
        taskId: parentTaskId,
        message: "A child task must be created from its active parent task context"
      });
    }
    return;
  }
  if (context.taskId) {
    await recordSafetyEvent(client, {
      operation: "task.create.root.inside-task",
      context,
      taskId: context.taskId,
      message: "You are inside an active task. Use a keyed child task or a task assignment instead of creating another root task."
    });
  }
  requireCapability(context, "tasks:create-root");
}

async function createOrReuseTaskInTransaction(
  client: PoolClient,
  options: {
    context: AgentContext;
    title: string;
    description: string;
    body: string;
    status: string;
    projectId: string | null;
    recipient: any;
    parentTaskId: string | null;
    workKey: string;
    workScope?: string;
    idempotencyKey?: string;
    managedRoot: string;
  }
): Promise<{ taskId: string; threadId: string; duplicate: boolean; conflict?: boolean }> {
  const workKey = normalizeWorkKey(options.workKey);
  const workScope = normalizeWorkScope(options.workScope, taskWorkScope({
    parentTaskId: options.parentTaskId,
    projectId: options.projectId,
    actorId: options.context.agentId
  }));
  const fingerprint = taskFingerprint({
    title: options.title,
    description: options.description,
    body: options.body,
    projectId: options.projectId,
    agentId: options.recipient.id,
    parentTaskId: options.parentTaskId,
    workScope,
    workKey
  });

  // Resolve identity before applying parent limits. An exact retry must reuse
  // the existing job even if the parent has since reached its active fan-out
  // limit. The unique identity index is the final concurrency guard below.
  const existing = await client.query<{ id: string; number: number; coordination_thread_id: string | null; work_fingerprint: string }>(
    `SELECT id, number, coordination_thread_id, work_fingerprint
     FROM tasks WHERE work_scope = $1 AND work_key = $2 FOR UPDATE`, [workScope, workKey]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.work_fingerprint !== fingerprint) {
      await recordSafetyEvent(client, {
        operation: "task.create.identity-conflict",
        context: options.context,
        taskId: row.id,
        workScope,
        workKey,
        details: { existingFingerprint: row.work_fingerprint, requestedFingerprint: fingerprint },
        message: `Work key ${workScope}/${workKey} already belongs to TASK-${row.number} with different immutable input`
      });
      return { taskId: row.id, threadId: row.coordination_thread_id ?? "", duplicate: true, conflict: true };
    }
    if (!row.coordination_thread_id) {
      const thread = await client.query<{ id: string }>(
        `INSERT INTO coordination_threads
           (title, description, purpose, project_id, task_id, created_by_agent_id, primary_agent_id, callback_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $6) RETURNING id`,
        [options.title, options.description, options.body || options.description, options.projectId, row.id, options.context.agentId, options.recipient.id]
      );
      await client.query("UPDATE tasks SET coordination_thread_id = $2 WHERE id = $1", [row.id, thread.rows[0]!.id]);
      return { taskId: row.id, threadId: thread.rows[0]!.id, duplicate: true };
    }
    return { taskId: row.id, threadId: row.coordination_thread_id, duplicate: true };
  }

  if (options.parentTaskId) {
    const parent = await client.query<{ id: string; parent_task_id: string | null; orchestration_policy: unknown; status: string }>(
      "SELECT id, parent_task_id, orchestration_policy, status FROM tasks WHERE id = $1 FOR UPDATE", [options.parentTaskId]
    );
    const parentRow = parent.rows[0];
    if (!parentRow) notFound("Parent task");
    if (["completed", "blocked", "cancelled"].includes(parentRow.status)) {
      await recordSafetyEvent(client, {
        operation: "task.create.child.parent-stopped",
        context: options.context,
        taskId: options.parentTaskId,
        workScope,
        workKey,
        details: { parentStatus: parentRow.status },
        message: `Cannot create a child task under a ${parentRow.status} parent task`
      });
    }
    const concurrentExisting = await client.query<{ id: string; number: number; coordination_thread_id: string | null; work_fingerprint: string }>(
      `SELECT id, number, coordination_thread_id, work_fingerprint
       FROM tasks WHERE work_scope = $1 AND work_key = $2 FOR UPDATE`, [workScope, workKey]
    );
    if (concurrentExisting.rows[0]) {
      const row = concurrentExisting.rows[0];
      if (row.work_fingerprint !== fingerprint) {
        await recordSafetyEvent(client, {
          operation: "task.create.identity-conflict",
          context: options.context,
          taskId: row.id,
          workScope,
          workKey,
          details: { existingFingerprint: row.work_fingerprint, requestedFingerprint: fingerprint, concurrent: true },
          message: `Work key ${workScope}/${workKey} already belongs to TASK-${row.number} with different immutable input`
        });
        return { taskId: row.id, threadId: row.coordination_thread_id ?? "", duplicate: true, conflict: true };
      }
      return { taskId: row.id, threadId: row.coordination_thread_id ?? "", duplicate: true };
    }
    const policy = orchestrationPolicy(parentRow.orchestration_policy);
    const children = await client.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM tasks WHERE parent_task_id = $1 AND status NOT IN ('completed', 'blocked', 'cancelled')",
      [options.parentTaskId]
    );
    if (Number(children.rows[0]?.count ?? 0) >= policy.maxActiveChildren) {
      await recordSafetyEvent(client, {
        operation: "task.create.child.fanout-limit",
        context: options.context,
        taskId: options.parentTaskId,
        workScope,
        workKey,
        details: { limit: policy.maxActiveChildren },
        message: `Parent task has reached its active child limit (${policy.maxActiveChildren})`
      });
    }
    const depthResult = await client.query<{ depth: number }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_task_id, 0::int AS depth FROM tasks WHERE id = $1
         UNION ALL
         SELECT parent.id, parent.parent_task_id, chain.depth + 1
         FROM tasks parent JOIN chain ON parent.id = chain.parent_task_id
       ) SELECT COALESCE(max(depth), 0)::int AS depth FROM chain`, [options.parentTaskId]
    );
    const depth = childDepth(depthResult.rows[0]?.depth) + 1;
    if (depth > policy.maxChildDepth) {
      await recordSafetyEvent(client, {
        operation: "task.create.child.depth-limit",
        context: options.context,
        taskId: options.parentTaskId,
        workScope,
        workKey,
        details: { depth, limit: policy.maxChildDepth },
        message: `Child task depth ${depth} exceeds the limit (${policy.maxChildDepth})`
      });
    }
  }

  const inserted = await client.query<{ id: string; number: number }>(
    `INSERT INTO tasks
       (title, description, body, status, project_id, agent_id, parent_task_id, work_scope, work_key, work_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (work_scope, work_key) DO NOTHING
     RETURNING id, number`,
    [options.title, options.description, options.body, options.status, options.projectId, options.recipient.id,
      options.parentTaskId, workScope, workKey, fingerprint]
  );
  if (!inserted.rows[0]) {
    const concurrent = await client.query<{ id: string; number: number; coordination_thread_id: string | null; work_fingerprint: string }>(
      `SELECT id, number, coordination_thread_id, work_fingerprint
       FROM tasks WHERE work_scope = $1 AND work_key = $2 FOR UPDATE`, [workScope, workKey]
    );
    const row = concurrent.rows[0] ?? notFound("Task created by concurrent request");
    if (row.work_fingerprint !== fingerprint) {
      await recordSafetyEvent(client, {
        operation: "task.create.identity-conflict",
        context: options.context,
        taskId: row.id,
        workScope,
        workKey,
        details: { existingFingerprint: row.work_fingerprint, requestedFingerprint: fingerprint, concurrent: true },
        message: `Work key ${workScope}/${workKey} already belongs to TASK-${row.number} with different immutable input`
      });
      return { taskId: row.id, threadId: row.coordination_thread_id ?? "", duplicate: true, conflict: true };
    }
    return { taskId: row.id, threadId: row.coordination_thread_id ?? "", duplicate: true };
  }
  const task = inserted.rows[0]!;
  const thread = await client.query<{ id: string; number: number }>(
    `INSERT INTO coordination_threads
       (title, description, purpose, project_id, task_id, created_by_agent_id, primary_agent_id,
        callback_agent_id, origin_thread_id, completion_instructions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $8,
             'Report results to ' || $9 || ' through the task assignment or coordination thread.')
     RETURNING id, number`,
    [options.title, options.description, options.body || options.description, options.projectId, task.id,
      options.context.agentId, options.recipient.id, options.context.coordinationThreadId, options.context.name]
  );
  const threadRow = thread.rows[0]!;
  await client.query("UPDATE tasks SET coordination_thread_id = $2 WHERE id = $1", [task.id, threadRow.id]);
  await addParticipants(client, threadRow.id, [[options.context.agentId, "initiator"], [options.recipient.id, "assignee"]]);
  const message = await insertMessage(client, {
    threadId: threadRow.id,
    senderAgentId: options.context.agentId,
    recipientAgentId: options.recipient.id,
    body: `Task TASK-${task.number}: ${options.title}\n\n${options.description}\n\n${options.body}`.trim(),
    type: "task.created",
    idempotencyKey: options.idempotencyKey
  });
  if (options.recipient.id !== options.context.agentId) await queueDelivery(client, options.managedRoot, threadRow.id, message.id, options.recipient.id);
  return { taskId: task.id, threadId: threadRow.id, duplicate: false };
}

async function getAgent(queryable: Queryable, ref: string): Promise<any> {
  const normalized = ref.replace(/^AGENT-/i, "");
  const result = await queryable.query(
    `SELECT id, kind, name, description, model, model_options, capabilities, instructions, enabled, created_at, updated_at
     FROM agents WHERE id::text = $1 OR lower(name) = lower($1) LIMIT 1`,
    [normalized]
  );
  const row = result.rows[0] ?? notFound("Agent");
  const skills = await queryable.query(
    `SELECT skills.name, skills.description
     FROM skills
     WHERE skills.enabled = true
       AND (skills.default_for_agents = true OR EXISTS (
         SELECT 1 FROM agent_skills WHERE agent_skills.skill_id = skills.id AND agent_skills.agent_id = $1
       ) OR position('@skill(' || skills.name || ')' in COALESCE($2, '')) > 0)
     ORDER BY skills.name`,
    [row.id, row.instructions]
  );
  const { instructions: _instructions, ...publicRow } = row;
  return {
    ...publicRow,
    key: `AGENT-${row.name}`,
    capabilities: effectiveCapabilities(row.kind, row.capabilities),
    skills: skills.rows
  };
}
async function getOrchestrator(queryable: Queryable): Promise<any> {
  const result = await queryable.query("SELECT * FROM agents WHERE kind = 'dispatcher' AND enabled = true ORDER BY created_at ASC LIMIT 1");
  const row = result.rows[0] ?? notFound("Orchestrator agent");
  return { ...row, capabilities: effectiveCapabilities(row.kind, row.capabilities) };
}
async function agentForTask(queryable: Queryable, taskId: string | null): Promise<any> {
  if (!taskId) return getOrchestrator(queryable);
  const result = await queryable.query("SELECT agents.* FROM tasks JOIN agents ON agents.id = tasks.agent_id WHERE tasks.id = $1", [taskId]);
  return result.rows[0] ?? getOrchestrator(queryable);
}

async function resolveResourceId(queryable: Queryable, table: string, prefix: string, ref: string): Promise<string> {
  const allowed = new Set(["coordination_threads", "tasks", "thread_messages", "reports", "incidents", "schedules", "task_assignments"]);
  if (!allowed.has(table)) throw new Error("Unsupported resource table");
  const number = ref.match(new RegExp(`^(?:${prefix}-)?(\\d+)$`, "i"));
  const result = number
    ? await queryable.query(`SELECT id FROM ${table} WHERE number = $1 LIMIT 1`, [Number(number[1])])
    : await queryable.query(`SELECT id FROM ${table} WHERE id = $1::uuid LIMIT 1`, [ref]);
  return (result.rows[0] ?? notFound(prefix)).id;
}

async function showThread(queryable: Queryable, id: string, includeContent = false): Promise<any> {
  const result = await queryable.query(
    `SELECT coordination_threads.*, primary_agent.name AS primary_agent_name,
            callback_agent.name AS callback_agent_name, creator_agent.name AS created_by_agent_name,
            origin_thread.number AS origin_thread_number,
            left(coordination_threads.purpose, 1000) AS content_preview,
            octet_length(coordination_threads.purpose) AS content_total_bytes
     FROM coordination_threads
     LEFT JOIN agents primary_agent ON primary_agent.id = coordination_threads.primary_agent_id
     LEFT JOIN agents callback_agent ON callback_agent.id = coordination_threads.callback_agent_id
     LEFT JOIN agents creator_agent ON creator_agent.id = coordination_threads.created_by_agent_id
     LEFT JOIN coordination_threads origin_thread ON origin_thread.id = coordination_threads.origin_thread_id
     WHERE coordination_threads.id = $1`, [id]);
  return threadResource(result.rows[0] ?? notFound("Thread"), includeContent);
}
async function showMessage(queryable: Queryable, id: string, includeContent = false): Promise<any> {
  const result = await queryable.query(
    `SELECT thread_messages.*, sender.name AS sender_agent_name, recipient.name AS recipient_agent_name,
            message_deliveries.status AS delivery_status, message_deliveries.attempt_count AS delivery_attempt_count
     FROM thread_messages LEFT JOIN agents sender ON sender.id = thread_messages.sender_agent_id
     LEFT JOIN agents recipient ON recipient.id = thread_messages.recipient_agent_id
     LEFT JOIN message_deliveries ON message_deliveries.message_id = thread_messages.id
     WHERE thread_messages.id = $1`, [id]);
  return messageResource(result.rows[0] ?? notFound("Message"), includeContent);
}
async function showTask(queryable: Queryable, id: string, includeContent = false): Promise<any> {
  const result = await queryable.query(
    `SELECT tasks.*, agents.name AS agent_name, projects.name AS project_name,
            parent.number AS parent_task_number,
            (SELECT count(*)::int FROM task_assignments WHERE task_assignments.task_id = tasks.id) AS assignment_count,
            (SELECT count(*)::int FROM task_assignments WHERE task_assignments.task_id = tasks.id AND task_assignments.status IN ('queued', 'running')) AS active_assignment_count,
            (SELECT count(*)::int FROM tasks child WHERE child.parent_task_id = tasks.id AND child.status NOT IN ('completed', 'blocked', 'cancelled')) AS active_child_count,
            left(tasks.body, 1000) AS content_preview, octet_length(tasks.body) AS content_total_bytes
     FROM tasks JOIN agents ON agents.id = tasks.agent_id LEFT JOIN projects ON projects.id = tasks.project_id
       LEFT JOIN tasks parent ON parent.id = tasks.parent_task_id
     WHERE tasks.id = $1`, [id]);
  const row = result.rows[0] ?? notFound("Task");
  let assignmentRows: { rows: any[] } = { rows: [] };
  try {
    assignmentRows = await queryable.query(
      `SELECT task_assignments.*, agents.name AS assigned_agent_name,
              creator.name AS created_by_agent_name,
              message_deliveries.status AS delivery_status
       FROM task_assignments
       JOIN agents ON agents.id = task_assignments.assigned_agent_id
       LEFT JOIN agents creator ON creator.id = task_assignments.created_by_agent_id
       LEFT JOIN message_deliveries ON message_deliveries.id = task_assignments.active_delivery_id
       WHERE task_assignments.task_id = $1
       ORDER BY task_assignments.number ASC`, [id]);
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("task_assignments")) throw error;
  }
  return taskResource({ ...row, assignments: assignmentRows.rows.map((assignment) => assignmentResource(assignment)) }, includeContent);
}
async function showAssignment(queryable: Queryable, id: string, includeContent = false): Promise<any> {
  const result = await queryable.query(
    `SELECT task_assignments.*, tasks.number AS task_number, tasks.title AS task_title,
            tasks.coordination_thread_id, agents.name AS assigned_agent_name,
            creator.name AS created_by_agent_name,
            message_deliveries.status AS delivery_status
     FROM task_assignments
     JOIN tasks ON tasks.id = task_assignments.task_id
     JOIN agents ON agents.id = task_assignments.assigned_agent_id
     LEFT JOIN agents creator ON creator.id = task_assignments.created_by_agent_id
     LEFT JOIN message_deliveries ON message_deliveries.id = task_assignments.active_delivery_id
     WHERE task_assignments.id = $1`, [id]);
  const row = result.rows[0] ?? notFound("Assignment");
  return assignmentResource(row, includeContent);
}
async function showReport(queryable: Queryable, id: string, includeContent = false): Promise<any> {
  const result = await queryable.query(
    `SELECT reports.*, agents.name AS author_agent_name, report_versions.markdown,
            left(report_versions.markdown, 1000) AS content_preview, octet_length(report_versions.markdown) AS content_total_bytes
     FROM reports LEFT JOIN agents ON agents.id = reports.author_agent_id
     JOIN report_versions ON report_versions.report_id = reports.id AND report_versions.revision = reports.current_revision
     WHERE reports.id = $1`, [id]);
  return reportResource(result.rows[0] ?? notFound("Report"), includeContent);
}
async function showIncident(queryable: Queryable, id: string, includeContent = false): Promise<any> {
  const result = await queryable.query(
    `SELECT incidents.*, commander.name AS commander_agent_name, creator.name AS created_by_agent_name,
            latest.markdown, left(latest.markdown, 1000) AS content_preview, octet_length(latest.markdown) AS content_total_bytes
     FROM incidents LEFT JOIN agents commander ON commander.id = incidents.commander_agent_id
     LEFT JOIN agents creator ON creator.id = incidents.created_by_agent_id
     LEFT JOIN LATERAL (SELECT markdown FROM incident_updates WHERE incident_id = incidents.id ORDER BY created_at DESC, id DESC LIMIT 1) latest ON true
     WHERE incidents.id = $1`, [id]);
  return incidentResource(result.rows[0] ?? notFound("Incident"), includeContent);
}

async function showSchedule(queryable: Queryable, id: string, includeContent = false): Promise<any> {
  const result = await queryable.query(
    `SELECT schedules.*,
            agents.name AS agent_name,
            creator.name AS created_by_agent_name,
            agent_threads.title AS last_thread_title,
            latest.status AS last_run_status,
            (SELECT count(*)::int FROM schedule_runs WHERE schedule_runs.schedule_id = schedules.id) AS run_count,
            left(schedules.prompt, 1000) AS content_preview,
            octet_length(schedules.prompt) AS content_total_bytes,
            CASE
              WHEN schedules.enabled THEN 'scheduled'
              WHEN schedules.schedule_kind = 'once' AND schedules.last_run_at IS NOT NULL THEN 'completed'
              ELSE 'paused'
            END AS status
     FROM schedules
     JOIN agents ON agents.id = schedules.agent_id
     LEFT JOIN agents creator ON creator.id = schedules.created_by_agent_id
     LEFT JOIN agent_threads ON agent_threads.id = schedules.last_agent_thread_id
     LEFT JOIN LATERAL (
       SELECT dispatcher_runs.status
       FROM schedule_runs
       JOIN dispatcher_runs ON dispatcher_runs.id = schedule_runs.dispatcher_run_id
       WHERE schedule_runs.schedule_id = schedules.id
       ORDER BY schedule_runs.scheduled_for DESC
       LIMIT 1
     ) latest ON true
     WHERE schedules.id = $1`,
    [id]
  );
  return scheduleResource(result.rows[0] ?? notFound("Schedule"), includeContent);
}

async function lockThread(client: PoolClient, id: string): Promise<any> {
  const result = await client.query("SELECT * FROM coordination_threads WHERE id = $1 FOR UPDATE", [id]);
  return result.rows[0] ?? notFound("Thread");
}
async function defaultRecipient(queryable: Queryable, thread: any, senderAgentId: string): Promise<any | null> {
  const target = senderAgentId === thread.primary_agent_id ? thread.callback_agent_id : thread.primary_agent_id;
  return target ? getAgent(queryable, target) : null;
}
async function existingIdempotentMessage(queryable: Queryable, senderAgentId: string, key?: string): Promise<any | null> {
  if (!key) return null;
  const result = await queryable.query("SELECT id, thread_id FROM thread_messages WHERE sender_agent_id = $1 AND idempotency_key = $2 LIMIT 1", [senderAgentId, key]);
  return result.rows[0] ?? null;
}
async function insertMessage(client: PoolClient, input: {
  threadId: string; senderAgentId: string; recipientAgentId: string | null; body: string; type: string;
  parentMessageId?: string | null; idempotencyKey?: string;
}): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO thread_messages
       (thread_id, sender_agent_id, recipient_agent_id, parent_message_id, message_type, body, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.threadId, input.senderAgentId, input.recipientAgentId, input.parentMessageId ?? null, input.type, input.body, input.idempotencyKey ?? null]
  );
  await client.query("UPDATE coordination_threads SET last_activity_at = now(), updated_at = now() WHERE id = $1", [input.threadId]);
  return result.rows[0]!;
}
async function addParticipants(client: PoolClient, threadId: string, participants: Array<[string, string]>): Promise<void> {
  for (const [agentId, role] of participants) {
    await client.query(
      `INSERT INTO thread_participants (thread_id, agent_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (thread_id, agent_id) DO UPDATE SET role = CASE
         WHEN thread_participants.role IN ('initiator', 'assignee', 'commander') THEN thread_participants.role ELSE EXCLUDED.role END`,
      [threadId, agentId, role]
    );
  }
}

export async function cancelStaleQueuedAgentThreadRuns(
  queryable: Queryable,
  agentThreadId: string,
  ownershipGeneration: number,
  preserveCoordination = false
): Promise<void> {
  if (isDbPool(queryable)) {
    await withTransaction(queryable, async (client) => {
      await cancelStaleQueuedAgentThreadRuns(client, agentThreadId, ownershipGeneration, preserveCoordination);
    });
    return;
  }
  const error = "The queued turn was cancelled because thread ownership changed before it started";
  const workerRuns = await queryable.query<{ id: string }>(
    `UPDATE task_runs
     SET status = 'cancelled',
         error = $3,
         finished_at = now(),
         updated_at = now()
     WHERE agent_thread_id = $1
       AND status = 'queued'
       AND agent_thread_generation <> $2
     RETURNING id`,
    [agentThreadId, ownershipGeneration, error]
  );
  const dispatcherRuns = await queryable.query<{ id: string; message_delivery_id: string | null }>(
    `UPDATE dispatcher_runs
     SET status = 'cancelled',
         error = $3,
         finished_at = now(),
         updated_at = now()
       WHERE agent_thread_id = $1
         AND status = 'queued'
         AND ($4::boolean = false OR scope <> 'coordination')
         AND agent_thread_generation <> $2
         RETURNING id, message_delivery_id`,
    [agentThreadId, ownershipGeneration, error, preserveCoordination]
  );

  for (const run of workerRuns.rows) {
    await failStaleQueuedRunInputs(queryable, "task_run_id", run.id, null, error);
  }
  for (const run of dispatcherRuns.rows) {
    await failStaleQueuedRunInputs(queryable, "dispatcher_run_id", run.id, run.message_delivery_id, error);
  }
}

function isDbPool(queryable: Queryable): queryable is DbPool {
  return queryable instanceof pg.Pool;
}

async function failStaleQueuedRunInputs(
  queryable: Queryable,
  runColumn: "task_run_id" | "dispatcher_run_id",
  runId: string,
  fallbackDeliveryId: string | null,
  error: string
): Promise<void> {
  const inputs = await queryable.query<{ message_delivery_id: string | null }>(
    `UPDATE agent_turn_inputs
     SET status = 'failed', error = $2, updated_at = now()
     WHERE ${runColumn} = $1
       AND status IN ('queued', 'delivering')
     RETURNING message_delivery_id`,
    [runId, error]
  );
  const deliveryIds = new Set(
    inputs.rows
      .map((input) => input.message_delivery_id)
      .filter((id): id is string => Boolean(id))
  );
  if (fallbackDeliveryId) deliveryIds.add(fallbackDeliveryId);
  for (const deliveryId of deliveryIds) {
    await queryable.query(
      `UPDATE message_deliveries
       SET status = 'failed', completed_at = now(), error = $2, updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'retrying', 'running')`,
      [deliveryId, error]
    );
    await queryable.query(
      `UPDATE dispatcher_runs
       SET status = 'cancelled',
           finished_at = COALESCE(finished_at, now()),
           error = COALESCE(error, $2),
           updated_at = now()
       WHERE message_delivery_id = $1
         AND status IN ('queued', 'cancel_requested')`,
      [deliveryId, error]
    );
  }
}

async function queueDelivery(
  client: PoolClient,
  managedRoot: string,
  threadId: string,
  messageId: string,
  recipientAgentId: string,
  assignmentId?: string | null
): Promise<string | null> {
  const delivery = await client.query<{ id: string; status: string }>(
    `INSERT INTO message_deliveries (message_id, recipient_agent_id, assignment_id) VALUES ($1, $2, $3)
     ON CONFLICT (message_id, recipient_agent_id) DO UPDATE SET assignment_id = COALESCE(message_deliveries.assignment_id, EXCLUDED.assignment_id), updated_at = now()
     RETURNING id, status`, [messageId, recipientAgentId, assignmentId ?? null]);
  const deliveryRow = delivery.rows[0];
  if (!deliveryRow || deliveryRow.status === "completed" || deliveryRow.status === "failed") return deliveryRow?.id ?? null;
  const thread = await showThread(client, threadId, true);
  const recipient = await getAgent(client, recipientAgentId);
  const linkedTask = thread.task_id
    ? await client.query<{ agent_id: string }>("SELECT agent_id FROM tasks WHERE id = $1", [thread.task_id])
    : null;
  const linkedTaskId = linkedTask?.rows[0]?.agent_id === recipientAgentId ? thread.task_id : null;
  const project = thread.project_id
    ? await client.query<{ local_path: string; workspace_mode: string; source: string }>("SELECT local_path, workspace_mode, source FROM projects WHERE id = $1", [thread.project_id])
    : null;
  const existing = await client.query<AgentThreadSession>(
    `SELECT id, task_id, project_id, ownership_generation, runtime_home, provider_thread_id, cwd FROM agent_threads
     WHERE coordination_thread_id = $1 AND agent_id = $2 LIMIT 1 FOR UPDATE`, [threadId, recipientAgentId]);
  let session = existing.rows[0];
  let ownershipTransferUnsafe = false;
  const desiredRuntimeHome = linkedTaskId
    ? managedCodexHome(managedRoot, linkedTaskId)
    : managedCodexHome(managedRoot, `thread-${threadId}-${recipientAgentId}`);
  const desiredCwd = project?.rows[0]?.local_path ?? managedRoot;
  if (session) {
    const desiredTaskId = linkedTaskId;
    ownershipTransferUnsafe =
      session.task_id !== desiredTaskId ||
      session.project_id !== thread.project_id ||
      session.cwd !== desiredCwd ||
      session.runtime_home !== desiredRuntimeHome;
    if (linkedTaskId) {
      await client.query(
        "UPDATE agent_threads SET task_id = NULL, updated_at = now() WHERE task_id = $1 AND id <> $2",
        [linkedTaskId, session.id]
      );
    }
    const updated = await client.query<AgentThreadSession>(
      `UPDATE agent_threads
       SET task_id = $2,
           project_id = $3,
           runtime_home = $4,
           cwd = $5,
           provider_thread_id = CASE
             WHEN task_id IS NOT DISTINCT FROM $2
               AND runtime_home = $4
               AND project_id IS NOT DISTINCT FROM $3
               AND cwd IS NOT DISTINCT FROM $5
               THEN provider_thread_id
             ELSE NULL
           END,
           ownership_generation = ownership_generation + CASE
             WHEN task_id IS DISTINCT FROM $2
               OR runtime_home IS DISTINCT FROM $4
               OR project_id IS DISTINCT FROM $3
               OR cwd IS DISTINCT FROM $5
               THEN 1
             ELSE 0
            END,
           updated_at = now()
       WHERE id = $1
       RETURNING id, task_id, project_id, ownership_generation, runtime_home, provider_thread_id, cwd`,
      [session.id, desiredTaskId, thread.project_id, desiredRuntimeHome, desiredCwd]
    );
    session = updated.rows[0];
    if (session) {
      await cancelStaleQueuedAgentThreadRuns(client, session.id, session.ownership_generation, true);
    }
  }
  if (!session && linkedTaskId) {
    ownershipTransferUnsafe = true;
    session = await transferTaskAgentThread(client, {
      threadId,
      taskId: linkedTaskId,
      recipientAgentId,
      model: recipient.model,
      modelOptions: modelOptionsFor(recipient.model, recipient.model_options),
      runtimeHome: managedCodexHome(managedRoot, linkedTaskId),
      preserveCoordination: true
    });
    if (session) {
      const updated = await client.query<AgentThreadSession>(
        `UPDATE agent_threads
         SET task_id = $2,
             project_id = $3,
             cwd = $4,
             runtime_home = $5,
             provider_thread_id = CASE
               WHEN task_id IS NOT DISTINCT FROM $2
                 AND project_id IS NOT DISTINCT FROM $3
                 AND cwd IS NOT DISTINCT FROM $4
                 AND runtime_home = $5
                 THEN provider_thread_id
               ELSE NULL
             END,
             ownership_generation = ownership_generation + CASE
               WHEN task_id IS DISTINCT FROM $2
                 OR project_id IS DISTINCT FROM $3
                 OR cwd IS DISTINCT FROM $4
                 OR runtime_home IS DISTINCT FROM $5
                 THEN 1
               ELSE 0
             END,
             updated_at = now()
         WHERE id = $1
         RETURNING id, task_id, project_id, ownership_generation, runtime_home, provider_thread_id, cwd`,
        [session.id, linkedTaskId, thread.project_id, desiredCwd, desiredRuntimeHome]
      );
      session = updated.rows[0];
      if (session) await cancelStaleQueuedAgentThreadRuns(client, session.id, session.ownership_generation, true);
    }
  }
  if (!session) {
    const runtimeHome = desiredRuntimeHome;
    const created = await client.query<AgentThreadSession>(
      `INSERT INTO agent_threads
         (title, agent_id, task_id, project_id, provider_instance_id, model, model_options, cwd, runtime_home, coordination_thread_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (coordination_thread_id, agent_id)
         WHERE coordination_thread_id IS NOT NULL
       DO NOTHING
       RETURNING id, task_id, project_id, ownership_generation, runtime_home, provider_thread_id, cwd`,
      [thread.title, recipientAgentId, linkedTaskId, thread.project_id, recipient.provider_instance_id || "codex-local", recipient.model, JSON.stringify(modelOptionsFor(recipient.model, recipient.model_options)), desiredCwd, runtimeHome, threadId]
    );
    session = created.rows[0];
    if (!session) {
      const concurrent = await client.query<AgentThreadSession>(
        `SELECT id, task_id, project_id, ownership_generation, runtime_home, provider_thread_id, cwd
         FROM agent_threads
         WHERE coordination_thread_id = $1 AND agent_id = $2
         LIMIT 1 FOR UPDATE`, [threadId, recipientAgentId]
      );
      session = concurrent.rows[0];
    }
    if (!session) throw new Error("Agent session was created concurrently but could not be read");
  }

  const message = await showMessage(client, messageId, true);
  const envelope = await loadJobEnvelope(client, thread.task_id, assignmentId ?? null, {
    coordinationThreadId: threadId,
    agentThreadId: session.id,
    providerThreadId: session.provider_thread_id
  });
  if (!ownershipTransferUnsafe && await queueIncrementalCoordinationInput(
    client,
    session.id,
    delivery.rows[0]!.id,
    coordinationIncrementalPrompt(message, envelope),
    assignmentId
  )) {
    return delivery.rows[0]!.id;
  }

  const history = await client.query(
    `SELECT thread_messages.message_type, thread_messages.body, thread_messages.created_at,
            sender.name AS sender_agent_name, recipient.name AS recipient_agent_name
     FROM thread_messages LEFT JOIN agents sender ON sender.id = thread_messages.sender_agent_id
     LEFT JOIN agents recipient ON recipient.id = thread_messages.recipient_agent_id
     WHERE thread_messages.thread_id = $1 ORDER BY thread_messages.created_at DESC, thread_messages.id DESC LIMIT 12`, [threadId]);
  const skills = await resolveAgentSkills(client, recipientAgentId, thread.project_id, thread.task_id);
  const prompt = session.provider_thread_id
    ? coordinationIncrementalPrompt(message, envelope)
    : coordinationPrompt(thread, recipient, message, history.rows.reverse(), envelope);
  const workspaceMode = thread.project_id
    ? project?.rows[0]?.workspace_mode ?? "unknown"
    : "projectless";
  const workspaceSource = thread.project_id
    ? project?.rows[0]?.source ?? "unknown"
    : "projectless";
  const createdRun = await client.query<{ id: string }>(
    `INSERT INTO dispatcher_runs
       (task_id, assignment_id, trigger, scope, agent_thread_id, agent_thread_generation, workspace_key, workspace_mode, workspace_source, message_delivery_id, status, cwd, codex_home,
        codex_thread_id, model, model_options, prompt, skills_snapshot)
     VALUES ($1, $2, 'message', 'coordination', $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [thread.task_id, assignmentId ?? null, session!.id, session!.ownership_generation, thread.project_id ?? "",
      workspaceMode,
      workspaceSource,
      delivery.rows[0]!.id, session!.cwd, session!.runtime_home, session!.provider_thread_id,
      recipient.model, JSON.stringify(modelOptionsFor(recipient.model, recipient.model_options)), prompt, serializeCodexSkillSnapshots(skills)]
  );
  await migrateStaleCoordinationRuns(client, session.id, session.ownership_generation, createdRun.rows[0]!.id);
  return delivery.rows[0]!.id;
}

async function migrateStaleCoordinationRuns(
  client: PoolClient,
  agentThreadId: string,
  ownershipGeneration: number,
  replacementRunId: string
): Promise<void> {
  const staleRuns = await client.query<{
    id: string;
    message_delivery_id: string | null;
    prompt: string;
  }>(
    `SELECT id, message_delivery_id, prompt
     FROM dispatcher_runs
     WHERE agent_thread_id = $1
       AND scope = 'coordination'
       AND status = 'queued'
       AND agent_thread_generation <> $2
       AND id <> $3
     ORDER BY queued_at ASC, id ASC`,
    [agentThreadId, ownershipGeneration, replacementRunId]
  );
  for (const stale of staleRuns.rows) {
    let message = stale.prompt;
    if (stale.message_delivery_id) {
      const source = await client.query<{ body: string }>(
        `SELECT thread_messages.body
         FROM message_deliveries
         JOIN thread_messages ON thread_messages.id = message_deliveries.message_id
         WHERE message_deliveries.id = $1`,
        [stale.message_delivery_id]
      );
      message = source.rows[0]?.body ?? message;
    }
        await client.query(
          `INSERT INTO agent_turn_inputs
             (agent_thread_id, dispatcher_run_id, message_delivery_id, assignment_id, message)
           VALUES ($1, $2, $3, (SELECT assignment_id FROM message_deliveries WHERE id = $3), $4)
           ON CONFLICT (message_delivery_id) WHERE message_delivery_id IS NOT NULL DO UPDATE
             SET agent_thread_id = EXCLUDED.agent_thread_id,
                 dispatcher_run_id = EXCLUDED.dispatcher_run_id,
                 assignment_id = COALESCE(EXCLUDED.assignment_id, agent_turn_inputs.assignment_id)
             WHERE agent_turn_inputs.status = 'queued'`,
      [agentThreadId, replacementRunId, stale.message_delivery_id, message]
    );
    await client.query(
      `UPDATE dispatcher_runs
       SET message_delivery_id = NULL,
           status = 'cancelled',
           finished_at = now(),
           error = 'Superseded by an ownership transfer',
           updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [stale.id]
    );
  }
}

async function queueIncrementalCoordinationInput(
  client: PoolClient,
  agentThreadId: string,
  messageDeliveryId: string,
  message: string,
  assignmentId?: string | null
): Promise<boolean> {
  await client.query("SELECT id FROM agent_threads WHERE id = $1 FOR UPDATE", [agentThreadId]);
  const active = await client.query<{
    id: string;
    status: "queued" | "running";
    message_delivery_id: string | null;
  }>(
    `SELECT dispatcher_runs.id, dispatcher_runs.status::text, dispatcher_runs.message_delivery_id
     FROM dispatcher_runs
     JOIN agent_threads ON agent_threads.id = dispatcher_runs.agent_thread_id
     WHERE dispatcher_runs.agent_thread_id = $1
       AND dispatcher_runs.scope = 'coordination'
       AND dispatcher_runs.agent_thread_generation = agent_threads.ownership_generation
       AND dispatcher_runs.status IN ('queued', 'running')
     ORDER BY CASE WHEN dispatcher_runs.status = 'running' THEN 0 ELSE 1 END,
              CASE WHEN dispatcher_runs.status = 'running' THEN dispatcher_runs.started_at ELSE dispatcher_runs.queued_at END ASC NULLS LAST,
              dispatcher_runs.id ASC
     LIMIT 1`,
    [agentThreadId]
  );
  const run = active.rows[0];
  if (!run) return false;

  const queued = await client.query<{
    id: string;
    message_delivery_id: string | null;
  }>(
    `SELECT dispatcher_runs.id, dispatcher_runs.message_delivery_id
     FROM dispatcher_runs
     JOIN agent_threads ON agent_threads.id = dispatcher_runs.agent_thread_id
     WHERE dispatcher_runs.agent_thread_id = $1
       AND dispatcher_runs.scope = 'coordination'
       AND dispatcher_runs.status = 'queued'
       AND dispatcher_runs.id <> $2
     ORDER BY dispatcher_runs.queued_at ASC, dispatcher_runs.id ASC`,
    [agentThreadId, run.id]
  );
  for (const stale of queued.rows) {
    if (stale.message_delivery_id) {
      const source = await client.query<{ body: string }>(
        `SELECT thread_messages.body
         FROM message_deliveries
         JOIN thread_messages ON thread_messages.id = message_deliveries.message_id
         WHERE message_deliveries.id = $1`,
        [stale.message_delivery_id]
      );
      const staleMessage = source.rows[0]?.body;
      if (staleMessage?.trim()) {
        await client.query(
          `INSERT INTO agent_turn_inputs
             (agent_thread_id, dispatcher_run_id, message_delivery_id, assignment_id, message)
           VALUES ($1, $2, $3, (SELECT assignment_id FROM message_deliveries WHERE id = $3), $4)
           ON CONFLICT (message_delivery_id) WHERE message_delivery_id IS NOT NULL DO UPDATE
             SET agent_thread_id = EXCLUDED.agent_thread_id,
                 dispatcher_run_id = EXCLUDED.dispatcher_run_id,
                 assignment_id = COALESCE(EXCLUDED.assignment_id, agent_turn_inputs.assignment_id)
             WHERE agent_turn_inputs.status = 'queued'`,
          [agentThreadId, run.id, stale.message_delivery_id, staleMessage]
        );
      }
    }
    await client.query(
      `UPDATE dispatcher_runs
       SET message_delivery_id = NULL,
           status = 'cancelled',
           finished_at = now(),
           error = 'Superseded by an incremental coordination turn',
           updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [stale.id]
    );
  }

  await client.query(
    `INSERT INTO agent_turn_inputs
       (agent_thread_id, dispatcher_run_id, message_delivery_id, assignment_id, message)
     VALUES ($1, $2, $3, $5, $4)
     ON CONFLICT (message_delivery_id) WHERE message_delivery_id IS NOT NULL DO NOTHING`,
    [agentThreadId, run.id, messageDeliveryId, message, assignmentId ?? null]
  );
  return true;
}

export async function transferTaskAgentThread(
  queryable: Queryable,
  input: {
    threadId: string;
    taskId: string;
    recipientAgentId: string;
    model: string;
    modelOptions: unknown;
    runtimeHome: string;
    preserveCoordination?: boolean;
  }
): Promise<AgentThreadSession | undefined> {
  if (isDbPool(queryable)) {
    return withTransaction(queryable, (client) => transferTaskAgentThread(client, input));
  }
  const result = await queryable.query<AgentThreadSession>(
    `UPDATE agent_threads
     SET coordination_thread_id = $1,
         agent_id = $3,
         model = $4,
         model_options = $5,
         runtime_home = $6,
         provider_thread_id = CASE
           WHEN agent_id = $3 AND runtime_home = $6 THEN provider_thread_id
           ELSE NULL
         END,
         ownership_generation = ownership_generation + CASE
           WHEN agent_id IS DISTINCT FROM $3 OR runtime_home IS DISTINCT FROM $6 THEN 1
           ELSE 0
         END,
         last_activity_at = now(),
         updated_at = now()
     WHERE task_id = $2
     RETURNING id, task_id, project_id, ownership_generation, runtime_home, provider_thread_id, cwd`,
    [
      input.threadId,
      input.taskId,
      input.recipientAgentId,
      input.model,
      JSON.stringify(input.modelOptions),
      input.runtimeHome
    ]
  );
  if (result.rows[0]) {
    await cancelStaleQueuedAgentThreadRuns(
      queryable,
      result.rows[0].id,
      result.rows[0].ownership_generation,
      input.preserveCoordination ?? false
    );
  }
  return result.rows[0];
}

export interface JobEnvelope {
  taskId: string | null;
  taskRef: string | null;
  workScope: string | null;
  workKey: string | null;
  parentTaskId: string | null;
  parentTaskRef: string | null;
  assignmentId: string | null;
  assignmentRef: string | null;
  assignmentKey: string | null;
  assignmentStatus: string | null;
  attempt: number | null;
  limits: OrchestrationPolicy;
  activeAssignments: number;
  activeChildren: number;
  safetyMode: string;
  shutdownState: "running" | "stopped";
  coordinationThreadId: string | null;
  agentThreadId: string | null;
  providerThreadId: string | null;
}

export function coordinationPrompt(thread: any, recipient: any, message: any, history: any[], envelope?: JobEnvelope | null): string {
  const lines = history.map((item) => `- ${item.sender_agent_name ?? "System"} -> ${item.recipient_agent_name ?? "thread"} [${item.message_type}]: ${String(item.body).slice(0, 1200)}`);
  const context = [
    `You are ${recipient.name}: ${recipient.description}`,
    "You have received an Aisevak coordination message. Use the aisevak CLI based on your judgment; inspect resources lazily instead of loading everything.",
    "",
    `Thread: THREAD-${thread.number} — ${thread.title}`,
    `Description: ${thread.description}`,
    `Purpose: ${thread.purpose}`,
    `Thread started by: ${thread.created_by_agent_name ?? "platform"}`,
    `Message from: ${message.sender_agent_name ?? "platform"}`,
    `Message type: ${message.message_type ?? "message"}`,
    `Why you were triggered: ${message.body}`,
    thread.origin_thread_id ? `Origin thread: THREAD-${thread.origin_thread_number ?? thread.origin_thread_id}` : "Origin thread: none",
    `Triggered agent: ${thread.primary_agent_name ?? "none"}`,
    `Result recipient: ${thread.callback_agent_name ?? "none"}`,
    ...formatJobEnvelope(envelope),
    "",
    "Recent thread history:",
    ...(lines.length ? lines : ["- No earlier messages."]),
    ""
  ];
  if (message.message_type === "completion" || message.message_type === "blocked") {
    return [
      ...context,
      `This is a final ${message.message_type} response from the agent you triggered. Treat it as a result notification, not as new work on THREAD-${thread.number}.`,
      `Do not complete or block THREAD-${thread.number}, and do not send an automatic acknowledgement. Continue the work that caused the handoff using the result above.`,
      `If the triggered agent needs to do more work, explicitly send a new message on the same thread with: aisevak threads send THREAD-${thread.number} --body-stdin. That reactivates the thread and delivers the follow-up to the triggered agent.`
    ].join("\n");
  }
  if (envelope?.assignmentId && envelope.assignmentRef) {
    return [
      ...context,
      `Assignment ${envelope.assignmentRef} (${envelope.assignmentKey}) is the unit of work for this delivery.`,
      `Complete it with: aisevak assignments complete ${envelope.assignmentRef} --result-stdin`,
      `If blocked, use: aisevak assignments block ${envelope.assignmentRef} --result-stdin`,
      "Keep the existing assignment, coordination thread, agent thread, and provider session. Do not create recovery, review, retry, or detached coordination threads."
    ].join("\n");
  }
  if (thread.task_id) {
    return [
      ...context,
      "This is a task-scoped coordination message. Work through the existing task and assignments; do not create another coordination thread.",
      "Only the task owner or orchestrator may complete the overall task after all assignments are terminal.",
      "Use aisevak assignments create TASK-n --key ... --to ... --instructions-stdin for specialist work."
    ].join("\n");
  }
  return [
    ...context,
    `Completion instruction: ${thread.completion_instructions}`,
    "Complete the requested work. When finished, send the completed work back to the triggering agent through this thread using the completion instruction. If blocked, run: aisevak threads block THREAD-" + thread.number + " --reason-stdin"
  ].join("\n");
}

export function coordinationIncrementalPrompt(message: { body: string }, envelope?: JobEnvelope | null): string {
  return [...formatJobEnvelope(envelope), message.body].filter(Boolean).join("\n");
}

function formatJobEnvelope(envelope?: JobEnvelope | null): string[] {
  if (!envelope) {
    return [
      `Live job envelope: task=none; work=none; parent=none; assignment=none; coordination-thread=none; agent-thread=none; provider-session=none; safety=${jobSafetyMode()}; shutdown=running`,
      "Limits: active assignments 0/5; active children 0/5; child depth 3; assignment attempts 0/3.",
      "Allowed next commands: use an existing thread; create only an explicitly keyed detached stream when authorized. Do not create recovery, review, retry, or nested coordination threads."
    ];
  }
  const workIdentity = envelope.workScope && envelope.workKey ? `${envelope.workScope}/${envelope.workKey}` : "none";
  const assignment = envelope.assignmentRef
    ? `${envelope.assignmentRef} (${envelope.assignmentKey}) status=${envelope.assignmentStatus} attempt=${envelope.attempt}`
    : "none";
  return [
    `Live job envelope: task=${envelope.taskRef ?? "none"}; work=${workIdentity}; parent=${envelope.parentTaskRef ?? "none"}; assignment=${assignment}; coordination-thread=${envelope.coordinationThreadId ?? "none"}; agent-thread=${envelope.agentThreadId ?? "none"}; provider-session=${envelope.providerThreadId ?? "none"}; safety=${envelope.safetyMode}; shutdown=${envelope.shutdownState}`,
    `Limits: active assignments ${envelope.activeAssignments}/${envelope.limits.maxActiveAssignments}; active children ${envelope.activeChildren}/${envelope.limits.maxActiveChildren}; child depth ${envelope.limits.maxChildDepth}; assignment attempts ${envelope.attempt ?? 0}/${envelope.limits.maxAssignmentAttempts}.`,
    envelope.assignmentId
      ? "Allowed next commands: assignments show/send/complete/block for this assignment. Keep this assignment, coordination thread, and provider session; do not create recovery, review, or retry threads."
      : "Allowed next commands: orchestrators may create keyed root/child tasks and assignments; workers may read/send/complete/block assignments. Use a keyed child task or assignment instead of a new coordination thread."
  ];
}

async function loadJobEnvelope(
  queryable: Queryable,
  taskId: string | null,
  assignmentId: string | null,
  bindings: { coordinationThreadId?: string | null; agentThreadId?: string | null; providerThreadId?: string | null } = {}
): Promise<JobEnvelope | null> {
  if (!taskId) {
    const detached = bindings.coordinationThreadId
      ? await queryable.query<{ work_scope: string | null; work_key: string | null }>(
          "SELECT work_scope, work_key FROM coordination_threads WHERE id = $1",
          [bindings.coordinationThreadId]
        )
      : { rows: [] as Array<{ work_scope: string | null; work_key: string | null }> };
    return {
      taskId: null,
      taskRef: null,
      workScope: detached.rows[0]?.work_scope ?? null,
      workKey: detached.rows[0]?.work_key ?? null,
      parentTaskId: null,
      parentTaskRef: null,
      assignmentId: null,
      assignmentRef: null,
      assignmentKey: null,
      assignmentStatus: null,
      attempt: null,
      limits: orchestrationPolicy(null),
      activeAssignments: 0,
      activeChildren: 0,
      safetyMode: jobSafetyMode(),
      shutdownState: "running",
      coordinationThreadId: bindings.coordinationThreadId ?? null,
      agentThreadId: bindings.agentThreadId ?? null,
      providerThreadId: bindings.providerThreadId ?? null
    };
  }
  const task = await queryable.query<{
    id: string; number: number; status: string; work_scope: string; work_key: string; parent_task_id: string | null;
    parent_task_number: number | null; orchestration_policy: unknown; active_assignments: number; active_children: number;
  }>(
    `SELECT tasks.id, tasks.number, tasks.status, tasks.work_scope, tasks.work_key, tasks.parent_task_id,
            parent.number AS parent_task_number, tasks.orchestration_policy,
            (SELECT count(*)::int FROM task_assignments WHERE task_id = tasks.id AND status IN ('queued', 'running')) AS active_assignments,
            (SELECT count(*)::int FROM tasks child WHERE child.parent_task_id = tasks.id AND child.status NOT IN ('completed', 'blocked', 'cancelled')) AS active_children
     FROM tasks LEFT JOIN tasks parent ON parent.id = tasks.parent_task_id WHERE tasks.id = $1`, [taskId]
  );
  const row = task.rows[0];
  if (!row) return null;
  const assignment = assignmentId
    ? await queryable.query<{ number: number; assignment_key: string; status: string; attempt_count: number }>(
        "SELECT number, assignment_key, status, attempt_count FROM task_assignments WHERE id = $1 AND task_id = $2", [assignmentId, taskId]
      )
    : { rows: [] as Array<{ number: number; assignment_key: string; status: string; attempt_count: number }> };
  const assigned = assignment.rows[0];
  return {
    taskId: row.id,
    taskRef: `TASK-${row.number}`,
    workScope: row.work_scope,
    workKey: row.work_key,
    parentTaskId: row.parent_task_id,
    parentTaskRef: row.parent_task_number ? `TASK-${row.parent_task_number}` : null,
    assignmentId: assigned ? assignmentId : null,
    assignmentRef: assigned ? `ASSIGNMENT-${assigned.number}` : null,
    assignmentKey: assigned?.assignment_key ?? null,
    assignmentStatus: assigned?.status ?? null,
    attempt: assigned?.attempt_count ?? null,
    limits: orchestrationPolicy(row.orchestration_policy),
    activeAssignments: Number(row.active_assignments ?? 0),
    activeChildren: Number(row.active_children ?? 0),
    safetyMode: jobSafetyMode(),
    shutdownState: ["completed", "blocked", "cancelled"].includes(row.status) ? "stopped" : "running",
    coordinationThreadId: bindings.coordinationThreadId ?? null,
    agentThreadId: bindings.agentThreadId ?? null,
    providerThreadId: bindings.providerThreadId ?? null
  };
}

async function resolveAgentSkills(queryable: Queryable, agentId: string, projectId: string | null, taskId: string | null): Promise<CodexSkillSnapshot[]> {
  const result = await queryable.query<{
    id: string; name: string; description: string; instructions: string; files: unknown; source: string;
  }>(
    `SELECT skills.id, skills.name, skills.description, skills.instructions, skills.files, source
     FROM skills JOIN (
       SELECT id AS skill_id, 'default'::text AS source FROM skills WHERE default_for_agents = true
       UNION ALL SELECT skill_id, 'agent' FROM agent_skills WHERE agent_id = $1
       UNION ALL
         SELECT skills.id, 'instruction'
         FROM skills
         JOIN agents ON agents.id = $1
         WHERE position('@skill(' || skills.name || ')' in agents.instructions) > 0
       UNION ALL SELECT skill_id, 'project' FROM project_skills WHERE project_id = $2
       UNION ALL SELECT skill_id, 'task' FROM task_skills WHERE task_id = $3
     ) selected ON selected.skill_id = skills.id WHERE skills.enabled = true ORDER BY skills.name`,
    [agentId, projectId, taskId]
  );
  const byId = new Map<string, CodexSkillSnapshot>();
  for (const row of result.rows) {
    const current = byId.get(row.id);
    if (current) { if (!current.sources.includes(row.source)) current.sources.push(row.source); continue; }
    byId.set(row.id, { id: row.id, name: row.name, description: row.description, instructions: row.instructions,
      files: normalizeFiles(row.files), sources: [row.source] });
  }
  return [...byId.values()];
}
function normalizeFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function finalizeThread(
  pool: DbPool,
  managedRoot: string,
  context: AgentContext,
  threadId: string,
  status: "completed" | "blocked",
  body: string,
  idempotencyKey?: string,
  updateRelatedResource?: (client: PoolClient) => Promise<void>
): Promise<string> {
  return withTransaction(pool, async (client) => {
    const taskLink = await client.query<{ task_id: string | null }>(
      "SELECT task_id FROM coordination_threads WHERE id = $1",
      [threadId]
    );
    if (taskLink.rows[0]?.task_id) {
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskLink.rows[0].task_id]);
      const activeAssignments = await client.query<{ count: string }>(
        "SELECT count(*)::int AS count FROM task_assignments WHERE task_id = $1 AND status IN ('queued', 'running')",
        [taskLink.rows[0].task_id]
      );
      if (["completed", "blocked"].includes(status) && Number(activeAssignments.rows[0]?.count ?? 0) > 0) {
        throw safetyConflict("The coordination task cannot be completed while assignments are active; finish each assignment first");
      }
    }
    const thread = await lockThread(client, threadId);
    const duplicate = await existingIdempotentMessage(client, context.agentId, idempotencyKey);
    if (duplicate) return duplicate.id;
    // A task owner/orchestrator may close the overall task thread. Specialist
    // agents still use assignment complete/block and cannot finalize the job.
    if (thread.task_id && context.kind === "dispatcher") {
      if (thread.status !== "active") {
        throw httpError(409, `THREAD-${thread.number} is already ${thread.status}. Send a new message to reactivate it before requesting more work.`);
      }
    } else {
      assertThreadCanFinalize(thread, context.agentId);
    }
    const recipientId = thread.callback_agent_id && thread.callback_agent_id !== context.agentId
      ? thread.callback_agent_id
      : null;
    const message = await insertMessage(client, { threadId, senderAgentId: context.agentId, recipientAgentId: recipientId,
      body, type: status === "completed" ? "completion" : "blocked", idempotencyKey });
    await client.query("UPDATE coordination_threads SET status = $2, last_activity_at = now(), updated_at = now() WHERE id = $1", [threadId, status]);
    if (thread.task_id) await client.query("UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1", [thread.task_id, status === "completed" ? "completed" : "blocked"]);
    if (updateRelatedResource) await updateRelatedResource(client);
    if (recipientId) await queueDelivery(client, managedRoot, threadId, message.id, recipientId);
    return message.id;
  });
}

export function assertThreadCanFinalize(
  thread: { number?: number; status: string; primary_agent_id: string | null },
  agentId: string
): void {
  const ref = thread.number ? `THREAD-${thread.number}` : "Thread";
  if (thread.status !== "active") {
    throw httpError(409, `${ref} is already ${thread.status}. Send a new message to reactivate it before requesting more work.`);
  }
  if (thread.primary_agent_id !== agentId) {
    throw httpError(403, `Only the agent triggered on ${ref} can complete or block it. Use threads send for follow-up work.`);
  }
}

async function showResource(pool: DbPool, context: AgentContext, ref: string): Promise<any> {
  if (/^THREAD-/i.test(ref)) { requireCapability(context, "threads:read"); return showThread(pool, await resolveResourceId(pool, "coordination_threads", "THREAD", ref)); }
  if (/^TASK-/i.test(ref)) { requireCapability(context, "tasks:read"); return showTask(pool, await resolveResourceId(pool, "tasks", "TASK", ref)); }
  if (/^ASSIGNMENT-/i.test(ref)) { requireCapability(context, "assignments:read"); return showAssignment(pool, await resolveResourceId(pool, "task_assignments", "ASSIGNMENT", ref)); }
  if (/^REPORT-/i.test(ref)) { requireCapability(context, "reports:read"); return showReport(pool, await resolveResourceId(pool, "reports", "REPORT", ref)); }
  if (/^INC-/i.test(ref)) { requireCapability(context, "incidents:read"); return showIncident(pool, await resolveResourceId(pool, "incidents", "INC", ref)); }
  if (/^SCHEDULE-/i.test(ref)) { requireCapability(context, "schedules:read"); return showSchedule(pool, await resolveResourceId(pool, "schedules", "SCHEDULE", ref)); }
  if (/^AGENT-/i.test(ref)) { requireCapability(context, "agents:read"); return getAgent(pool, ref); }
  badRequest("Use a typed resource reference such as TASK-12, THREAD-8, or SCHEDULE-3");
}
async function contentResource(pool: DbPool, context: AgentContext, ref: string): Promise<{ ref: string; title: string; content: string; revision: string }> {
  if (/^THREAD-/i.test(ref)) { requireCapability(context, "threads:read"); const row = await showThread(pool, await resolveResourceId(pool, "coordination_threads", "THREAD", ref), true); return { ref: row.key, title: row.title, content: row.purpose, revision: iso(row.updated_at) }; }
  if (/^TASK-/i.test(ref)) { requireCapability(context, "tasks:read"); const row = await showTask(pool, await resolveResourceId(pool, "tasks", "TASK", ref), true); return { ref: row.key, title: row.title, content: row.body, revision: iso(row.updated_at) }; }
  if (/^ASSIGNMENT-/i.test(ref)) { requireCapability(context, "assignments:read"); const row = await showAssignment(pool, await resolveResourceId(pool, "task_assignments", "ASSIGNMENT", ref), true); return { ref: row.key, title: `${row.task_title}: ${row.assignment_key}`, content: row.instructions, revision: iso(row.updated_at) }; }
  if (/^REPORT-/i.test(ref)) { requireCapability(context, "reports:read"); const row = await showReport(pool, await resolveResourceId(pool, "reports", "REPORT", ref), true); return { ref: row.key, title: row.title, content: row.markdown, revision: String(row.current_revision) }; }
  if (/^INC-/i.test(ref)) { requireCapability(context, "incidents:read"); const row = await showIncident(pool, await resolveResourceId(pool, "incidents", "INC", ref), true); return { ref: row.key, title: row.title, content: row.markdown ?? row.description, revision: iso(row.updated_at) }; }
  if (/^SCHEDULE-/i.test(ref)) { requireCapability(context, "schedules:read"); const row = await showSchedule(pool, await resolveResourceId(pool, "schedules", "SCHEDULE", ref), true); return { ref: row.key, title: row.title, content: row.prompt, revision: iso(row.updated_at) }; }
  badRequest("Content is available for TASK, ASSIGNMENT, THREAD, SCHEDULE, REPORT, and INC references");
}

function threadResource(row: any, includeContent = false) { const { purpose, ...rest } = row; return resourcePreview({ ...rest, ...(includeContent ? { purpose } : {}), key: `THREAD-${row.number}` }); }
function taskResource(row: any, includeContent = false) { const { body, ...rest } = row; return resourcePreview({ ...rest, ...(includeContent ? { body } : {}), key: `TASK-${row.number}` }); }
function assignmentResource(row: any, includeContent = false) {
  const { instructions, result, ...rest } = row;
  return resourcePreview({
    ...rest,
    ...(includeContent ? { instructions, result } : {}),
    resultPreview: previewText(result ?? ""),
    resultTotalBytes: Buffer.byteLength(result ?? ""),
    key: `ASSIGNMENT-${row.number}`
  });
}
function reportResource(row: any, includeContent = false) { const { markdown, ...rest } = row; return resourcePreview({ ...rest, ...(includeContent ? { markdown } : {}), key: `REPORT-${row.number}` }); }
function incidentResource(row: any, includeContent = false) { const { markdown, ...rest } = row; return resourcePreview({ ...rest, ...(includeContent ? { markdown } : {}), key: `INC-${row.number}` }); }
function scheduleResource(row: any, includeContent = false) { const { prompt, ...rest } = row; return resourcePreview({ ...rest, ...(includeContent ? { prompt } : {}), key: `SCHEDULE-${row.number}` }); }
function messageResource(row: any, includeContent = false) { const { body, ...rest } = row; return { ...rest, ...(includeContent ? { body } : {}), key: `MESSAGE-${row.number}`, bodyPreview: previewText(body), bodyTotalBytes: Buffer.byteLength(body ?? ""), bodyTruncated: Buffer.byteLength(body ?? "") > 1000 }; }
function resourcePreview(row: any) {
  const { content_preview, content_total_bytes, ...rest } = row;
  const total = Number(content_total_bytes ?? 0);
  return { ...rest, contentPreview: content_preview ?? "", contentTotalBytes: total, contentTruncated: total > Buffer.byteLength(content_preview ?? "") };
}
function previewText(value: string) { const bytes = Buffer.from(value ?? ""); return bytes.subarray(0, 1000).toString("utf8").replace(/�$/, ""); }
function listResponse(rows: any[], limit: number, cursorColumn: string, map: (row: any) => any) {
  const page = rows.slice(0, limit); const last = page.at(-1); const hasMore = rows.length > limit;
  return { items: page.map((row) => map(row)), nextCursor: hasMore && last ? encodeCursor({ at: iso(last[cursorColumn]), id: String(last.id) }) : null, hasMore };
}
function parseCursor(value?: string) { try { return decodePageCursor(value); } catch { badRequest("Invalid page cursor"); } }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }

function modelOptionsFor(
  model: string,
  value: unknown
): Array<{ id: string; value: string | number | boolean }> {
  const options = Array.isArray(value)
    ? value.flatMap((item): Array<{ id: string; value: string | number | boolean }> => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== "string") return [];
        if (!["string", "number", "boolean"].includes(typeof entry.value)) return [];
        if (typeof entry.value === "string" && !entry.value.trim()) return [];
        return [{ id: entry.id, value: entry.value as string | number | boolean }];
      })
    : [];
  return options.length ? options : defaultCodexModelOptions(model);
}

function unauthorized(message: string): never { throw httpError(401, message); }
function forbidden(message: string): never { throw httpError(403, message); }
function badRequest(message: string): never { throw httpError(400, message); }
function notFound(label: string): never { throw httpError(404, `${label} not found`); }
function httpError(statusCode: number, message: string): Error { return Object.assign(new Error(message), { statusCode }); }

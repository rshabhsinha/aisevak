import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import {
  buildCodexPrompt,
  buildDispatcherPrompt,
  createPool,
  decryptSecret,
  discoverCodexModels,
  encryptSecret,
  hashPassword,
  hashToken,
  installedSkillsRoot,
  managedCodexHome,
  managedGithubRepoPath,
  newSessionToken,
  resolveCodexBinary,
  removeInstalledSkill,
  normalizeCodexSkillSnapshots,
  normalizeCodexModel,
  applyCodexModelDefaults,
  CODEX_HARNESS_MODELS,
  defaultCodexModelOptions,
  runMigrations,
  serializeCodexSkillSnapshots,
  synchronizeInstalledSkills,
  taskBranchName,
  verifyPassword,
  writeInstalledSkill,
  withTransaction,
  type CodexSkillSnapshot,
  type DbPool,
  type UserRole
} from "@aisevak/core";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { z } from "zod";
import { CodexAuthManager, sanitizeCodexAuthError } from "./codexAuth.js";
import {
  cancelStaleQueuedAgentThreadRuns,
  registerCoordinationRoutes,
  requireAgent,
  requireCapability,
  type AgentContext
} from "./coordination.js";
import { agentDeletionBlockReason } from "./agents.js";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const env = {
  appOrigin: process.env.APP_ORIGIN ?? "http://localhost:5173",
  apiHost: process.env.API_HOST ?? "0.0.0.0",
  apiPort: Number(process.env.API_PORT ?? "8787"),
  cookieSecret: process.env.COOKIE_SECRET ?? "dev-cookie-secret-change-me",
  secretKey: process.env.SECRET_KEY ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  managedRoot: resolve(process.env.MANAGED_ROOT ?? "/srv/aisevak"),
  codexBinary: resolveCodexBinary(process.env.CODEX_BINARY),
  codexDefaultModel: normalizeCodexModel(process.env.CODEX_DEFAULT_MODEL),
  githubHost: process.env.GITHUB_HOST ?? "github.com"
};
const skillsRoot = installedSkillsRoot(env.managedRoot);

let codexModelCache:
  | { expiresAt: number; models: typeof CODEX_HARNESS_MODELS; defaultModel: string; source: "live" | "fallback" }
  | undefined;

export async function buildServer(pool: DbPool): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const codexAuth = new CodexAuthManager(pool, env.secretKey);
  await app.register(sensible);
  await app.register(cookie, { secret: env.cookieSecret });
  await app.register(cors, {
    origin: env.appOrigin,
    credentials: true
  });

  app.addHook("preHandler", async (request) => {
    request.user = await getUserFromRequest(pool, request);
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/onboarding/status", async () => {
    const users = await pool.query<{ count: string }>("SELECT count(*) FROM users");
    return { hasAdmin: Number(users.rows[0]?.count ?? 0) > 0 };
  });

  app.get("/api/me", async (request) => ({ user: request.user ?? null }));

  app.get("/api/api-keys", async (request) => {
    const user = requireUser(request);
    const result = await pool.query(
      `SELECT id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at
       FROM api_keys
       WHERE created_by = $1
       ORDER BY created_at DESC`,
      [user.id]
    );
    return { apiKeys: result.rows };
  });

  app.post("/api/api-keys", async (request) => {
    const user = requireUser(request);
    const body = apiKeySchema.parse(request.body);
    const expiresAt = new Date(body.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throwBadRequest("Expiry must be a future date");
    }
    const secret = `avk_${newSessionToken()}`;
    const tokenPrefix = secret.slice(0, 12);
    const result = await pool.query(
      `INSERT INTO api_keys (name, token_hash, token_prefix, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at`,
      [body.name, hashToken(secret), tokenPrefix, user.id, expiresAt]
    );
    return { apiKey: result.rows[0], secret };
  });

  app.delete("/api/api-keys/:id", async (request) => {
    const user = requireUser(request);
    const { id } = idParams.parse(request.params);
    const result = await pool.query(
      `UPDATE api_keys
       SET revoked_at = now(), updated_at = now()
       WHERE id = $1 AND created_by = $2 AND revoked_at IS NULL
       RETURNING id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at`,
      [id, user.id]
    );
    return { apiKey: result.rows[0] ?? null };
  });

  app.get("/api/credentials", async (request) => {
    requireAdmin(request);
    const result = await pool.query(
      `SELECT id, name, description, agent_accessible, last_used_at, created_at, updated_at
       FROM secrets
       WHERE agent_accessible = true
       ORDER BY name ASC`
    );
    return { credentials: result.rows };
  });

  app.post("/api/credentials", async (request) => {
    const user = requireAdmin(request);
    const body = credentialSchema.parse(request.body);
    const existing = await pool.query<{ id: string }>("SELECT id FROM secrets WHERE name = $1 LIMIT 1", [
      body.name
    ]);
    if (existing.rows[0]) {
      throw app.httpErrors.conflict("A credential or internal secret with this name already exists");
    }
    const encrypted = encryptSecret(body.value, env.secretKey);
    const result = await pool.query(
      `INSERT INTO secrets (name, description, encrypted_value, agent_accessible, created_by)
       VALUES ($1, $2, $3, true, $4)
       RETURNING id, name, description, agent_accessible, last_used_at, created_at, updated_at`,
      [body.name, body.description ?? "", encrypted, user.id]
    );
    return { credential: result.rows[0] };
  });

  app.patch("/api/credentials/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = credentialPatchSchema.parse(request.body);
    if (body.name) {
      const existing = await pool.query<{ id: string }>(
        "SELECT id FROM secrets WHERE name = $1 AND id <> $2 LIMIT 1",
        [body.name, id]
      );
      if (existing.rows[0]) {
        throw app.httpErrors.conflict("A credential or internal secret with this name already exists");
      }
    }
    const encrypted = body.value ? encryptSecret(body.value, env.secretKey) : null;
    const result = await pool.query(
      `UPDATE secrets
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           encrypted_value = COALESCE($4, encrypted_value),
           updated_at = now()
       WHERE id = $1 AND agent_accessible = true
       RETURNING id, name, description, agent_accessible, last_used_at, created_at, updated_at`,
      [id, body.name ?? null, body.description ?? null, encrypted]
    );
    return { credential: mustRow(result.rows[0]) };
  });

  app.delete("/api/credentials/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const result = await pool.query(
      `DELETE FROM secrets
       WHERE id = $1 AND agent_accessible = true
       RETURNING id, name, description, agent_accessible, last_used_at, created_at, updated_at`,
      [id]
    );
    return { credential: result.rows[0] ?? null };
  });

  app.get("/api/codex-auth", async (request) => {
    requireAdmin(request);
    return codexAuth.getStatus();
  });

  app.post("/api/codex-auth/login", async (request) => {
    const user = requireAdmin(request);
    try {
      return await codexAuth.startDeviceLogin(user.id);
    } catch (error) {
      throw app.httpErrors.badGateway(sanitizeCodexAuthError(error));
    }
  });

  app.get("/api/codex-auth/login/:id", async (request) => {
    const user = requireAdmin(request);
    const { id } = codexLoginParams.parse(request.params);
    try {
      return await codexAuth.pollDeviceLogin(id, user.id);
    } catch (error) {
      throw app.httpErrors.badRequest(sanitizeCodexAuthError(error));
    }
  });

  app.delete("/api/codex-auth", async (request) => {
    requireAdmin(request);
    return codexAuth.disconnect();
  });

  app.get("/api/codex/models", async (request) => {
    requireUser(request);
    return getCodexModelSnapshot();
  });

  app.get("/api/provider-instances", async (request) => {
    requireUser(request);
    const [instances, catalog] = await Promise.all([
      pool.query<{
        id: string;
        driver: string;
        display_name: string;
        enabled: boolean;
      }>(
        `SELECT id, driver, display_name, enabled
         FROM provider_instances
         WHERE enabled = true
         ORDER BY created_at ASC`
      ),
      getCodexModelSnapshot()
    ]);
    return {
      instances: instances.rows.map((instance) => ({
        ...instance,
        status: "ready",
        capabilities: { sessionModelSwitch: "in-session" },
        models: instance.driver === "codex" ? catalog.models : [],
        defaultModel: instance.driver === "codex" ? catalog.defaultModel : null,
        modelSource: instance.driver === "codex" ? catalog.source : null
      }))
    };
  });

  app.post("/api/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await pool.query<{
      id: string;
      email: string;
      name: string;
      password_hash: string;
      role: UserRole;
    }>("SELECT id, email, name, password_hash, role FROM users WHERE lower(email) = lower($1)", [
      body.email
    ]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(user.password_hash, body.password))) {
      throw app.httpErrors.unauthorized("Invalid email or password");
    }
    await createSession(pool, reply, {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    });
    return { ok: true };
  });

  app.post("/api/logout", async (request, reply) => {
    const token = request.cookies.aisevak_session ?? request.cookies.ctr_session;
    if (token) {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    }
    reply.clearCookie("aisevak_session", { path: "/" });
    reply.clearCookie("ctr_session", { path: "/" });
    return { ok: true };
  });

  app.post("/api/onboarding/admin", async (request, reply) => {
    const body = onboardingSchema.parse(request.body);
    const existing = await pool.query<{ count: string }>("SELECT count(*) FROM users");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      throw app.httpErrors.conflict("This instance has already been onboarded");
    }

    const passwordHash = await hashPassword(body.password);
    const userResult = await pool.query<AuthUser>(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, 'owner')
       RETURNING id, email, name, role`,
      [body.email, body.name, passwordHash]
    );
    const user = mustRow(userResult.rows[0]);

    if (body.openaiApiKey) {
      await upsertSecret(pool, "openai_api_key", body.openaiApiKey);
    }

    await createDefaultAgents(pool, user.id);
    await createSession(pool, reply, user);
    return { user };
  });

  app.post("/api/onboarding/codex/probe", async (request) => {
    requireAdmin(request);
    const body = codexProbeSchema.parse(request.body ?? {});
    const apiKey = body.openaiApiKey || (await readSecret(pool, "openai_api_key"));
    const version = await runCommand(env.codexBinary, ["--version"], undefined, apiKey);
    const help = await runCommand(env.codexBinary, ["app-server", "--help"], undefined, apiKey);
    let liveProbe: CommandResult | null = null;
    if (body.runLiveProbe) {
      await mkdir(env.managedRoot, { recursive: true });
      liveProbe = await runCommand(
        env.codexBinary,
        ["app-server", "generate-json-schema", "--out", `${env.managedRoot}/probe-schema`],
        undefined,
        apiKey
      );
    }
    return {
      version,
      appServerHelpContainsStdio: help.stdout.includes("stdio://"),
      appServerHelpContainsSchema: help.stdout.includes("generate-json-schema"),
      liveProbe
    };
  });

  app.get("/api/projects", async (request) => {
    requireUser(request);
    const result = await pool.query(
      `SELECT projects.*
       FROM projects
       ORDER BY projects.created_at DESC`
    );
    return { projects: result.rows };
  });

  app.post("/api/projects", async (request) => {
    requireAdmin(request);
    const body = projectSchema.parse(request.body);
    const result = await pool.query(
      `INSERT INTO projects (name, source, local_path, workspace_mode, default_branch)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        body.name,
        body.source ?? "local_path",
        body.localPath,
        body.workspaceMode ?? "direct",
        body.defaultBranch ?? null
      ]
    );
    const project = mustRow(result.rows[0] as Record<string, unknown> | undefined);
    return { project };
  });

  app.patch("/api/projects/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = projectPatchSchema.parse(request.body);
    const result = await pool.query(
      `UPDATE projects
       SET name = COALESCE($2, name),
           local_path = COALESCE($3, local_path),
           workspace_mode = COALESCE($4, workspace_mode),
           active = COALESCE($5, active),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, body.name ?? null, body.localPath ?? null, body.workspaceMode ?? null, body.active ?? null]
    );
    const project = mustRow(result.rows[0] as Record<string, unknown> | undefined);
    return { project };
  });

  app.get("/api/skills", async (request) => {
    requireUser(request);
    const scan = await synchronizeInstalledSkills(pool, skillsRoot);
    const result = await pool.query(
      `SELECT id, name, description, instructions, files, enabled, platform_managed,
              default_for_agents, created_by, created_at, updated_at
       FROM skills
       ORDER BY enabled DESC, name ASC`
    );
    return { skills: result.rows, root: skillsRoot, errors: scan.errors };
  });

  app.post("/api/skills", async (request) => {
    const user = requireAdmin(request);
    const body = skillSchema.parse(request.body);
    validateSkillFiles(body.files ?? {});
    await writeInstalledSkill(skillsRoot, {
      name: body.name,
      description: body.description,
      instructions: body.instructions,
      files: body.files ?? {}
    });
    await synchronizeInstalledSkills(pool, skillsRoot);
    const result = await pool.query(
      `UPDATE skills
       SET enabled = $2, created_by = COALESCE(created_by, $3), updated_at = now()
       WHERE name = $1
       RETURNING id, name, description, instructions, files, enabled, platform_managed,
                 default_for_agents, created_by, created_at, updated_at`,
      [body.name, body.enabled ?? true, user.id]
    );
    return { skill: mustRow(result.rows[0]) };
  });

  app.patch("/api/skills/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = skillPatchSchema.parse(request.body);
    const currentResult = await pool.query<{
      name: string;
      description: string;
      instructions: string;
      files: Record<string, string>;
      platform_managed: boolean;
    }>(
      `SELECT name, description, instructions, files, platform_managed
       FROM skills WHERE id = $1`,
      [id]
    );
    const current = mustRow(currentResult.rows[0]);
    if (current.platform_managed && Object.keys(body).some((key) => key !== "enabled")) {
      throwBadRequest("This skill is maintained by Aisevak releases; only availability can be changed");
    }
    if (body.files) validateSkillFiles(body.files);
    const nextName = body.name ?? current.name;
    const contentChanged = ["name", "description", "instructions", "files"].some((key) => key in body);
    if (contentChanged) {
      await writeInstalledSkill(
        skillsRoot,
        {
          name: nextName,
          description: body.description ?? current.description,
          instructions: body.instructions ?? current.instructions,
          files: body.files ?? normalizeSkillFiles(current.files)
        },
        { overwrite: nextName === current.name }
      );
    }
    const result = await pool.query(
      `UPDATE skills
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           instructions = COALESCE($4, instructions),
           files = COALESCE($5, files),
           enabled = COALESCE($6, enabled),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        body.name ?? null,
        body.description ?? null,
        body.instructions ?? null,
        body.files ?? null,
        body.enabled ?? null
      ]
    );
    if (contentChanged && nextName !== current.name) {
      await removeInstalledSkill(skillsRoot, current.name);
    }
    return { skill: mustRow(result.rows[0]) };
  });

  app.get("/api/agents", async (request) => {
    requireUser(request);
    const result = await pool.query(
      `SELECT agents.*
       FROM agents
       ORDER BY agents.created_at DESC`
    );
    return { agents: result.rows };
  });

  app.post("/api/agents", async (request) => {
    const user = requireAdmin(request);
    const body = agentSchema.parse(request.body);
    const model = body.model ?? env.codexDefaultModel;
    const result = await pool.query(
      `INSERT INTO agents (name, description, model, model_options, capabilities, instructions, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [
        body.name,
        body.description ?? "",
        model,
        JSON.stringify(body.modelOptions ?? defaultCodexModelOptions(model)),
        JSON.stringify(body.capabilities ?? []),
        body.instructions
      ]
    );
    const agent = mustRow(result.rows[0]);
    await replaceAgentSkills(pool, agent.id, body.skillIds ?? []);
    await insertAgentVersion(pool, agent, user.id);
    return { agent };
  });

  app.patch("/api/agents/:id", async (request) => {
    const user = requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = agentPatchSchema.parse(request.body);
    const result = await pool.query(
      `UPDATE agents
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           model = COALESCE($4, model),
           model_options = COALESCE($5, model_options),
           capabilities = COALESCE($6, capabilities),
           instructions = COALESCE($7, instructions),
           enabled = COALESCE($8, enabled),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        body.name ?? null,
        body.description ?? null,
        body.model ?? null,
        body.modelOptions ? JSON.stringify(body.modelOptions) : null,
        body.capabilities ? JSON.stringify(body.capabilities) : null,
        body.instructions ?? null,
        body.enabled ?? null
      ]
    );
    const agent = mustRow(result.rows[0]);
    if (body.skillIds) await replaceAgentSkills(pool, agent.id, body.skillIds);
    await insertAgentVersion(pool, agent, user.id);
    return { agent };
  });

  app.delete("/api/agents/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return withTransaction(pool, async (client) => {
      const agentResult = await client.query<{ id: string; kind: string; name: string }>(
        "SELECT id, kind, name FROM agents WHERE id = $1 FOR UPDATE",
        [id]
      );
      const agent = agentResult.rows[0];
      if (!agent) throw app.httpErrors.notFound("Agent not found");

      const usageResult = await client.query<{
        task_count: string;
        thread_count: string;
        schedule_count: string;
        other_enabled_dispatcher_count: string;
      }>(
        `SELECT
           (SELECT count(*) FROM tasks WHERE agent_id = $1) AS task_count,
           (SELECT count(*) FROM agent_threads WHERE agent_id = $1) AS thread_count,
           (SELECT count(*) FROM schedules WHERE agent_id = $1) AS schedule_count,
           (SELECT count(*) FROM agents WHERE kind = 'dispatcher' AND enabled = true AND id <> $1)
             AS other_enabled_dispatcher_count`,
        [id]
      );
      const usage = mustRow(usageResult.rows[0]);
      const blocked = agentDeletionBlockReason(agent, {
        taskCount: Number(usage.task_count),
        threadCount: Number(usage.thread_count),
        scheduleCount: Number(usage.schedule_count),
        otherEnabledDispatcherCount: Number(usage.other_enabled_dispatcher_count)
      });
      if (blocked) throw app.httpErrors.conflict(blocked);

      await client.query("DELETE FROM agents WHERE id = $1", [id]);
      return { deleted: true, agent: { id: agent.id, name: agent.name } };
    });
  });

  app.get("/api/schedules", async (request) => {
    requireUser(request);
    return { schedules: await listSchedules(pool) };
  });

  app.post("/api/schedules", async (request) => {
    const user = requireUser(request);
    const body = scheduleSchema.parse(request.body);
    const nextRunAt = new Date(body.nextRunAt);
    if (nextRunAt.getTime() <= Date.now()) throwBadRequest("First run must be in the future");
    validateScheduleTiming(body.scheduleKind, body.intervalSeconds ?? null);
    await requireEnabledAgent(pool, body.agentId);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO schedules
         (title, prompt, agent_id, schedule_kind, next_run_at, interval_seconds, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        body.title,
        body.prompt,
        body.agentId,
        body.scheduleKind,
        nextRunAt,
        body.scheduleKind === "interval" ? body.intervalSeconds : null,
        user.id
      ]
    );
    return { schedule: await getSchedule(pool, mustRow(result.rows[0]).id) };
  });

  app.patch("/api/schedules/:id", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const body = schedulePatchSchema.parse(request.body);
    await withTransaction(pool, async (client) => {
      const currentResult = await client.query<ScheduleTimingRow>(
        `SELECT id, schedule_kind, next_run_at, interval_seconds, enabled
         FROM schedules WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const current = currentResult.rows[0];
      if (!current) throw app.httpErrors.notFound("Schedule not found");

      const scheduleKind = body.scheduleKind ?? current.schedule_kind;
      const intervalSeconds =
        scheduleKind === "once"
          ? null
          : body.intervalSeconds === null
            ? null
            : body.intervalSeconds ?? current.interval_seconds;
      validateScheduleTiming(scheduleKind, intervalSeconds);
      if (body.agentId) await requireEnabledAgent(client, body.agentId);

      const enabled = body.enabled ?? current.enabled;
      let nextRunAt = body.nextRunAt ? new Date(body.nextRunAt) : new Date(current.next_run_at);
      if (enabled && nextRunAt.getTime() <= Date.now()) {
        if (scheduleKind === "once") {
          throwBadRequest("Choose a future time before enabling this one-time schedule");
        }
        nextRunAt = new Date(Date.now() + Number(intervalSeconds) * 1000);
      }

      await client.query(
        `UPDATE schedules
         SET title = COALESCE($2, title),
             prompt = COALESCE($3, prompt),
             agent_id = COALESCE($4, agent_id),
             schedule_kind = $5,
             next_run_at = $6,
             interval_seconds = $7,
             enabled = $8,
             updated_at = now()
         WHERE id = $1`,
        [
          id,
          body.title ?? null,
          body.prompt ?? null,
          body.agentId ?? null,
          scheduleKind,
          nextRunAt,
          intervalSeconds,
          enabled
        ]
      );
    });
    return { schedule: await getSchedule(pool, id) };
  });

  app.delete("/api/schedules/:id", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const result = await pool.query<{ id: string }>("DELETE FROM schedules WHERE id = $1 RETURNING id", [id]);
    if (!result.rows[0]) throw app.httpErrors.notFound("Schedule not found");
    return { deleted: true };
  });

  app.get("/api/reports", async (request) => {
    requireUser(request);
    const result = await pool.query(
      `SELECT reports.id, reports.number, reports.title, reports.description, reports.status,
              reports.project_id, projects.name AS project_name,
              reports.thread_id, coordination_threads.number AS thread_number,
              author_thread.id AS agent_thread_id,
              reports.author_agent_id, agents.name AS author_agent_name,
              reports.current_revision, report_versions.markdown,
              reports.created_at, reports.updated_at
       FROM reports
       JOIN report_versions
         ON report_versions.report_id = reports.id
        AND report_versions.revision = reports.current_revision
       LEFT JOIN agents ON agents.id = reports.author_agent_id
       LEFT JOIN projects ON projects.id = reports.project_id
       LEFT JOIN coordination_threads ON coordination_threads.id = reports.thread_id
       LEFT JOIN LATERAL (
         SELECT agent_threads.id
         FROM agent_threads
         WHERE agent_threads.coordination_thread_id = reports.thread_id
           AND agent_threads.agent_id = reports.author_agent_id
         ORDER BY agent_threads.last_activity_at DESC, agent_threads.id DESC
         LIMIT 1
       ) author_thread ON true
       ORDER BY reports.updated_at DESC, reports.id DESC
       LIMIT 200`
    );
    return { reports: result.rows };
  });

  app.get("/api/incidents", async (request) => {
    requireUser(request);
    const result = await pool.query(
      `SELECT incidents.id, incidents.number, incidents.title, incidents.description,
              incidents.status, incidents.severity,
              incidents.project_id, projects.name AS project_name,
              incidents.thread_id, coordination_threads.number AS thread_number,
              reporter_thread.id AS agent_thread_id,
              incidents.commander_agent_id, commander.name AS commander_agent_name,
              incidents.created_by_agent_id, creator.name AS created_by_agent_name,
              latest.markdown, latest.created_at AS latest_update_at,
              incidents.resolved_at, incidents.created_at, incidents.updated_at
       FROM incidents
       LEFT JOIN agents commander ON commander.id = incidents.commander_agent_id
       LEFT JOIN agents creator ON creator.id = incidents.created_by_agent_id
       LEFT JOIN projects ON projects.id = incidents.project_id
       LEFT JOIN coordination_threads ON coordination_threads.id = incidents.thread_id
       LEFT JOIN LATERAL (
         SELECT agent_threads.id
         FROM agent_threads
         WHERE agent_threads.coordination_thread_id = incidents.thread_id
           AND agent_threads.agent_id IN (incidents.created_by_agent_id, incidents.commander_agent_id)
         ORDER BY (agent_threads.agent_id = incidents.created_by_agent_id) DESC,
                  agent_threads.last_activity_at DESC, agent_threads.id DESC
         LIMIT 1
       ) reporter_thread ON true
       LEFT JOIN LATERAL (
         SELECT incident_updates.markdown, incident_updates.created_at
         FROM incident_updates
         WHERE incident_updates.incident_id = incidents.id
         ORDER BY incident_updates.created_at DESC, incident_updates.id DESC
         LIMIT 1
       ) latest ON true
       ORDER BY incidents.updated_at DESC, incidents.id DESC
       LIMIT 200`
    );
    return { incidents: result.rows };
  });

  app.get("/api/tasks", async (request) => {
    requireUser(request);
    const result = await pool.query(
      `SELECT tasks.*,
              projects.name AS project_name,
              CASE WHEN agents.kind = 'dispatcher' THEN 'Auto-route' ELSE agents.name END AS agent_name,
              agents.kind AS agent_kind,
              latest.status AS latest_run_status,
              latest.id AS latest_run_id,
              EXISTS (
                SELECT 1 FROM task_runs WHERE task_runs.task_id = tasks.id
                UNION ALL
                SELECT 1 FROM dispatcher_runs WHERE dispatcher_runs.task_id = tasks.id
              ) AS has_runs
       FROM tasks
       LEFT JOIN projects ON projects.id = tasks.project_id
       JOIN agents ON agents.id = tasks.agent_id
       LEFT JOIN LATERAL (
         SELECT id, status
         FROM task_runs
         WHERE task_runs.task_id = tasks.id AND task_runs.run_kind = 'worker'
         ORDER BY created_at DESC
         LIMIT 1
       ) latest ON true
       ORDER BY tasks.created_at DESC`
    );
    return { tasks: result.rows };
  });

  app.post("/api/tasks", async (request) => {
    const user = requireUser(request);
    const body = taskSchema.parse(request.body);
    const agentId = body.agentId ?? (await getDispatcherAgent(pool)).id;
    const task = await withTransaction(pool, async (client) => {
      const description = body.description ?? summarizeTaskDescription(body.title, body.body);
      const result = await client.query(
        `INSERT INTO tasks (title, description, body, project_id, agent_id, created_by, open_pr_on_success)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [body.title, description, body.body ?? "", body.projectId ?? null, agentId, user.id, body.openPrOnSuccess ?? false]
      );
      const created = mustRow(result.rows[0] as Record<string, unknown> | undefined);
      const thread = await client.query<{ id: string }>(
        `INSERT INTO coordination_threads
           (title, description, purpose, project_id, task_id, created_by_user_id, primary_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [body.title, description, body.body ?? "", body.projectId ?? null, created.id, user.id, agentId]
      );
      await client.query("UPDATE tasks SET coordination_thread_id = $2 WHERE id = $1", [created.id, thread.rows[0]!.id]);
      await client.query("INSERT INTO thread_participants (thread_id, agent_id, role) VALUES ($1, $2, 'assignee') ON CONFLICT DO NOTHING", [thread.rows[0]!.id, agentId]);
      return { ...created, coordination_thread_id: thread.rows[0]!.id };
    });
    return { task };
  });

  app.patch("/api/tasks/:id", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const body = taskPatchSchema.parse(request.body);
    const hasProjectId = Object.prototype.hasOwnProperty.call(body, "projectId");
    return withTransaction(pool, async (client) => {
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [id]);
      const result = await client.query(
        `UPDATE tasks
         SET title = COALESCE($2, title),
             body = COALESCE($3, body),
             status = COALESCE($4, status),
             project_id = CASE WHEN $8::boolean THEN $5 ELSE project_id END,
             agent_id = COALESCE($6, agent_id),
             open_pr_on_success = COALESCE($7, open_pr_on_success),
             description = COALESCE($9, description),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          body.title ?? null,
          body.body ?? null,
          body.status ?? null,
          hasProjectId ? body.projectId ?? null : null,
          body.agentId ?? null,
          body.openPrOnSuccess ?? null,
          hasProjectId,
          body.description ?? null
        ]
      );
      const task = mustRow(result.rows[0] as Record<string, unknown> | undefined);
      if (task.coordination_thread_id) {
        await client.query(
          `UPDATE coordination_threads
           SET title = $2, description = $3, purpose = $4, project_id = $5, primary_agent_id = $6,
               status = CASE WHEN $7 = 'completed' THEN 'completed' WHEN $7 = 'blocked' THEN 'blocked' ELSE 'active' END,
               updated_at = now()
           WHERE id = $1`,
          [
            task.coordination_thread_id,
            task.title,
            task.description,
            task.body,
            task.project_id,
            task.agent_id,
            task.status
          ]
        );
      }
      const authoritativeTask = await getTaskJoin(client, id);
      await ensureTaskNavigationThreadInTransaction(client, authoritativeTask);
      return { task };
    });
  });

  app.post("/api/tasks/:id/runs", async (request) => {
    requireUser(request);
    const { id: taskId } = idParams.parse(request.params);
    const task = await getTaskJoin(pool, taskId);
    if (task.agent_kind === "dispatcher") {
      const run = await queueDispatcherRun(pool, { taskId, trigger: "auto_route" });
      return { run, kind: "dispatcher" };
    }
    const run = await queueWorkerRun(pool, taskId, "manual");
    return { run, kind: "worker" };
  });

  app.post("/api/tasks/:id/messages", async (request) => {
    requireUser(request);
    const { id: taskId } = idParams.parse(request.params);
    const body = sessionMessageSchema.parse(request.body);
    const task = await getTaskJoin(pool, taskId);
    if (task.agent_kind === "dispatcher") {
      const run = await queueDispatcherMessage(pool, { taskId, prompt: body.message });
      return { run, kind: "dispatcher" };
    }
    const run = await queueWorkerRun(pool, taskId, "manual", {
      promptOverride: body.message,
      allowQueuedFollowUp: true
    });
    return { run, kind: "worker" };
  });

  app.get("/api/tasks/:id/session", async (request) => {
    requireUser(request);
    const { id: taskId } = idParams.parse(request.params);
    return getTaskSessionTimeline(pool, taskId);
  });

  app.post("/api/tasks/:id/agent-thread", async (request) => {
    requireUser(request);
    const { id: taskId } = idParams.parse(request.params);
    const thread = await ensureTaskNavigationThread(pool, taskId);
    return { thread };
  });

  app.post("/api/runs/:id/cancel", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const result = await pool.query(
      `UPDATE task_runs
       SET status = CASE
             WHEN status = 'queued' THEN 'cancelled'::run_status
             ELSE 'cancel_requested'::run_status
           END,
           updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING *`,
      [id]
    );
    return { run: result.rows[0] ?? null };
  });

  app.get("/api/runs/:id/events", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const [runResult, eventsResult] = await Promise.all([
      pool.query(
        `SELECT task_runs.id,
                'worker' AS kind,
                task_runs.trigger,
                task_runs.status::text,
                task_runs.model,
                task_runs.task_id,
                tasks.number AS task_number,
                tasks.title AS task_title,
                projects.name AS project_name,
                COALESCE(task_sessions.agent_snapshot->>'name', agents.name) AS agent_name,
                task_runs.prompt,
                task_runs.queued_at,
                task_runs.started_at,
                task_runs.finished_at,
                task_runs.error
         FROM task_runs
         JOIN tasks ON tasks.id = task_runs.task_id
         LEFT JOIN projects ON projects.id = tasks.project_id
         JOIN agents ON agents.id = tasks.agent_id
         JOIN task_sessions ON task_sessions.id = task_runs.task_session_id
         WHERE task_runs.id = $1`,
        [id]
      ),
      pool.query("SELECT * FROM run_events WHERE run_id = $1 ORDER BY seq ASC", [id])
    ]);
    return {
      run: runResult.rows[0] ?? null,
      events: withSyntheticUserMessages(runResult.rows, eventsResult.rows)
    };
  });

  app.get("/api/runs/:id/stream", async (request, reply) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    await streamRunEvents(pool, id, reply);
  });

  app.get("/api/agent-threads", async (request) => {
    requireUser(request);
    const query = agentThreadsQuerySchema.parse(request.query);
    return listAgentThreads(pool, query);
  });

  app.post("/api/agent-threads", async (request) => {
    requireUser(request);
    const body = createAgentThreadSchema.parse(request.body);
    return createAgentChatThread(pool, body);
  });

  app.get("/api/agent-threads/:id", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    return getAgentThreadTimeline(pool, id);
  });

  app.patch("/api/agent-threads/:id", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const body = patchAgentThreadSchema.parse(request.body);
    const thread = await updateAgentThread(pool, id, body);
    return { thread };
  });

  app.post("/api/agent-threads/:id/messages", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const body = threadMessageSchema.parse(request.body);
    return queueAgentThreadMessage(pool, id, body);
  });

  app.post("/api/agent-threads/:id/steer", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const body = threadMessageSchema.parse(request.body);
    return queueAgentTurnInput(pool, id, body.message);
  });

  app.post("/api/agent-threads/:id/cancel", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    return cancelAgentThread(pool, id);
  });

  app.post("/api/agent-runs", async (request) => {
    requireUser(request);
    const run = await createDispatcherThread(pool);
    return {
      run: {
        ...run,
        kind: "dispatcher",
        task_number: null,
        task_title: null,
        project_name: null,
        agent_name: "Orchestrator"
      }
    };
  });

  app.get("/api/agent-runs", async (request) => {
    requireUser(request);
    const result = await pool.query(
      `SELECT *
       FROM (
         SELECT task_runs.id,
                'worker' AS kind,
                task_runs.trigger,
                NULL::text AS scope,
                task_runs.status::text,
                task_runs.model,
                task_runs.task_id,
                tasks.number AS task_number,
                tasks.title AS task_title,
                projects.name AS project_name,
                COALESCE(task_sessions.agent_snapshot->>'name', agents.name) AS agent_name,
                task_runs.prompt,
                task_runs.queued_at,
                task_runs.started_at,
                task_runs.finished_at,
                task_runs.error
         FROM task_runs
         JOIN tasks ON tasks.id = task_runs.task_id
         LEFT JOIN projects ON projects.id = tasks.project_id
         JOIN agents ON agents.id = tasks.agent_id
         JOIN task_sessions ON task_sessions.id = task_runs.task_session_id
         WHERE task_runs.run_kind = 'worker'
         UNION ALL
         SELECT dispatcher_runs.id,
                'dispatcher' AS kind,
                dispatcher_runs.trigger,
                dispatcher_runs.scope,
                dispatcher_runs.status::text,
                dispatcher_runs.model,
                dispatcher_runs.task_id,
                tasks.number AS task_number,
                tasks.title AS task_title,
                projects.name AS project_name,
                'Orchestrator' AS agent_name,
                dispatcher_runs.prompt,
                dispatcher_runs.queued_at,
                dispatcher_runs.started_at,
                dispatcher_runs.finished_at,
                dispatcher_runs.error
         FROM dispatcher_runs
         LEFT JOIN tasks ON tasks.id = dispatcher_runs.task_id
         LEFT JOIN projects ON projects.id = tasks.project_id
       ) runs
       ORDER BY queued_at DESC
       LIMIT 200`
    );
    return { runs: result.rows };
  });

  app.get("/api/agent-runs/:kind/:id/events", async (request) => {
    requireUser(request);
    const params = runEventsParams.parse(request.params);
    if (params.kind === "dispatcher") {
      const [runResult, eventsResult] = await Promise.all([
        pool.query(
          `SELECT dispatcher_runs.id,
                  'dispatcher' AS kind,
                  dispatcher_runs.trigger,
                  dispatcher_runs.status::text,
                  dispatcher_runs.model,
                  dispatcher_runs.task_id,
                  tasks.number AS task_number,
                  tasks.title AS task_title,
                  projects.name AS project_name,
                  'Orchestrator' AS agent_name,
                  dispatcher_runs.prompt,
                  dispatcher_runs.queued_at,
                  dispatcher_runs.started_at,
                  dispatcher_runs.finished_at,
                  dispatcher_runs.error
           FROM dispatcher_runs
           LEFT JOIN tasks ON tasks.id = dispatcher_runs.task_id
           LEFT JOIN projects ON projects.id = tasks.project_id
           WHERE dispatcher_runs.id = $1`,
          [params.id]
        ),
        pool.query(
          "SELECT * FROM dispatcher_run_events WHERE dispatcher_run_id = $1 ORDER BY seq ASC",
          [params.id]
        )
      ]);
      return {
        run: mustRow(runResult.rows[0]),
        events: withSyntheticUserMessages(runResult.rows, eventsResult.rows)
      };
    }
    const source = await pool.query<{ task_id: string; agent_thread_id: string | null }>(
      "SELECT task_id, agent_thread_id FROM task_runs WHERE id = $1",
      [params.id]
    );
    const sourceRun = mustRow(source.rows[0]);
    return getTaskSessionTimeline(pool, sourceRun.task_id, sourceRun.agent_thread_id ?? undefined);
  });

  app.post("/api/agent-runs/:kind/:id/messages", async (request) => {
    requireUser(request);
    const params = runEventsParams.parse(request.params);
    const body = sessionMessageSchema.parse(request.body);
    if (params.kind === "dispatcher") {
      const run = await queueDispatcherMessage(pool, { sourceRunId: params.id, prompt: body.message });
      return { run, kind: "dispatcher" };
    }
    const source = await pool.query<{ task_id: string }>("SELECT task_id FROM task_runs WHERE id = $1", [
      params.id
    ]);
    const run = await queueWorkerRun(pool, mustRow(source.rows[0]).task_id, "manual", {
      promptOverride: body.message,
      allowQueuedFollowUp: true
    });
    return { run, kind: "worker" };
  });

  app.get("/api/agent-tools/context", async (request) => {
    await requireLegacyAgentCapabilities(pool, request, "agents:read", "projects:read", "tasks:read");
    return getDispatcherContext(pool);
  });

  app.get("/api/agent-tools/credentials", async (request) => {
    await requireLegacyAgentCapabilities(pool, request, "credentials:read");
    const result = await pool.query(
      `SELECT name, description, last_used_at
       FROM secrets
       WHERE agent_accessible = true
       ORDER BY name ASC`
    );
    return { credentials: result.rows };
  });

  app.get("/api/agent-tools/credentials/:name", async (request) => {
    await requireLegacyAgentCapabilities(pool, request, "credentials:read");
    const params = credentialNameParams.parse(request.params);
    const name = credentialNameSchema.parse(params.name);
    const result = await pool.query<{ id: string; name: string; description: string; encrypted_value: string }>(
      `SELECT id, name, description, encrypted_value
       FROM secrets
       WHERE agent_accessible = true AND name = $1
       LIMIT 1`,
      [name]
    );
    const credential = mustRow(result.rows[0]);
    await pool.query("UPDATE secrets SET last_used_at = now(), updated_at = now() WHERE id = $1", [
      credential.id
    ]);
    return {
      name: credential.name,
      description: credential.description,
      value: decryptSecret(credential.encrypted_value, env.secretKey)
    };
  });

  app.post("/api/agent-tools/credentials", async (request) => {
    await requireLegacyAgentCapabilities(pool, request, "credentials:write");
    const body = credentialSchema.parse(request.body);
    const existing = await pool.query<{ id: string }>("SELECT id FROM secrets WHERE name = $1 LIMIT 1", [
      body.name
    ]);
    if (existing.rows[0]) {
      throw app.httpErrors.conflict("A credential or internal secret with this name already exists");
    }
    const encrypted = encryptSecret(body.value, env.secretKey);
    const result = await pool.query(
      `INSERT INTO secrets (name, description, encrypted_value, agent_accessible)
       VALUES ($1, $2, $3, true)
       RETURNING name, description, last_used_at, created_at`,
      [body.name, body.description ?? "", encrypted]
    );
    return { credential: result.rows[0] };
  });

  app.post("/api/agent-tools/tasks", async (request) => {
    const context = await requireLegacyAgentCapabilities(pool, request, "tasks:create");
    const body = agentToolCreateTaskSchema.parse(request.body);
    const projectId = body.projectId ?? context.taskProjectId ?? null;
    const agentId = body.agentId ?? (await getDispatcherAgent(pool)).id;
    const task = await withTransaction(pool, async (client) => {
      const description = summarizeTaskDescription(body.title, body.body);
      const result = await client.query(
        `INSERT INTO tasks (title, description, body, status, project_id, agent_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [body.title, description, body.body ?? "", body.status ?? "open", projectId, agentId]
      );
      const created = mustRow(result.rows[0] as Record<string, unknown> | undefined);
      const thread = await client.query<{ id: string }>(
        `INSERT INTO coordination_threads (title, description, purpose, project_id, task_id, primary_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [body.title, description, body.body ?? "", projectId, created.id, agentId]
      );
      await client.query("UPDATE tasks SET coordination_thread_id = $2 WHERE id = $1", [created.id, thread.rows[0]!.id]);
      return { ...created, coordination_thread_id: thread.rows[0]!.id };
    });
    return { task };
  });

  app.patch("/api/agent-tools/tasks/:key", async (request) => {
    await requireLegacyAgentCapabilities(pool, request, "tasks:update");
    const { key } = taskKeyParams.parse(request.params);
    const task = await getTaskByKey(pool, key);
    const body = agentToolPatchTaskSchema.parse(request.body);
    const hasProjectId = Object.prototype.hasOwnProperty.call(body, "projectId");
    const updatedTask = await withTransaction(pool, async (client) => {
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [task.id]);
      const result = await client.query(
        `UPDATE tasks
         SET title = COALESCE($2, title),
             body = COALESCE($3, body),
             status = COALESCE($4, status),
             agent_id = COALESCE($5, agent_id),
             project_id = CASE WHEN $6::boolean THEN $7 ELSE project_id END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          task.id,
          body.title ?? null,
          body.body ?? null,
          body.status ?? null,
          body.agentId ?? null,
          hasProjectId,
          hasProjectId ? body.projectId ?? null : null
        ]
      );
      const updated = mustRow(result.rows[0]);
      if (updated.coordination_thread_id) {
        await client.query(
          `UPDATE coordination_threads
           SET title = $2, description = $3, purpose = $4, project_id = $5, primary_agent_id = $6,
               status = CASE WHEN $7 = 'completed' THEN 'completed' WHEN $7 = 'blocked' THEN 'blocked' ELSE 'active' END,
               updated_at = now()
           WHERE id = $1`,
          [
            updated.coordination_thread_id,
            updated.title,
            updated.description,
            updated.body,
            updated.project_id,
            updated.agent_id,
            updated.status
          ]
        );
      }
      const authoritativeTask = await getTaskJoin(client, task.id);
      await ensureTaskNavigationThreadInTransaction(client, authoritativeTask);
      return updated;
    });
    return { task: updatedTask };
  });

  app.post("/api/agent-tools/tasks/:key/comment", async (request) => {
    await requireLegacyAgentCapabilities(pool, request, "tasks:update");
    const { key } = taskKeyParams.parse(request.params);
    const task = await getTaskByKey(pool, key);
    const body = agentToolCommentSchema.parse(request.body);
    const result = await pool.query(
      `INSERT INTO task_comments (task_id, body)
       VALUES ($1, $2)
       RETURNING *`,
      [task.id, body.body]
    );
    return { comment: result.rows[0] };
  });

  app.post("/api/agent-tools/tasks/:key/assign-run", async (request) => {
    await requireLegacyAgentCapabilities(pool, request, "tasks:assign");
    const { key } = taskKeyParams.parse(request.params);
    const task = await getTaskByKey(pool, key);
    const body = agentToolAssignSchema.parse(request.body);
    const agent = await getWorkerAgentByIdentifier(pool, body.agent);
    const hasProjectId = Object.prototype.hasOwnProperty.call(body, "projectId");
    await withTransaction(pool, async (client) => {
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [task.id]);
      const updated = await client.query<{ coordination_thread_id: string | null }>(
        `UPDATE tasks
         SET agent_id = $2,
             project_id = CASE WHEN $3::boolean THEN $4 ELSE project_id END,
             status = 'open',
             updated_at = now()
         WHERE id = $1
         RETURNING coordination_thread_id`,
        [task.id, agent.id, hasProjectId, hasProjectId ? body.projectId ?? null : null]
      );
      const coordinationThreadId = updated.rows[0]?.coordination_thread_id;
      if (coordinationThreadId) {
        await client.query(
          `UPDATE coordination_threads
           SET project_id = (SELECT project_id FROM tasks WHERE id = $1),
               primary_agent_id = (SELECT agent_id FROM tasks WHERE id = $1),
               status = 'active',
               updated_at = now()
           WHERE id = $2`,
          [task.id, coordinationThreadId]
        );
      }
      const authoritativeTask = await getTaskJoin(client, task.id);
      await ensureTaskNavigationThreadInTransaction(client, authoritativeTask);
    });
    const run = body.run ? await queueWorkerRun(pool, task.id, "agent_tool") : null;
    return { taskId: task.id, agent, run };
  });

  app.get("/api/github/status", async (request) => {
    requireAdmin(request);
    const result = await pool.query(
      `SELECT id, name, status, account_login, error, last_synced_at, created_at, updated_at
       FROM github_connections
       WHERE auth_mode = 'pat' AND status <> 'replaced'
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    return { connection: result.rows[0] ?? null, hostname: env.githubHost };
  });

  app.post("/api/github/connect", async (request) => {
    const user = requireAdmin(request);
    const body = githubConnectSchema.parse(request.body);
    const existing = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM github_connections
       WHERE auth_mode = 'pat' AND status <> 'replaced'
       ORDER BY updated_at DESC LIMIT 1`
    );
    if (
      existing.rows[0] &&
      ["pending", "sync_requested", "syncing", "disconnect_requested", "disconnecting"].includes(
        existing.rows[0].status
      )
    ) {
      throw app.httpErrors.conflict("Wait for the current GitHub operation to finish");
    }
    const secretId = await upsertSecret(pool, "github_cli_auth_token", body.token.trim());
    const connection = existing.rows[0]
      ? await pool.query(
          `UPDATE github_connections
           SET name = 'GitHub CLI', status = 'pending', account_login = NULL,
               error = NULL, pat_secret_id = $2, created_by = $3, updated_at = now()
           WHERE id = $1
           RETURNING id, name, status, account_login, error, last_synced_at, created_at, updated_at`,
          [existing.rows[0].id, secretId, user.id]
        )
      : await pool.query(
          `INSERT INTO github_connections (auth_mode, name, status, pat_secret_id, created_by)
           VALUES ('pat', 'GitHub CLI', 'pending', $1, $2)
           RETURNING id, name, status, account_login, error, last_synced_at, created_at, updated_at`,
          [secretId, user.id]
        );
    const row = mustRow(connection.rows[0] as Record<string, unknown> | undefined);
    await pool.query(
      `UPDATE github_connections SET status = 'replaced', updated_at = now()
       WHERE auth_mode = 'pat' AND id <> $1 AND status <> 'replaced'`,
      [row.id]
    );
    return { connection: row, hostname: env.githubHost };
  });

  app.post("/api/github/sync", async (request) => {
    requireAdmin(request);
    const result = await pool.query(
      `UPDATE github_connections
       SET status = 'sync_requested', error = NULL, updated_at = now()
       WHERE id = (
         SELECT id FROM github_connections
         WHERE auth_mode = 'pat' AND status = 'ready'
         ORDER BY updated_at DESC LIMIT 1
       )
       RETURNING id, name, status, account_login, error, last_synced_at, created_at, updated_at`
    );
    if (!result.rows[0]) throw app.httpErrors.conflict("Connect GitHub before refreshing repositories");
    return { connection: result.rows[0] };
  });

  app.delete("/api/github/connection", async (request) => {
    requireAdmin(request);
    const result = await pool.query(
      `UPDATE github_connections
       SET status = 'disconnect_requested', error = NULL, updated_at = now()
       WHERE id = (
         SELECT id FROM github_connections
         WHERE auth_mode = 'pat' AND status IN ('ready', 'failed', 'disconnected')
         ORDER BY updated_at DESC LIMIT 1
       )
       RETURNING id, name, status, account_login, error, last_synced_at, created_at, updated_at`
    );
    return { connection: result.rows[0] ?? null };
  });

  app.get("/api/github/repositories", async (request) => {
    requireAdmin(request);
    const result = await pool.query(
      `SELECT github_repositories.*, github_connections.name AS connection_name,
              latest_import.id AS import_job_id,
              latest_import.status AS import_status,
              latest_import.error AS import_error
       FROM github_repositories
       JOIN github_connections ON github_connections.id = github_repositories.connection_id
       LEFT JOIN LATERAL (
         SELECT id, status, error
         FROM repo_import_jobs
         WHERE repo_import_jobs.github_repository_id = github_repositories.id
         ORDER BY created_at DESC LIMIT 1
       ) latest_import ON true
       WHERE github_connections.auth_mode = 'pat'
         AND github_connections.status <> 'replaced'
       ORDER BY github_repositories.full_name ASC`
    );
    return { repositories: result.rows };
  });

  app.post("/api/github/repositories/:id/import", async (request) => {
    const user = requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const repo = await pool.query(
      `SELECT github_repositories.*
       FROM github_repositories
       JOIN github_connections ON github_connections.id = github_repositories.connection_id
       WHERE github_repositories.id = $1 AND github_connections.status = 'ready'`,
      [id]
    );
    const repoRow = mustRow(repo.rows[0]);
    const active = await pool.query(
      `SELECT * FROM repo_import_jobs
       WHERE github_repository_id = $1 AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    if (active.rows[0]) return { importJob: active.rows[0] };
    const localPath = managedGithubRepoPath(env.managedRoot, repoRow.owner, repoRow.name);
    const result = await pool.query(
      `INSERT INTO repo_import_jobs (github_repository_id, status, local_path, created_by)
       VALUES ($1, 'queued', $2, $3)
       RETURNING *`,
      [id, localPath, user.id]
    );
    return { importJob: result.rows[0] };
  });

  app.post("/api/projects/:id/sync", async (request) => {
    const user = requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const projectResult = await pool.query(
      "SELECT github_repository_id FROM projects WHERE id = $1 AND source = 'github'",
      [id]
    );
    const project = mustRow(projectResult.rows[0]);
    const result = await pool.query(
      `INSERT INTO repo_import_jobs (github_repository_id, status, created_by)
       VALUES ($1, 'queued', $2)
       RETURNING *`,
      [project.github_repository_id, user.id]
    );
    return { importJob: result.rows[0] };
  });

  await registerCoordinationRoutes(app, pool, { managedRoot: env.managedRoot });
  return app;
}

const idParams = z.object({ id: z.string().uuid() });
const codexLoginParams = z.object({ id: z.string().uuid() });
const taskKeyParams = z.object({ key: z.string().min(1) });
const credentialNameParams = z.object({ name: z.string().min(1) });
const runEventsParams = z.object({
  kind: z.enum(["worker", "dispatcher"]),
  id: z.string().uuid()
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const apiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresAt: z.string().datetime()
});
const credentialNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use letters, numbers, dots, underscores, hyphens, or colons");
const credentialSchema = z.object({
  name: credentialNameSchema,
  description: z.string().trim().max(240).optional(),
  value: z.string().min(1)
});
const credentialPatchSchema = credentialSchema.partial();
const optionalOpenAiApiKeySchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional()
);
const onboardingSchema = loginSchema.extend({
  name: z.string().min(1),
  openaiApiKey: optionalOpenAiApiKeySchema
});
const codexProbeSchema = z.object({
  openaiApiKey: optionalOpenAiApiKeySchema,
  runLiveProbe: z.boolean().optional()
});
const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Use lowercase letters, numbers, dots, underscores, or hyphens");
const skillFilesSchema = z.record(z.string()).default({});
const skillSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1),
  instructions: z.string().min(1),
  files: skillFilesSchema.optional(),
  enabled: z.boolean().optional()
});
const skillPatchSchema = skillSchema.partial();
const projectSchema = z.object({
  name: z.string().min(1),
  source: z.enum(["local_path", "github"]).optional(),
  localPath: z.string().min(1),
  workspaceMode: z.enum(["direct", "git_worktree"]).optional(),
  defaultBranch: z.string().optional()
});
const projectPatchSchema = z.object({
  name: z.string().min(1).optional(),
  localPath: z.string().min(1).optional(),
  workspaceMode: z.enum(["direct", "git_worktree"]).optional(),
  active: z.boolean().optional()
});
const modelOptionSelectionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  value: z.union([z.string(), z.number(), z.boolean()])
});
const agentSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().optional(),
  modelOptions: z.array(modelOptionSelectionSchema).max(20).optional(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  skillIds: z.array(z.string().uuid()).max(100).optional(),
  instructions: z.string().min(1)
});
const agentPatchSchema = agentSchema.partial().extend({ enabled: z.boolean().optional() });
const scheduleFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(50_000),
  agentId: z.string().uuid(),
  scheduleKind: z.enum(["once", "interval"]),
  nextRunAt: z.string().datetime(),
  intervalSeconds: z.number().int().min(60).max(31_536_000).nullable().optional()
});
const scheduleSchema = scheduleFieldsSchema;
const schedulePatchSchema = scheduleFieldsSchema.partial().extend({ enabled: z.boolean().optional() });
const taskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  body: z.string().optional(),
  projectId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().optional(),
  openPrOnSuccess: z.boolean().optional()
});
const taskPatchSchema = taskSchema.partial().extend({
  status: z.string().optional()
});
const sessionMessageSchema = z.object({
  message: z.string().trim().min(1)
});
const modelSelectionSchema = z.object({
  providerInstanceId: z.string().trim().min(1).max(120).default("codex-local"),
  model: z.string().trim().min(1).max(160),
  options: z.array(modelOptionSelectionSchema).max(20).default([])
});
const threadMessageSchema = z.object({
  message: z.string().trim().min(1),
  modelSelection: modelSelectionSchema.optional()
});
const createAgentThreadSchema = threadMessageSchema.extend({
  title: z.string().trim().min(1).max(120).optional()
});
const patchAgentThreadSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  modelSelection: modelSelectionSchema.optional()
});
const agentThreadsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().trim().min(1).optional(),
  query: z.string().trim().max(200).optional()
});
const agentToolCreateTaskSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().optional()
});
const agentToolPatchTaskSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().optional()
});
const agentToolCommentSchema = z.object({ body: z.string().min(1) });
const agentToolAssignSchema = z.object({
  agent: z.string().min(1),
  projectId: z.string().uuid().nullable().optional(),
  run: z.boolean().optional()
});
const githubConnectSchema = z.object({ token: z.string().trim().min(10).max(1000) });

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface TaskJoin {
  id: string;
  number: number;
  title: string;
  body: string;
  coordination_thread_id: string | null;
  project_id: string | null;
  agent_id: string;
  agent_kind: "worker" | "dispatcher";
  source: "local_path" | "github" | null;
  local_path: string | null;
  workspace_mode: "direct" | "git_worktree" | null;
  default_branch: string | null;
  agent_name: string;
  agent_description: string;
  agent_model: string;
  agent_model_options: unknown;
  agent_instructions: string;
}

interface TimelineRunRow {
  id: string;
  kind: "worker" | "dispatcher";
  trigger: string;
  status: string;
  model: string;
  task_id?: string | null;
  task_number?: number | null;
  task_title?: string | null;
  project_name?: string | null;
  agent_name: string;
  prompt?: string | null;
  queued_at?: string | Date | null;
  started_at?: string | Date | null;
  finished_at?: string | Date | null;
  created_at?: string | Date | null;
  error?: string | null;
}

interface TimelineEventRow {
  id: string;
  run_id?: string | null;
  dispatcher_run_id?: string | null;
  seq: number;
  event_type: string;
  text?: string | null;
  payload: unknown;
  created_at?: string | Date | null;
}

type ModelSelectionInput = z.infer<typeof modelSelectionSchema>;
type ThreadMessageInput = z.infer<typeof threadMessageSchema>;

interface AgentThreadRow {
  id: string;
  title: string;
  agent_id: string;
  agent_name: string;
  agent_kind: "worker" | "dispatcher";
  display_agent_identity: boolean;
  task_id: string | null;
  task_number: number | null;
  project_id: string | null;
  project_name: string | null;
  workspace_mode: "direct" | "git_worktree" | null;
  workspace_source: "local_path" | "github" | null;
  provider_instance_id: string;
  provider_driver: string;
  provider_name: string;
  model: string;
  model_options: unknown;
  cwd: string;
  branch: string | null;
  runtime_home: string;
  provider_thread_id: string | null;
  ownership_generation: number;
  last_activity_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
  latest_run_id: string | null;
  latest_run_kind: "worker" | "dispatcher" | null;
  latest_status: string | null;
  latest_error: string | null;
}

interface ScheduleTimingRow {
  id: string;
  schedule_kind: "once" | "interval";
  next_run_at: string | Date;
  interval_seconds: number | null;
  enabled: boolean;
}

interface ScheduleRow extends ScheduleTimingRow {
  title: string;
  prompt: string;
  agent_id: string;
  agent_name: string;
  agent_kind: "worker" | "dispatcher";
  last_run_at: string | Date | null;
  last_agent_thread_id: string | null;
  last_thread_title: string | null;
  last_run_status: string | null;
  run_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

const scheduleSelectSql = `
  SELECT schedules.*,
         agents.name AS agent_name,
         agents.kind AS agent_kind,
         agent_threads.title AS last_thread_title,
         latest.status AS last_run_status,
         (SELECT count(*)::int FROM schedule_runs WHERE schedule_runs.schedule_id = schedules.id) AS run_count
  FROM schedules
  JOIN agents ON agents.id = schedules.agent_id
  LEFT JOIN agent_threads ON agent_threads.id = schedules.last_agent_thread_id
  LEFT JOIN LATERAL (
    SELECT dispatcher_runs.status
    FROM schedule_runs
    JOIN dispatcher_runs ON dispatcher_runs.id = schedule_runs.dispatcher_run_id
    WHERE schedule_runs.schedule_id = schedules.id
    ORDER BY schedule_runs.scheduled_for DESC
    LIMIT 1
  ) latest ON true`;

function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) {
    const error = new Error("Unauthorized") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
  return request.user;
}

function requireAdmin(request: FastifyRequest): AuthUser {
  const user = requireUser(request);
  if (user.role !== "owner" && user.role !== "admin") {
    const error = new Error("Admin permissions required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  return user;
}

type ApiQueryable = Pick<DbPool, "query">;

async function listSchedules(pool: ApiQueryable): Promise<ScheduleRow[]> {
  const result = await pool.query<ScheduleRow>(
    `${scheduleSelectSql}
     ORDER BY schedules.enabled DESC, schedules.next_run_at ASC, schedules.created_at DESC`
  );
  return result.rows;
}

async function getSchedule(pool: ApiQueryable, id: string): Promise<ScheduleRow> {
  const result = await pool.query<ScheduleRow>(`${scheduleSelectSql} WHERE schedules.id = $1`, [id]);
  return mustRow(result.rows[0]);
}

async function requireEnabledAgent(pool: ApiQueryable, id: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM agents WHERE id = $1 AND enabled = true",
    [id]
  );
  if (!result.rows[0]) throwBadRequest("Select an enabled agent");
}

function validateScheduleTiming(
  scheduleKind: "once" | "interval",
  intervalSeconds: number | null
): void {
  if (scheduleKind === "once" && intervalSeconds !== null) {
    throwBadRequest("A one-time schedule cannot have an interval");
  }
  if (scheduleKind === "interval" && (!intervalSeconds || intervalSeconds < 60)) {
    throwBadRequest("A repeating schedule needs an interval of at least one minute");
  }
}

async function getUserFromRequest(pool: DbPool, request: FastifyRequest): Promise<AuthUser | undefined> {
  const bearerToken = bearerTokenFromRequest(request);
  if (bearerToken) {
    const apiKeyUser = await getUserFromApiKey(pool, bearerToken);
    if (apiKeyUser) return apiKeyUser;
  }

  const token = request.cookies.aisevak_session ?? request.cookies.ctr_session;
  if (!token) return undefined;
  const result = await pool.query<AuthUser>(
    `SELECT users.id, users.email, users.name, users.role
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > now()`,
    [hashToken(token)]
  );
  return result.rows[0];
}

function bearerTokenFromRequest(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token || undefined;
}

async function getUserFromApiKey(pool: DbPool, token: string): Promise<AuthUser | undefined> {
  const result = await pool.query<AuthUser & { api_key_id: string }>(
    `SELECT users.id, users.email, users.name, users.role, api_keys.id AS api_key_id
     FROM api_keys
     JOIN users ON users.id = api_keys.created_by
     WHERE api_keys.token_hash = $1
       AND api_keys.revoked_at IS NULL
       AND api_keys.expires_at > now()
     LIMIT 1`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  await pool.query("UPDATE api_keys SET last_used_at = now(), updated_at = now() WHERE id = $1", [
    row.api_key_id
  ]);
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

async function createSession(pool: DbPool, reply: FastifyReply, user: AuthUser): Promise<void> {
  const token = newSessionToken();
  await pool.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')",
    [user.id, hashToken(token)]
  );
  reply.setCookie("aisevak_session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30
  });
}

async function createDefaultAgents(pool: DbPool, userId: string): Promise<void> {
  const defaults = [
    {
      kind: "dispatcher",
      name: "Orchestrator",
      description: "Routes unassigned work and coordinates specialized agents across durable threads.",
      instructions:
        "You are the Aisevak Orchestrator. Use the aisevak CLI to inspect work, route tasks, coordinate agents through durable threads, and request precise follow-up when work is ambiguous or blocked."
    },
    {
      kind: "worker",
      name: "Builder",
      description: "Implements tasks end to end, runs checks, and leaves a concise summary.",
      instructions:
        "You are a senior product engineer. Make the requested change, keep edits scoped, run relevant verification, and summarize the result."
    },
    {
      kind: "worker",
      name: "Reviewer",
      description: "Reviews code for regressions, missing tests, and risky behavior.",
      instructions:
        "You are a strict code reviewer. Prioritize correctness, security, regressions, and missing tests. Do not make changes unless the task explicitly asks."
    }
  ];

  for (const agent of defaults) {
    const existingResult = await pool.query<Record<string, unknown>>(
      `SELECT * FROM agents
       WHERE kind = $1 AND lower(name) = lower($2)
       ORDER BY created_at ASC
       LIMIT 1`,
      [agent.kind, agent.name]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      const version = await pool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM agent_versions WHERE agent_id = $1) AS exists",
        [existing.id]
      );
      if (!version.rows[0]?.exists) await insertAgentVersion(pool, existing, userId);
      continue;
    }
    const result = await pool.query(
      `INSERT INTO agents (kind, name, description, model, model_options, instructions, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [
        agent.kind,
        agent.name,
        agent.description,
        env.codexDefaultModel,
        JSON.stringify(defaultCodexModelOptions(env.codexDefaultModel)),
        agent.instructions
      ]
    );
    await insertAgentVersion(pool, mustRow(result.rows[0]), userId);
  }
}

async function insertAgentVersion(pool: DbPool, agent: Record<string, unknown>, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO agent_versions (agent_id, name, description, model, model_options, instructions, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      agent.id,
      agent.name,
      agent.description,
      agent.model,
      JSON.stringify(normalizeModelOptions(agent.model_options)),
      agent.instructions,
      userId
    ]
  );
}

async function replaceAgentSkills(pool: DbPool, agentId: string, skillIds: string[]): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("DELETE FROM agent_skills WHERE agent_id = $1", [agentId]);
    for (const skillId of skillIds) {
      await client.query(
        "INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2)",
        [agentId, skillId]
      );
    }
  });
}

function summarizeTaskDescription(title: string, body: string | undefined): string {
  const firstParagraph = body?.trim().split(/\n\s*\n/, 1)[0]?.replace(/\s+/g, " ").trim();
  return (firstParagraph || title).slice(0, 280);
}

async function getTaskJoin(pool: Pick<DbPool, "query">, taskId: string): Promise<TaskJoin> {
  const taskResult = await pool.query<TaskJoin>(
    `SELECT tasks.*, projects.local_path, projects.workspace_mode, projects.source, projects.default_branch,
            agents.kind AS agent_kind,
            agents.name AS agent_name, agents.description AS agent_description,
            agents.model AS agent_model, agents.model_options AS agent_model_options,
            agents.instructions AS agent_instructions
     FROM tasks
     LEFT JOIN projects ON projects.id = tasks.project_id
     JOIN agents ON agents.id = tasks.agent_id
     WHERE tasks.id = $1`,
    [taskId]
  );
  return mustRow(taskResult.rows[0]);
}

async function getCodexModelSnapshot(): Promise<{
  defaultModel: string;
  models: typeof CODEX_HARNESS_MODELS;
  source: "live" | "fallback";
}> {
  if (codexModelCache && codexModelCache.expiresAt > Date.now()) return codexModelCache;
  try {
    const liveModels = await discoverCodexModels({ codexBinary: env.codexBinary });
    if (liveModels.length > 0) {
      const configured = applyCodexModelDefaults(liveModels, env.codexDefaultModel);
      codexModelCache = {
        defaultModel: configured.defaultModel,
        models: configured.models,
        source: "live",
        expiresAt: Date.now() + 5 * 60_000
      };
      return codexModelCache;
    }
  } catch (error) {
    console.warn("Codex model discovery failed; using fallback catalog", error);
  }
  const configured = applyCodexModelDefaults(CODEX_HARNESS_MODELS, env.codexDefaultModel);
  codexModelCache = {
    defaultModel: configured.defaultModel,
    models: configured.models,
    source: "fallback",
    expiresAt: Date.now() + 30_000
  };
  return codexModelCache;
}

async function listAgentThreads(
  pool: DbPool,
  input: z.infer<typeof agentThreadsQuerySchema>
): Promise<{ threads: AgentThreadRow[]; nextCursor: string | null }> {
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (input.cursor) {
    const cursor = decodeThreadCursor(input.cursor);
    values.push(cursor.lastActivityAt, cursor.id);
    conditions.push(`(agent_threads.last_activity_at, agent_threads.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  if (input.query) {
    values.push(`%${input.query}%`);
    conditions.push(`(
      agent_threads.title ILIKE $${values.length}
      OR agents.name ILIKE $${values.length}
      OR COALESCE(projects.name, '') ILIKE $${values.length}
      OR agent_threads.model ILIKE $${values.length}
    )`);
  }
  values.push(input.limit + 1);
  const result = await pool.query<AgentThreadRow>(
    `${agentThreadSelectSql}
     ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY agent_threads.last_activity_at DESC, agent_threads.id DESC
     LIMIT $${values.length}`,
    values
  );
  const hasMore = result.rows.length > input.limit;
  const threads = result.rows.slice(0, input.limit);
  const last = threads.at(-1);
  return {
    threads,
    nextCursor: hasMore && last ? encodeThreadCursor(last.last_activity_at, last.id) : null
  };
}

async function getAgentThread(pool: Pick<DbPool, "query">, id: string): Promise<AgentThreadRow> {
  const result = await pool.query<AgentThreadRow>(`${agentThreadSelectSql} WHERE agent_threads.id = $1`, [id]);
  return mustRow(result.rows[0]);
}

async function getAgentThreadTimeline(pool: DbPool, id: string): Promise<{
  thread: AgentThreadRow;
  run: TimelineRunRow | null;
  events: TimelineEventRow[];
}> {
  const thread = await getAgentThread(pool, id);
  const timeline = await getTaskSessionTimeline(pool, thread.task_id, id, false);
  return { thread, ...timeline };
}

async function createAgentChatThread(
  pool: DbPool,
  input: z.infer<typeof createAgentThreadSchema>
): Promise<{ thread: AgentThreadRow; turn: Record<string, unknown> }> {
  const dispatcher = await getDispatcherAgent(pool);
  const selection = await resolveModelSelection(pool, input.modelSelection, dispatcher.model, {
    provider_instance_id: "codex-local",
    model_options: dispatcher.model_options
  });
  const runtimeHome = managedCodexHome(env.managedRoot, `dispatcher-${randomUUID()}`);
  const skillsSnapshot = await resolveAgentSkills(pool, dispatcher.id);
  const title = input.title ?? threadTitleFromMessage(input.message);

  const created = await withTransaction(pool, async (client) => {
    const threadResult = await client.query<{ id: string; ownership_generation: number }>(
      `INSERT INTO agent_threads
         (title, agent_id, provider_instance_id, model, model_options, cwd, runtime_home)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, ownership_generation`,
      [
        title,
        dispatcher.id,
        selection.providerInstanceId,
        selection.model,
        JSON.stringify(selection.options),
        env.managedRoot,
        runtimeHome
      ]
    );
    const thread = mustRow(threadResult.rows[0]);
    const runResult = await client.query(
      `INSERT INTO dispatcher_runs
         (agent_thread_id, agent_thread_generation, workspace_key, workspace_mode, workspace_source, trigger, scope, status, cwd, codex_home, model, model_options, prompt, skills_snapshot)
       VALUES ($1, $2, '', 'projectless', 'projectless', 'manual', 'thread', 'queued', $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        thread.id,
        thread.ownership_generation,
        env.managedRoot,
        runtimeHome,
        selection.model,
        JSON.stringify(selection.options),
        input.message,
        serializeCodexSkillSnapshots(skillsSnapshot)
      ]
    );
    const turn = mustRow(runResult.rows[0]);
    await client.query(
      `INSERT INTO dispatcher_run_events (dispatcher_run_id, seq, event_type, text, payload)
       VALUES ($1, -1, 'thread.message-sent', $2, $3)`,
      [turn.id, input.message, { type: "thread.message-sent", role: "user", text: input.message }]
    );
    return { threadId: thread.id, turn };
  });
  return { thread: await getAgentThread(pool, created.threadId), turn: created.turn };
}

async function queueAgentThreadMessage(
  pool: DbPool,
  threadId: string,
  input: ThreadMessageInput
): Promise<{ thread: AgentThreadRow; turn: Record<string, unknown> }> {
  for (;;) {
    const thread = await getAgentThread(pool, threadId);
    if (thread.task_id) {
      return queueTaskBoundAgentThreadMessage(pool, thread, input);
    }
    const projectless = await queueProjectlessAgentThreadMessage(pool, threadId, input);
    if (projectless) {
      return { thread: await getAgentThread(pool, threadId), turn: projectless.turn };
    }
  }
}

async function queueTaskBoundAgentThreadMessage(
  pool: DbPool,
  thread: AgentThreadRow,
  input: ThreadMessageInput
): Promise<{ thread: AgentThreadRow; turn: Record<string, unknown> }> {
  const taskId = thread.task_id;
  if (!taskId) throw new Error("The agent thread is no longer task-bound");
  const selection = await resolveModelSelection(pool, input.modelSelection, thread.model, thread);
  const task = await getTaskJoin(pool, taskId);
  const turn = task.agent_kind === "dispatcher"
    ? await queueDispatcherMessage(pool, {
        taskId,
        prompt: input.message,
        modelSelection: selection,
        agentThreadId: thread.id
      })
    : await queueWorkerRun(pool, taskId, "manual", {
        promptOverride: input.message,
        allowQueuedFollowUp: true,
        modelSelection: selection,
        agentThreadId: thread.id
      });
  return { thread: await getAgentThread(pool, thread.id), turn };
}

async function queueProjectlessAgentThreadMessage(
  pool: DbPool,
  threadId: string,
  input: ThreadMessageInput
): Promise<{ turn: Record<string, unknown> } | null> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM agent_threads WHERE id = $1 FOR UPDATE", [threadId]);
    const thread = await getAgentThread(client, threadId);
    if (thread.task_id) return null;
    const selection = await resolveModelSelection(client, input.modelSelection, thread.model, thread);
    await client.query(
      `UPDATE agent_threads
       SET model = $2,
           model_options = $3,
           title = CASE WHEN title = 'New thread' THEN $4 ELSE title END,
           last_activity_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [threadId, selection.model, JSON.stringify(selection.options), threadTitleFromMessage(input.message)]
    );
    const incremental = await appendIncrementalAgentTurnInput(client, threadId, input.message, {
      scope: "thread"
    });
    if (incremental) return { turn: incremental.run };

    const skillsSnapshot = await resolveAgentSkills(client, thread.agent_id);
    const result = await client.query(
      `INSERT INTO dispatcher_runs
         (agent_thread_id, agent_thread_generation, workspace_key, workspace_mode, workspace_source, trigger, scope, status, cwd, codex_home, codex_thread_id,
          model, model_options, prompt, skills_snapshot)
       VALUES ($1, $2, $3, 'projectless', 'projectless', 'manual', 'thread', 'queued', $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        threadId,
        thread.ownership_generation,
        thread.project_id ?? "",
        thread.cwd,
        thread.runtime_home,
        thread.provider_thread_id,
        selection.model,
        JSON.stringify(selection.options),
        input.message,
        serializeCodexSkillSnapshots(skillsSnapshot)
      ]
    );
    const turn = mustRow(result.rows[0]);
    await insertDispatcherUserMessage(client, String(turn.id), input.message);
    return { turn };
  });
}

async function updateAgentThread(
  pool: DbPool,
  id: string,
  input: z.infer<typeof patchAgentThreadSchema>
): Promise<AgentThreadRow> {
  const thread = await getAgentThread(pool, id);
  const selection = input.modelSelection
    ? await resolveModelSelection(pool, input.modelSelection, thread.model, thread)
    : null;
  await pool.query(
    `UPDATE agent_threads
     SET title = COALESCE($2, title),
         provider_instance_id = COALESCE($3, provider_instance_id),
         model = COALESCE($4, model),
         model_options = COALESCE($5, model_options),
         updated_at = now()
     WHERE id = $1`,
    [
      id,
      input.title ?? null,
      selection?.providerInstanceId ?? null,
      selection?.model ?? null,
      selection ? JSON.stringify(selection.options) : null
    ]
  );
  return getAgentThread(pool, id);
}

export async function cancelAgentThread(
  pool: DbPool,
  id: string
): Promise<{ turn: { id: string; kind: "worker" | "dispatcher"; status: string } | null }> {
  await getAgentThread(pool, id);
  const result = await pool.query<{ id: string; kind: "worker" | "dispatcher"; status: string }>(
    `WITH latest AS (
       SELECT id, kind
       FROM (
       SELECT id, 'worker'::text AS kind, status, queued_at, started_at, created_at FROM task_runs
         WHERE agent_thread_id = $1 AND status IN ('queued', 'running', 'cancel_requested')
         UNION ALL
         SELECT id, 'dispatcher'::text AS kind, status, queued_at, started_at, created_at FROM dispatcher_runs
         WHERE agent_thread_id = $1 AND status IN ('queued', 'running', 'cancel_requested')
       ) turns
       ORDER BY CASE
                  WHEN status IN ('running', 'cancel_requested') THEN 0
                  WHEN status = 'queued' THEN 1
                  ELSE 2
                END,
                CASE
                  WHEN status IN ('running', 'cancel_requested') THEN started_at
                  ELSE queued_at
                END DESC NULLS LAST,
                created_at DESC,
                id DESC
       LIMIT 1
     ), updated_worker AS (
       UPDATE task_runs
       SET status = CASE
             WHEN status = 'queued' THEN 'cancelled'::run_status
             ELSE 'cancel_requested'::run_status
           END,
           updated_at = now()
       WHERE id = (SELECT id FROM latest WHERE kind = 'worker')
       RETURNING id, 'worker'::text AS kind, status::text
     ), updated_dispatcher AS (
       UPDATE dispatcher_runs
       SET status = CASE
             WHEN status = 'queued' THEN 'cancelled'::run_status
             ELSE 'cancel_requested'::run_status
           END,
           updated_at = now()
       WHERE id = (SELECT id FROM latest WHERE kind = 'dispatcher')
       RETURNING id, 'dispatcher'::text AS kind, status::text
     )
     SELECT * FROM updated_worker
     UNION ALL
     SELECT * FROM updated_dispatcher`,
    [id]
  );
  return { turn: result.rows[0] ?? null };
}

export async function queueAgentTurnInput(
  pool: DbPool,
  threadId: string,
  message: string
): Promise<{ input: Record<string, unknown> }> {
  await getAgentThread(pool, threadId);
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM agent_threads WHERE id = $1 FOR UPDATE", [threadId]);
    const active = await client.query<{ id: string; kind: "worker" | "dispatcher" }>(
      `SELECT id, kind
       FROM (
         SELECT task_runs.id, 'worker'::text AS kind, task_runs.started_at
         FROM task_runs
         JOIN agent_threads ON agent_threads.id = task_runs.agent_thread_id
         WHERE task_runs.agent_thread_id = $1
           AND task_runs.agent_thread_generation = agent_threads.ownership_generation
           AND task_runs.status = 'running'
         UNION ALL
         SELECT dispatcher_runs.id, 'dispatcher'::text AS kind, dispatcher_runs.started_at
         FROM dispatcher_runs
         JOIN agent_threads ON agent_threads.id = dispatcher_runs.agent_thread_id
         WHERE dispatcher_runs.agent_thread_id = $1
           AND dispatcher_runs.agent_thread_generation = agent_threads.ownership_generation
           AND dispatcher_runs.status = 'running'
       ) active_turns
       ORDER BY started_at DESC NULLS LAST
       LIMIT 1`,
      [threadId]
    );
    const turn = active.rows[0];
    if (!turn) throwBadRequest("This thread does not have an active turn to steer");
    const result = await client.query(
      `INSERT INTO agent_turn_inputs
         (agent_thread_id, task_run_id, dispatcher_run_id, message)
       SELECT $1, $2, $3, $4
       WHERE EXISTS (
         SELECT 1
         FROM task_runs
         JOIN agent_threads ON agent_threads.id = task_runs.agent_thread_id
         WHERE task_runs.id = $2
           AND task_runs.status = 'running'
           AND task_runs.agent_thread_generation = agent_threads.ownership_generation
         UNION ALL
         SELECT 1
         FROM dispatcher_runs
         JOIN agent_threads ON agent_threads.id = dispatcher_runs.agent_thread_id
         WHERE dispatcher_runs.id = $3
           AND dispatcher_runs.status = 'running'
           AND dispatcher_runs.agent_thread_generation = agent_threads.ownership_generation
       )
       RETURNING *`,
      [threadId, turn.kind === "worker" ? turn.id : null, turn.kind === "dispatcher" ? turn.id : null, message]
    );
    const input = result.rows[0];
    if (!input) throwBadRequest("This thread does not have an active turn to steer");
    return { input };
  });
}

type AgentTurnKind = "worker" | "dispatcher";

interface ThreadTurnCandidate {
  id: string;
  kind: AgentTurnKind;
  status: "queued" | "running";
  prompt: string;
  message_delivery_id: string | null;
  scope: string | null;
}

interface IncrementalTurnOptions {
  kind?: AgentTurnKind;
  scope?: string;
  messageDeliveryId?: string;
}

export async function queueIncrementalAgentTurnInput(
  pool: DbPool,
  threadId: string,
  message: string,
  options: IncrementalTurnOptions = {}
): Promise<{ input: Record<string, unknown>; run: Record<string, unknown> } | null> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM agent_threads WHERE id = $1 FOR UPDATE", [threadId]);
    return appendIncrementalAgentTurnInput(client, threadId, message, options);
  });
}

async function appendIncrementalAgentTurnInput(
  client: PoolClient,
  threadId: string,
  message: string,
  options: IncrementalTurnOptions = {}
): Promise<{ input: Record<string, unknown>; run: Record<string, unknown> } | null> {
  const turn = await selectThreadTurn(client, threadId, options);
  if (!turn) return null;

  const queued = await client.query<ThreadTurnCandidate>(
    `SELECT id, kind, status, prompt, message_delivery_id, scope
     FROM (
       SELECT task_runs.id,
              'worker'::text AS kind,
              task_runs.status::text AS status,
              task_runs.prompt,
              NULL::uuid AS message_delivery_id,
              NULL::text AS scope,
              task_runs.queued_at
       FROM task_runs
       JOIN agent_threads ON agent_threads.id = task_runs.agent_thread_id
       WHERE task_runs.agent_thread_id = $1
         AND task_runs.agent_thread_generation = agent_threads.ownership_generation
         AND task_runs.status = 'queued'
       UNION ALL
       SELECT dispatcher_runs.id,
              'dispatcher'::text AS kind,
              dispatcher_runs.status::text AS status,
              dispatcher_runs.prompt,
              dispatcher_runs.message_delivery_id,
              dispatcher_runs.scope,
              dispatcher_runs.queued_at
       FROM dispatcher_runs
       JOIN agent_threads ON agent_threads.id = dispatcher_runs.agent_thread_id
       WHERE dispatcher_runs.agent_thread_id = $1
         AND dispatcher_runs.agent_thread_generation = agent_threads.ownership_generation
         AND dispatcher_runs.status = 'queued'
     ) turns
     WHERE id <> $2
       AND ($3::text IS NULL OR kind = $3)
       AND ($4::text IS NULL OR scope = $4)
     ORDER BY queued_at ASC, id ASC`,
    [threadId, turn.id, options.kind ?? null, options.scope ?? null]
  );

  for (const stale of queued.rows) {
    let inputMessage = stale.prompt;
    if (stale.message_delivery_id) {
      const sourceMessage = await client.query<{ body: string }>(
        `SELECT thread_messages.body
         FROM message_deliveries
         JOIN thread_messages ON thread_messages.id = message_deliveries.message_id
         WHERE message_deliveries.id = $1`,
        [stale.message_delivery_id]
      );
      inputMessage = sourceMessage.rows[0]?.body ?? inputMessage;
    }
    if (inputMessage.trim()) {
      await client.query(
        `INSERT INTO agent_turn_inputs
           (agent_thread_id, task_run_id, dispatcher_run_id, message_delivery_id, message)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_delivery_id) WHERE message_delivery_id IS NOT NULL DO UPDATE
           SET agent_thread_id = EXCLUDED.agent_thread_id,
               task_run_id = EXCLUDED.task_run_id,
               dispatcher_run_id = EXCLUDED.dispatcher_run_id
           WHERE agent_turn_inputs.status = 'queued'`,
        [
          threadId,
          turn.kind === "worker" ? turn.id : null,
          turn.kind === "dispatcher" ? turn.id : null,
          stale.message_delivery_id,
          inputMessage
        ]
      );
    }
    if (stale.kind === "dispatcher" && stale.message_delivery_id) {
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
    } else {
      await client.query(
        `UPDATE ${stale.kind === "worker" ? "task_runs" : "dispatcher_runs"}
         SET status = 'cancelled',
             finished_at = now(),
             error = 'Superseded by an incremental turn',
             updated_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [stale.id]
      );
    }
  }

  const input = await client.query<Record<string, unknown>>(
    `INSERT INTO agent_turn_inputs
       (agent_thread_id, task_run_id, dispatcher_run_id, message_delivery_id, message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_delivery_id) WHERE message_delivery_id IS NOT NULL DO UPDATE
         SET agent_thread_id = EXCLUDED.agent_thread_id,
             task_run_id = EXCLUDED.task_run_id,
             dispatcher_run_id = EXCLUDED.dispatcher_run_id
         WHERE agent_turn_inputs.status = 'queued'
       RETURNING *`,
    [
      threadId,
      turn.kind === "worker" ? turn.id : null,
      turn.kind === "dispatcher" ? turn.id : null,
      options.messageDeliveryId ?? null,
      message
    ]
  );
  const run = await client.query<Record<string, unknown>>(
    `SELECT * FROM ${turn.kind === "worker" ? "task_runs" : "dispatcher_runs"} WHERE id = $1`,
    [turn.id]
  );
  return {
    input: input.rows[0] ?? { message, status: "queued", id: `input:${turn.id}:${Date.now()}` },
    run: mustRow(run.rows[0])
  };
}

async function selectThreadTurn(
  queryable: Pick<DbPool, "query">,
  threadId: string,
  options: IncrementalTurnOptions
): Promise<ThreadTurnCandidate | null> {
  const result = await queryable.query<ThreadTurnCandidate>(
    `SELECT id, kind, status, prompt, message_delivery_id, scope
     FROM (
       SELECT task_runs.id,
              'worker'::text AS kind,
              task_runs.status::text AS status,
              task_runs.prompt,
              NULL::uuid AS message_delivery_id,
              NULL::text AS scope,
              task_runs.queued_at,
              task_runs.started_at
       FROM task_runs
       JOIN agent_threads ON agent_threads.id = task_runs.agent_thread_id
       WHERE task_runs.agent_thread_id = $1
         AND task_runs.agent_thread_generation = agent_threads.ownership_generation
         AND task_runs.status IN ('queued', 'running')
       UNION ALL
       SELECT dispatcher_runs.id,
              'dispatcher'::text AS kind,
              dispatcher_runs.status::text AS status,
              dispatcher_runs.prompt,
              dispatcher_runs.message_delivery_id,
              dispatcher_runs.scope,
              dispatcher_runs.queued_at,
              dispatcher_runs.started_at
       FROM dispatcher_runs
       JOIN agent_threads ON agent_threads.id = dispatcher_runs.agent_thread_id
       WHERE dispatcher_runs.agent_thread_id = $1
         AND dispatcher_runs.agent_thread_generation = agent_threads.ownership_generation
         AND dispatcher_runs.status IN ('queued', 'running')
     ) turns
     WHERE ($2::text IS NULL OR kind = $2)
       AND ($3::text IS NULL OR scope = $3)
     ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END,
              CASE WHEN status = 'running' THEN started_at ELSE queued_at END ASC NULLS LAST,
              id ASC
     LIMIT 1`,
    [threadId, options.kind ?? null, options.scope ?? null]
  );
  return result.rows[0] ?? null;
}

async function resolveModelSelection(
  pool: Pick<DbPool, "query">,
  input: ModelSelectionInput | undefined,
  fallbackModel: string,
  thread?: Pick<AgentThreadRow, "provider_instance_id" | "model_options">
): Promise<ModelSelectionInput> {
  const providerInstanceId = input?.providerInstanceId ?? thread?.provider_instance_id ?? "codex-local";
  const provider = await pool.query<{ driver: string; enabled: boolean }>(
    "SELECT driver, enabled FROM provider_instances WHERE id = $1",
    [providerInstanceId]
  );
  const instance = mustRow(provider.rows[0]);
  if (!instance.enabled) throwBadRequest("The selected harness is disabled");
  if (instance.driver !== "codex") throwBadRequest("Only the Codex harness is currently supported");
  return {
    providerInstanceId,
    model: input?.model ?? fallbackModel,
    options: input?.options ?? normalizeModelOptions(thread?.model_options)
  };
}

interface EnsureTaskAgentThreadInput {
  task: TaskJoin;
  runtimeHome: string;
  providerThreadId: string | null;
  model: string;
  modelOptions: ModelSelectionInput["options"];
  cwd: string;
  branch: string | null;
}

interface EnsureTaskAgentThreadResult {
  id: string;
  model: string;
  model_options: unknown;
  runtime_home: string;
  provider_thread_id: string | null;
  ownership_generation: number;
}

export async function ensureTaskAgentThread(
  pool: DbPool,
  input: EnsureTaskAgentThreadInput
): Promise<EnsureTaskAgentThreadResult> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [input.task.id]);
    const task = await getTaskJoin(client, input.task.id);
    return ensureTaskAgentThreadInTransaction(client, {
      ...input,
      task,
      cwd: task.local_path ?? env.managedRoot,
      branch: task.source === "github" ? taskBranchName(task.number, task.title) : null
    });
  });
}

async function ensureTaskAgentThreadInTransaction(
  client: PoolClient,
  input: {
    task: TaskJoin;
    runtimeHome: string;
    providerThreadId: string | null;
    model: string;
    modelOptions: ModelSelectionInput["options"];
    cwd: string;
    branch: string | null;
  }
): Promise<EnsureTaskAgentThreadResult> {
  if (input.task.coordination_thread_id) {
    const coordinated = await client.query<{
      id: string;
      model: string;
      model_options: unknown;
      runtime_home: string;
      provider_thread_id: string | null;
      ownership_generation: number;
    }>(
      `INSERT INTO agent_threads
         (title, agent_id, task_id, project_id, provider_instance_id, model, model_options,
          cwd, branch, runtime_home, provider_thread_id, coordination_thread_id)
       VALUES ($1, $2, $3, $4, 'codex-local', $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (coordination_thread_id, agent_id) WHERE coordination_thread_id IS NOT NULL DO UPDATE
         SET title = EXCLUDED.title,
             task_id = EXCLUDED.task_id,
             project_id = EXCLUDED.project_id,
             cwd = EXCLUDED.cwd,
             branch = EXCLUDED.branch,
             runtime_home = EXCLUDED.runtime_home,
             provider_thread_id = CASE
               WHEN agent_threads.task_id = EXCLUDED.task_id
                 AND agent_threads.project_id IS NOT DISTINCT FROM EXCLUDED.project_id
                 AND agent_threads.cwd IS NOT DISTINCT FROM EXCLUDED.cwd
                 AND agent_threads.branch IS NOT DISTINCT FROM EXCLUDED.branch
                 AND agent_threads.runtime_home = EXCLUDED.runtime_home
                 THEN COALESCE(agent_threads.provider_thread_id, EXCLUDED.provider_thread_id)
               ELSE NULL
             END,
             ownership_generation = agent_threads.ownership_generation + CASE
               WHEN agent_threads.task_id IS DISTINCT FROM EXCLUDED.task_id
                 OR agent_threads.project_id IS DISTINCT FROM EXCLUDED.project_id
                 OR agent_threads.cwd IS DISTINCT FROM EXCLUDED.cwd
                 OR agent_threads.branch IS DISTINCT FROM EXCLUDED.branch
                 OR agent_threads.runtime_home IS DISTINCT FROM EXCLUDED.runtime_home
                 THEN 1
               ELSE 0
             END,
             last_activity_at = now(),
             updated_at = now()
       RETURNING id, model, model_options, runtime_home, provider_thread_id, ownership_generation`,
      [
        input.task.title,
        input.task.agent_id,
        input.task.id,
        input.task.project_id,
        input.model,
        JSON.stringify(input.modelOptions),
        input.cwd,
        input.branch,
        input.runtimeHome,
        input.providerThreadId,
        input.task.coordination_thread_id
      ]
    );
    const session = mustRow(coordinated.rows[0]);
    await cancelStaleQueuedAgentThreadRuns(client, session.id, session.ownership_generation);
    return session;
  }
  const result = await client.query<{
    id: string;
    model: string;
    model_options: unknown;
    runtime_home: string;
    provider_thread_id: string | null;
    ownership_generation: number;
  }>(
    `INSERT INTO agent_threads
       (title, agent_id, task_id, project_id, provider_instance_id, model, model_options,
        cwd, branch, runtime_home, provider_thread_id)
     VALUES ($1, $2, $3, $4, 'codex-local', $5, $6, $7, $8, $9, $10)
     ON CONFLICT (task_id) WHERE task_id IS NOT NULL DO UPDATE
       SET agent_id = EXCLUDED.agent_id,
           project_id = EXCLUDED.project_id,
           model = CASE
             WHEN agent_threads.agent_id <> EXCLUDED.agent_id THEN EXCLUDED.model
             ELSE agent_threads.model
           END,
           model_options = CASE
             WHEN agent_threads.agent_id <> EXCLUDED.agent_id THEN EXCLUDED.model_options
             ELSE agent_threads.model_options
           END,
           cwd = EXCLUDED.cwd,
           branch = EXCLUDED.branch,
           runtime_home = EXCLUDED.runtime_home,
           provider_thread_id = CASE
             WHEN agent_threads.agent_id = EXCLUDED.agent_id
               AND agent_threads.project_id IS NOT DISTINCT FROM EXCLUDED.project_id
               AND agent_threads.cwd IS NOT DISTINCT FROM EXCLUDED.cwd
               AND agent_threads.branch IS NOT DISTINCT FROM EXCLUDED.branch
               AND agent_threads.runtime_home = EXCLUDED.runtime_home
               THEN COALESCE(EXCLUDED.provider_thread_id, agent_threads.provider_thread_id)
             ELSE NULL
           END,
           ownership_generation = agent_threads.ownership_generation + CASE
             WHEN agent_threads.agent_id IS DISTINCT FROM EXCLUDED.agent_id
               OR agent_threads.project_id IS DISTINCT FROM EXCLUDED.project_id
               OR agent_threads.cwd IS DISTINCT FROM EXCLUDED.cwd
               OR agent_threads.branch IS DISTINCT FROM EXCLUDED.branch
               OR agent_threads.runtime_home IS DISTINCT FROM EXCLUDED.runtime_home
               THEN 1
             ELSE 0
           END,
           last_activity_at = now(),
           updated_at = now()
     RETURNING id, model, model_options, runtime_home, provider_thread_id, ownership_generation`,
    [
      input.task.title,
      input.task.agent_id,
      input.task.id,
      input.task.project_id,
      input.model,
      JSON.stringify(input.modelOptions),
      input.cwd,
      input.branch,
      input.runtimeHome,
      input.providerThreadId
    ]
  );
  const session = mustRow(result.rows[0]);
  await cancelStaleQueuedAgentThreadRuns(client, session.id, session.ownership_generation);
  return session;
}

async function ensureTaskNavigationThread(pool: DbPool, taskId: string): Promise<AgentThreadRow> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
    const task = await getTaskJoin(client, taskId);
    return ensureTaskNavigationThreadInTransaction(client, task);
  });
}

async function ensureTaskNavigationThreadInTransaction(
  client: PoolClient,
  task: TaskJoin
): Promise<AgentThreadRow> {
    const taskId = task.id;
    const runtimeHome = managedCodexHome(env.managedRoot, task.id);
    await isolateTaskNavigationThread(client, {
      taskId,
      coordinationThreadId: task.coordination_thread_id,
      agentId: task.agent_id
    });
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM agent_threads
       WHERE task_id = $1
          OR (coordination_thread_id = $2 AND agent_id = $3)
       ORDER BY (task_id = $1) DESC
       LIMIT 1
       FOR UPDATE`,
      [taskId, task.coordination_thread_id, task.agent_id]
    );
    if (existing.rows[0]) {
      await client.query(
      `UPDATE agent_threads
       SET title = $2,
           agent_id = $3,
           task_id = $9,
           project_id = $4,
           model = CASE WHEN agent_id <> $3 THEN $5 ELSE model END,
           model_options = CASE WHEN agent_id <> $3 THEN $6 ELSE model_options END,
           cwd = $7,
           runtime_home = $8,
           provider_thread_id = CASE
             WHEN agent_id IS DISTINCT FROM $3
               OR project_id IS DISTINCT FROM $4
               OR cwd IS DISTINCT FROM $7
               OR runtime_home IS DISTINCT FROM $8 THEN NULL
             ELSE provider_thread_id
           END,
           ownership_generation = ownership_generation + CASE
             WHEN agent_id IS DISTINCT FROM $3
               OR project_id IS DISTINCT FROM $4
               OR cwd IS DISTINCT FROM $7
               OR runtime_home IS DISTINCT FROM $8 THEN 1
             ELSE 0
           END,
           coordination_thread_id = $10,
           updated_at = now()
       WHERE id = $1`,
      [
        existing.rows[0].id,
        task.title,
        task.agent_id,
        task.project_id,
        task.agent_model,
        JSON.stringify(normalizeModelOptions(task.agent_model_options)),
        task.local_path ?? env.managedRoot,
        runtimeHome,
        task.id,
        task.coordination_thread_id
      ]
    );
      await linkTaskRunsToThread(client, taskId, existing.rows[0].id);
      const thread = await getAgentThread(client, existing.rows[0].id);
      await cancelStaleQueuedAgentThreadRuns(client, thread.id, thread.ownership_generation);
      return thread;
    }

    const created = await client.query<{ id: string }>(
     `INSERT INTO agent_threads
       (title, agent_id, task_id, project_id, provider_instance_id, model, model_options,
        cwd, branch, runtime_home, provider_thread_id, coordination_thread_id)
     VALUES ($1, $2, $3, $4, 'codex-local', $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (task_id) WHERE task_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      task.title,
      task.agent_id,
      task.id,
      task.project_id,
      task.agent_model,
      JSON.stringify(normalizeModelOptions(task.agent_model_options)),
      task.local_path ?? env.managedRoot,
      null,
      runtimeHome,
      null,
      task.coordination_thread_id
    ]
  );
    const threadId = created.rows[0]?.id ?? (
    await client.query<{ id: string }>(
      `SELECT id FROM agent_threads
       WHERE task_id = $1 OR (coordination_thread_id = $2 AND agent_id = $3)
       ORDER BY (task_id = $1) DESC
       LIMIT 1
       FOR UPDATE`,
      [taskId, task.coordination_thread_id, task.agent_id]
    )
  ).rows[0]?.id;
    if (!threadId) throw new Error("Failed to create the task's agent thread");
    await linkTaskRunsToThread(client, taskId, threadId);
    const thread = await getAgentThread(client, threadId);
    await cancelStaleQueuedAgentThreadRuns(client, thread.id, thread.ownership_generation);
    return thread;
}

export async function isolateTaskNavigationThread(
  pool: Pick<DbPool, "query">,
  input: { taskId: string; coordinationThreadId: string | null; agentId: string }
): Promise<void> {
  await pool.query(
    `UPDATE agent_threads
     SET task_id = NULL,
         coordination_thread_id = NULL,
         updated_at = now()
     WHERE (task_id = $1 OR (coordination_thread_id = $2 AND agent_id = $3))
       AND (
         EXISTS (
           SELECT 1
           FROM dispatcher_runs
           WHERE dispatcher_runs.agent_thread_id = agent_threads.id
             AND (
               dispatcher_runs.task_id IS DISTINCT FROM $1
               OR dispatcher_runs.scope IN ('thread', 'heartbeat')
             )
         )
         OR EXISTS (
           SELECT 1
           FROM task_runs
           WHERE task_runs.agent_thread_id = agent_threads.id
             AND task_runs.task_id <> $1
         )
       )`,
    [input.taskId, input.coordinationThreadId, input.agentId]
  );
}

export async function linkTaskRunsToThread(pool: Pick<DbPool, "query">, taskId: string, threadId: string): Promise<void> {
  const error = "The queued turn was cancelled before it could be linked to the new agent thread";
  const staleWorkers = await pool.query<{ id: string }>(
    `UPDATE task_runs
     SET status = 'cancelled',
         error = $2,
         finished_at = now(),
         updated_at = now()
     WHERE task_id = $1
       AND agent_thread_id IS NULL
       AND status = 'queued'
     RETURNING id`,
    [taskId, error]
  );
  for (const run of staleWorkers.rows) {
    await failUnlinkedRunInputs(pool, "task_run_id", run.id, null, error);
  }

  const staleDispatchers = await pool.query<{ id: string; message_delivery_id: string | null }>(
    `UPDATE dispatcher_runs
     SET status = 'cancelled',
         error = $2,
         finished_at = now(),
         updated_at = now()
     WHERE task_id = $1
       AND agent_thread_id IS NULL
       AND status = 'queued'
     RETURNING id, message_delivery_id`,
    [taskId, error]
  );
  for (const run of staleDispatchers.rows) {
    await failUnlinkedRunInputs(pool, "dispatcher_run_id", run.id, run.message_delivery_id, error);
  }

  await pool.query(
    `UPDATE task_runs
     SET agent_thread_id = $2,
         agent_thread_generation = (SELECT ownership_generation FROM agent_threads WHERE id = $2),
         updated_at = now()
     WHERE task_id = $1
       AND agent_thread_id IS NULL
       AND status NOT IN ('queued', 'running', 'cancel_requested')`,
    [taskId, threadId]
  );
  await pool.query(
    `UPDATE dispatcher_runs
     SET agent_thread_id = $2,
         agent_thread_generation = (SELECT ownership_generation FROM agent_threads WHERE id = $2),
         updated_at = now()
     WHERE task_id = $1
       AND agent_thread_id IS NULL
       AND status NOT IN ('queued', 'running', 'cancel_requested')`,
    [taskId, threadId]
  );
}

async function failUnlinkedRunInputs(
  queryable: Pick<DbPool, "query">,
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

function normalizeModelOptions(value: unknown): ModelSelectionInput["options"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string") return [];
    if (!["string", "number", "boolean"].includes(typeof entry.value)) return [];
    return [{ id: entry.id, value: entry.value as string | number | boolean }];
  });
}

function threadTitleFromMessage(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0]?.trim() || "New thread";
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79).trimEnd()}…`;
}

function encodeThreadCursor(value: string | Date, id: string): string {
  return Buffer.from(`${dateString(value)}|${id}`, "utf8").toString("base64url");
}

function decodeThreadCursor(value: string): { lastActivityAt: string; id: string } {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const lastActivityAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator <= 0 || !z.string().datetime().safeParse(lastActivityAt).success || !z.string().uuid().safeParse(id).success) {
      throw new Error("invalid cursor");
    }
    return { lastActivityAt, id };
  } catch {
    throwBadRequest("Invalid thread cursor");
  }
}

const agentThreadSelectSql = `
  SELECT agent_threads.id,
         agent_threads.title,
         agent_threads.agent_id,
         agents.name AS agent_name,
         agents.kind AS agent_kind,
         (
           coordination_threads.created_by_agent_id IS NOT NULL
           OR EXISTS (
             SELECT 1
             FROM schedule_runs
             WHERE schedule_runs.agent_thread_id = agent_threads.id
           )
         ) AS display_agent_identity,
         agent_threads.task_id,
         tasks.number AS task_number,
         agent_threads.project_id,
         projects.name AS project_name,
         projects.workspace_mode,
         projects.source AS workspace_source,
         agent_threads.provider_instance_id,
         provider_instances.driver AS provider_driver,
         provider_instances.display_name AS provider_name,
         agent_threads.model,
         agent_threads.model_options,
         agent_threads.cwd,
         agent_threads.branch,
         agent_threads.runtime_home,
         agent_threads.provider_thread_id,
         agent_threads.ownership_generation,
         agent_threads.last_activity_at,
         agent_threads.created_at,
         agent_threads.updated_at,
         latest.id AS latest_run_id,
         latest.kind AS latest_run_kind,
         latest.status AS latest_status,
         latest.error AS latest_error
  FROM agent_threads
  JOIN agents ON agents.id = agent_threads.agent_id
  JOIN provider_instances ON provider_instances.id = agent_threads.provider_instance_id
  LEFT JOIN coordination_threads ON coordination_threads.id = agent_threads.coordination_thread_id
  LEFT JOIN tasks ON tasks.id = agent_threads.task_id
  LEFT JOIN projects ON projects.id = agent_threads.project_id
  LEFT JOIN LATERAL (
    SELECT turns.id, turns.kind, turns.status, turns.error,
           turns.started_at, turns.finished_at, turns.created_at
    FROM (
      SELECT task_runs.id,
             'worker'::text AS kind,
             task_runs.status::text AS status,
             task_runs.error,
             task_runs.queued_at,
             task_runs.started_at,
             task_runs.finished_at,
             task_runs.created_at
      FROM task_runs
      WHERE task_runs.agent_thread_id = agent_threads.id
      UNION ALL
      SELECT dispatcher_runs.id,
             'dispatcher'::text AS kind,
             dispatcher_runs.status::text AS status,
             dispatcher_runs.error,
             dispatcher_runs.queued_at,
             dispatcher_runs.started_at,
             dispatcher_runs.finished_at,
             dispatcher_runs.created_at
      FROM dispatcher_runs
      WHERE dispatcher_runs.agent_thread_id = agent_threads.id
    ) turns
    ORDER BY CASE
               WHEN turns.status IN ('running', 'cancel_requested') THEN 0
               WHEN turns.status = 'queued' THEN 1
               ELSE 2
             END,
             CASE
               WHEN turns.status IN ('running', 'cancel_requested') THEN turns.started_at
               ELSE turns.queued_at
             END DESC NULLS LAST,
             turns.created_at DESC,
             turns.id DESC
    LIMIT 1
  ) latest ON true`;

async function queueWorkerRun(
  pool: DbPool,
  taskId: string,
  trigger: "manual" | "agent_tool",
  options: {
    promptOverride?: string;
    allowQueuedFollowUp?: boolean;
    modelSelection?: ModelSelectionInput;
    agentThreadId?: string;
  } = {}
): Promise<Record<string, unknown>> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
    const task = await getTaskJoin(client, taskId);
    if (task.agent_kind === "dispatcher") {
      throw new Error("Auto-route tasks must be dispatched before a worker run can start");
    }
    const projectId = task.project_id;
    const projectPath = task.local_path;
    const workspaceMode = task.workspace_mode;
    const projectSource = task.source;
    if (!projectId || !projectPath || !workspaceMode || !projectSource) {
      throwBadRequest("Assign a project before starting a worker run");
    }
    if (!options.allowQueuedFollowUp) {
      await ensureNoDirectProjectRun(client, projectId, workspaceMode);
    }

    const branch = projectSource === "github" ? taskBranchName(task.number, task.title) : null;
    const codexHome = managedCodexHome(env.managedRoot, task.id);
    const skillsSnapshot = await resolveTaskSkills(client, task);
    const skillRefs = skillsSnapshot.map((skill) => ({
      name: skill.name,
      description: skill.description
    }));
    const prompt =
      options.promptOverride ??
      buildCodexPrompt({
        agentName: task.agent_name,
        agentInstructions: task.agent_instructions,
        taskTitle: task.title,
        taskBody: task.body,
        projectPath,
        branch,
        skills: skillRefs
      });
    const agentSnapshot = {
      agentId: task.agent_id,
      name: task.agent_name,
      description: task.agent_description,
      model: task.agent_model,
      modelOptions: normalizeModelOptions(task.agent_model_options),
      instructions: task.agent_instructions
    };
    const session = await upsertTaskSession(client, task.id, codexHome, agentSnapshot);
    const thread = await ensureTaskAgentThreadInTransaction(client, {
      task,
      runtimeHome: codexHome,
      providerThreadId: session.codex_thread_id,
      model: options.modelSelection?.model ?? task.agent_model,
      modelOptions: options.modelSelection?.options ?? normalizeModelOptions(task.agent_model_options),
      cwd: projectPath,
      branch
    });
    await synchronizeTaskSessionRuntime(
      client,
      session.id,
      thread.runtime_home,
      thread.provider_thread_id
    );
    const model = options.modelSelection?.model ?? thread.model;
    const modelOptions = options.modelSelection?.options ?? normalizeModelOptions(thread.model_options);
    if (options.promptOverride && options.allowQueuedFollowUp) {
      const incremental = await appendIncrementalAgentTurnInput(client, thread.id, options.promptOverride, {
        kind: "worker"
      });
      if (incremental) return incremental.run;
    }
    const agentThreadId = options.agentThreadId ?? thread.id;
    if (agentThreadId !== thread.id) {
      throw new Error("The worker agent thread changed while queueing the turn");
    }
    const runResult = await client.query(
      `INSERT INTO task_runs
         (task_id, task_session_id, agent_thread_id, agent_thread_generation, workspace_key, workspace_mode, workspace_source, run_kind, trigger, status, cwd, branch,
          model, model_options, prompt, skills_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'worker', $8, 'queued', $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        task.id,
        session.id,
        agentThreadId,
        thread.ownership_generation,
        projectId,
        workspaceMode,
        projectSource,
        trigger,
        projectPath,
        branch,
        model,
        JSON.stringify(modelOptions),
        prompt,
        serializeCodexSkillSnapshots(skillsSnapshot)
      ]
    );
    const run = mustRow(runResult.rows[0]);
    await insertRunUserMessage(client, String(run.id), prompt);
    await client.query(
      `UPDATE agent_threads
       SET model = $2, model_options = $3, last_activity_at = now(), updated_at = now()
       WHERE id = $1`,
      [agentThreadId, model, JSON.stringify(modelOptions)]
    );
    return run;
  });
}

async function createDispatcherThread(pool: DbPool): Promise<Record<string, unknown>> {
  const dispatcher = await getDispatcherAgent(pool);
  const codexHome = managedCodexHome(env.managedRoot, `dispatcher-${randomUUID()}`);
  const skillsSnapshot = await resolveAgentSkills(pool, dispatcher.id);
  const result = await pool.query(
    `INSERT INTO dispatcher_runs
       (trigger, scope, status, cwd, codex_home, model, model_options, prompt, skills_snapshot)
     VALUES ('manual', 'thread', 'draft', $1, $2, $3, $4, '', $5)
     RETURNING *`,
    [
      env.managedRoot,
      codexHome,
      dispatcher.model,
      JSON.stringify(normalizeModelOptions(dispatcher.model_options)),
      serializeCodexSkillSnapshots(skillsSnapshot)
    ]
  );
  return mustRow(result.rows[0]);
}

interface DispatcherRunSnapshot {
  id: string;
  agent_thread_id: string | null;
  task_id: string | null;
  scope: string;
  cwd: string;
  codex_home: string;
  codex_thread_id: string | null;
  workspace_key: string;
  workspace_mode: string;
  workspace_source: string;
  model: string;
  model_options: unknown;
  prompt: string;
  status: string;
  skills_snapshot: CodexSkillSnapshot[];
}

async function queueDispatcherMessage(
  pool: DbPool,
  options: {
    sourceRunId?: string;
    taskId?: string;
    prompt: string;
    modelSelection?: ModelSelectionInput;
    agentThreadId?: string;
  }
): Promise<Record<string, unknown>> {
  return withTransaction(pool, async (client) => {
    if (options.taskId) {
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [options.taskId]);
    }
    const existing = options.sourceRunId
      ? await client.query<DispatcherRunSnapshot>(
          `SELECT id, agent_thread_id, task_id, scope, cwd, codex_home, codex_thread_id, workspace_key, workspace_mode, workspace_source, model, model_options, prompt, status::text, skills_snapshot
           FROM dispatcher_runs
           WHERE id = $1
           FOR UPDATE`,
          [options.sourceRunId]
        )
      : options.taskId
        ? await client.query<DispatcherRunSnapshot>(
            `SELECT id, agent_thread_id, task_id, scope, cwd, codex_home, codex_thread_id, workspace_key, workspace_mode, workspace_source, model, model_options, prompt, status::text, skills_snapshot
             FROM dispatcher_runs
             WHERE task_id = $1
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [options.taskId]
          )
        : { rows: [] };
    const previous = existing.rows[0];
    if (options.sourceRunId && !previous) {
      throw new Error("Dispatcher run was not found");
    }

    const currentTaskId = options.taskId ?? previous?.task_id ?? null;
    if (currentTaskId && !options.taskId) {
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [currentTaskId]);
    }
    const taskSnapshot = currentTaskId
      ? await getTaskJoin(client, currentTaskId)
      : null;
    const taskThread = taskSnapshot
      ? await ensureTaskNavigationThreadInTransaction(client, taskSnapshot)
      : null;
    if (taskSnapshot && taskSnapshot.agent_kind !== "dispatcher") {
      throw new Error("The task is assigned to a worker; queue a worker turn instead");
    }
    if (taskThread && options.agentThreadId && options.agentThreadId !== taskThread.id) {
      throw new Error("The dispatcher agent thread changed while queueing the turn");
    }
    const threadId = taskThread?.id ?? options.agentThreadId ?? previous?.agent_thread_id ?? null;
    let thread = taskThread && taskThread.id === threadId ? taskThread : null;
    if (threadId && !thread) {
      await client.query("SELECT id FROM agent_threads WHERE id = $1 FOR UPDATE", [threadId]);
      thread = await getAgentThread(client, threadId);
    }
    if (thread && options.modelSelection) {
      await client.query(
        `UPDATE agent_threads
         SET model = $2,
             model_options = $3,
             title = CASE WHEN title = 'New thread' THEN $4 ELSE title END,
             last_activity_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [thread.id, options.modelSelection.model, JSON.stringify(options.modelSelection.options), threadTitleFromMessage(options.prompt)]
      );
    }

    if (previous?.status === "draft" && !previous.prompt.trim()) {
      const result = await client.query(
        `UPDATE dispatcher_runs
         SET status = 'queued',
             prompt = $2,
             task_id = COALESCE($13, task_id),
             agent_thread_id = COALESCE($3, agent_thread_id),
             agent_thread_generation = COALESCE($4, agent_thread_generation),
             workspace_key = COALESCE($5, workspace_key),
             workspace_mode = COALESCE($6, workspace_mode),
             workspace_source = COALESCE($7, workspace_source),
             cwd = COALESCE($8, cwd),
             codex_home = COALESCE($9, codex_home),
             codex_thread_id = COALESCE($10, codex_thread_id),
             model = COALESCE($11, model),
             model_options = COALESCE($12, model_options),
             queued_at = now(),
             started_at = NULL,
             finished_at = NULL,
             error = NULL,
             updated_at = now()
         WHERE id = $1 AND status = 'draft'
         RETURNING *`,
        [
          previous.id,
          options.prompt,
          thread?.id ?? null,
          thread?.ownership_generation ?? null,
          thread ? thread.project_id ?? "" : null,
          thread ? workspaceSnapshotMode(thread) : null,
          thread ? workspaceSnapshotSource(thread) : null,
          thread ? thread.cwd ?? env.managedRoot : null,
          thread ? thread.runtime_home ?? env.managedRoot : null,
          thread ? thread.provider_thread_id ?? null : null,
          options.modelSelection?.model ?? thread?.model ?? null,
          options.modelSelection ? JSON.stringify(options.modelSelection.options) : null,
          taskSnapshot?.id ?? null
        ]
      );
      const run = mustRow(result.rows[0]);
      await insertDispatcherUserMessage(client, String(run.id), options.prompt);
      return run;
    }

    const dispatcher = previous ? null : await getDispatcherAgent(client);
    if (thread) {
      const incremental = await appendIncrementalAgentTurnInput(client, thread.id, options.prompt, {
        kind: "dispatcher",
        scope: previous?.scope
      });
      if (incremental) return incremental.run;
    }
    const codexHome = thread
      ? normalizeRunPath(thread.runtime_home) ?? env.managedRoot
      : normalizeRunPath(previous?.codex_home) ?? managedCodexHome(env.managedRoot, `dispatcher-${randomUUID()}`);
    const skillsSnapshot = previous
      ? normalizeCodexSkillSnapshots(previous.skills_snapshot)
      : dispatcher
        ? await resolveAgentSkills(client, dispatcher.id)
        : [];
    const result = await client.query(
      `INSERT INTO dispatcher_runs
         (task_id, agent_thread_id, agent_thread_generation, workspace_key, workspace_mode, workspace_source, trigger, scope, status, cwd, codex_home, codex_thread_id,
          model, model_options, prompt, skills_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, 'queued', $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        taskSnapshot?.id ?? previous?.task_id ?? options.taskId ?? null,
        thread?.id ?? null,
        thread?.ownership_generation ?? 0,
        thread ? thread.project_id ?? "" : previous?.workspace_key ?? "",
        thread
          ? workspaceSnapshotMode(thread)
          : previous?.workspace_mode ?? "unknown",
        thread
          ? workspaceSnapshotSource(thread)
          : previous?.workspace_source ?? "unknown",
        previous?.scope ?? (options.taskId ? "task" : "heartbeat"),
        thread ? normalizeRunPath(thread.cwd) ?? env.managedRoot : normalizeRunPath(previous?.cwd) ?? env.managedRoot,
        codexHome,
        thread?.provider_thread_id ?? previous?.codex_thread_id ?? null,
        options.modelSelection?.model ?? previous?.model ?? thread?.model ?? dispatcher?.model,
        JSON.stringify(
          options.modelSelection?.options ??
          normalizeModelOptions(previous?.model_options ?? thread?.model_options ?? dispatcher?.model_options)
        ),
        options.prompt,
        serializeCodexSkillSnapshots(skillsSnapshot)
      ]
    );
    const run = mustRow(result.rows[0]);
    await insertDispatcherUserMessage(client, String(run.id), options.prompt);
    return run;
  });
}

function normalizeRunPath(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return resolve(value);
}

function workspaceSnapshotMode(
  thread: Pick<AgentThreadRow, "project_id" | "workspace_mode">
): string {
  return thread.workspace_mode ?? (thread.project_id ? "unknown" : "projectless");
}

function workspaceSnapshotSource(
  thread: Pick<AgentThreadRow, "project_id" | "workspace_source">
): string {
  return thread.workspace_source ?? (thread.project_id ? "unknown" : "projectless");
}

async function queueDispatcherRun(
  pool: DbPool,
  options: { taskId?: string | null; trigger: "heartbeat" | "auto_route" }
): Promise<Record<string, unknown>> {
  const dispatcher = await getDispatcherAgent(pool);
  const context = await getDispatcherContext(pool);
  const skillsSnapshot = await resolveAgentSkills(pool, dispatcher.id);
  return withTransaction(pool, async (client) => {
    const targetTask = options.taskId
      ? await (async () => {
          await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [options.taskId]);
          return getTaskJoin(client, options.taskId!);
        })()
      : null;
    if (targetTask && targetTask.agent_kind !== "dispatcher") {
      throw new Error("The task is assigned to a worker; queue a worker turn instead");
    }
    const thread = targetTask
      ? await ensureTaskNavigationThreadInTransaction(client, targetTask)
      : null;
    const prompt = buildDispatcherPrompt({
      dispatcherInstructions: dispatcher.instructions,
      targetTaskNumber: targetTask?.number ?? null,
      tasksJson: JSON.stringify(context.tasks, null, 2),
      agentsJson: JSON.stringify(context.agents, null, 2),
      projectsJson: JSON.stringify(context.projects, null, 2),
      skills: skillsSnapshot.map((skill) => ({ name: skill.name, description: skill.description }))
    });
    const codexHome = thread?.runtime_home ?? managedCodexHome(env.managedRoot, `dispatcher-${randomUUID()}`);
    const result = await client.query(
      `INSERT INTO dispatcher_runs
         (task_id, agent_thread_id, agent_thread_generation, workspace_key, workspace_mode, workspace_source, trigger, scope, status, cwd, codex_home, model, model_options, prompt, skills_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        targetTask?.id ?? null,
        thread?.id ?? null,
        thread?.ownership_generation ?? 0,
        thread?.project_id ?? "",
        thread ? workspaceSnapshotMode(thread) : "unknown",
        thread ? workspaceSnapshotSource(thread) : "unknown",
        options.trigger,
        options.taskId ? "task" : "heartbeat",
        thread?.cwd ?? env.managedRoot,
        codexHome,
        thread?.model ?? dispatcher.model,
        JSON.stringify(normalizeModelOptions(thread?.model_options ?? dispatcher.model_options)),
        prompt,
        serializeCodexSkillSnapshots(skillsSnapshot)
      ]
    );
    const run = mustRow(result.rows[0]);
    await insertDispatcherUserMessage(client, String(run.id), prompt);
    return run;
  });
}

export async function getTaskSessionTimeline(
  pool: DbPool,
  taskId: string | null,
  agentThreadId?: string,
  includeTaskComments = true
): Promise<{
  run: TimelineRunRow | null;
  events: TimelineEventRow[];
}> {
  const [runsResult, eventsResult, commentsResult] = await Promise.all([
    pool.query<TimelineRunRow>(
      `SELECT id, kind, trigger, status, model, task_id, task_number, task_title,
              project_name, agent_name, prompt, queued_at, started_at, finished_at, created_at, error
       FROM (
         SELECT task_runs.id,
                'worker'::text AS kind,
                task_runs.trigger,
                task_runs.status::text,
                task_runs.model,
                task_runs.task_id,
                tasks.number AS task_number,
                tasks.title AS task_title,
                projects.name AS project_name,
                COALESCE(task_sessions.agent_snapshot->>'name', agents.name) AS agent_name,
                task_runs.prompt,
                task_runs.queued_at,
                task_runs.started_at,
                task_runs.finished_at,
                task_runs.error,
                task_runs.created_at
         FROM task_runs
         JOIN tasks ON tasks.id = task_runs.task_id
         LEFT JOIN projects ON projects.id = tasks.project_id
         JOIN agents ON agents.id = tasks.agent_id
         JOIN task_sessions ON task_sessions.id = task_runs.task_session_id
         WHERE task_runs.run_kind = 'worker'
           AND (
             ($2::uuid IS NOT NULL AND task_runs.agent_thread_id = $2)
             OR ($2::uuid IS NULL AND task_runs.task_id = $1)
           )
         UNION ALL
         SELECT dispatcher_runs.id,
                'dispatcher'::text AS kind,
                dispatcher_runs.trigger,
                dispatcher_runs.status::text,
                dispatcher_runs.model,
                dispatcher_runs.task_id,
                tasks.number AS task_number,
                tasks.title AS task_title,
                projects.name AS project_name,
                'Orchestrator'::text AS agent_name,
                dispatcher_runs.prompt,
                dispatcher_runs.queued_at,
                dispatcher_runs.started_at,
                dispatcher_runs.finished_at,
                dispatcher_runs.error,
                dispatcher_runs.created_at
         FROM dispatcher_runs
         LEFT JOIN tasks ON tasks.id = dispatcher_runs.task_id
         LEFT JOIN projects ON projects.id = tasks.project_id
         WHERE (
             ($2::uuid IS NOT NULL AND dispatcher_runs.agent_thread_id = $2)
             OR ($2::uuid IS NULL AND dispatcher_runs.task_id = $1)
           )
       ) task_runs_and_dispatches
       ORDER BY queued_at ASC, created_at ASC`,
      [taskId, agentThreadId ?? null]
    ),
    pool.query<TimelineEventRow>(
      `SELECT id, run_id, dispatcher_run_id, seq, event_type, text, payload, created_at
       FROM (
         SELECT run_events.id,
                run_events.run_id,
                NULL::uuid AS dispatcher_run_id,
                run_events.seq,
                run_events.event_type,
                run_events.text,
                run_events.payload,
                run_events.created_at,
                task_runs.queued_at
         FROM run_events
         JOIN task_runs ON task_runs.id = run_events.run_id
         WHERE task_runs.run_kind = 'worker'
           AND (
             ($2::uuid IS NOT NULL AND task_runs.agent_thread_id = $2)
             OR ($2::uuid IS NULL AND task_runs.task_id = $1)
           )
         UNION ALL
         SELECT dispatcher_run_events.id,
                NULL::uuid AS run_id,
                dispatcher_run_events.dispatcher_run_id,
                dispatcher_run_events.seq,
                dispatcher_run_events.event_type,
                dispatcher_run_events.text,
                dispatcher_run_events.payload,
                dispatcher_run_events.created_at,
                dispatcher_runs.queued_at
         FROM dispatcher_run_events
         JOIN dispatcher_runs ON dispatcher_runs.id = dispatcher_run_events.dispatcher_run_id
         WHERE (
             ($2::uuid IS NOT NULL AND dispatcher_runs.agent_thread_id = $2)
             OR ($2::uuid IS NULL AND dispatcher_runs.task_id = $1)
           )
         UNION ALL
         SELECT agent_turn_inputs.id,
                agent_turn_inputs.task_run_id AS run_id,
                agent_turn_inputs.dispatcher_run_id,
                0 AS seq,
                'thread.message-sent' AS event_type,
                agent_turn_inputs.message AS text,
                jsonb_build_object(
                  'type', 'thread.message-sent',
                  'role', 'user',
                  'text', agent_turn_inputs.message,
                  'steer', true,
                  'deliveryStatus', agent_turn_inputs.status,
                  'error', agent_turn_inputs.error
                ) AS payload,
                agent_turn_inputs.created_at,
                COALESCE(task_runs.queued_at, dispatcher_runs.queued_at) AS queued_at
         FROM agent_turn_inputs
         LEFT JOIN task_runs ON task_runs.id = agent_turn_inputs.task_run_id
         LEFT JOIN dispatcher_runs ON dispatcher_runs.id = agent_turn_inputs.dispatcher_run_id
         WHERE (
             ($2::uuid IS NOT NULL AND agent_turn_inputs.agent_thread_id = $2)
             OR (
               $2::uuid IS NULL
               AND (task_runs.task_id = $1 OR dispatcher_runs.task_id = $1)
             )
           )
       ) task_events
       ORDER BY queued_at ASC, created_at ASC, seq ASC`,
      [taskId, agentThreadId ?? null]
    ),
    pool.query<TimelineEventRow>(
      `SELECT task_comments.id,
              NULL::uuid AS run_id,
              NULL::uuid AS dispatcher_run_id,
              0 AS seq,
              'task.comment' AS event_type,
              task_comments.body AS text,
              jsonb_build_object('type', 'task.comment', 'text', task_comments.body) AS payload,
              task_comments.created_at
       FROM task_comments
       WHERE task_comments.task_id = $1
         AND $2::boolean
         AND $3::uuid IS NULL
       ORDER BY task_comments.created_at ASC`,
      [taskId, includeTaskComments, agentThreadId ?? null]
    )
  ]);
  const runs = runsResult.rows;
  const latest = selectPreferredTimelineRun(runs);
  return {
    run: latest ? { ...latest, prompt: null } : null,
    events: withSyntheticUserMessages(runs, [...eventsResult.rows, ...commentsResult.rows])
  };
}

type TimelineRunCandidate = Pick<
  TimelineRunRow,
  "id" | "status" | "queued_at" | "started_at" | "finished_at" | "created_at"
>;

/** Select the run whose status should be displayed, keeping status and metadata from one row. */
export function selectPreferredTimelineRun<T extends TimelineRunCandidate>(
  runs: readonly T[]
): T | null {
  let preferred: T | null = null;
  for (const run of runs) {
    if (!preferred) {
      preferred = run;
      continue;
    }
    const rank = timelineRunStatusRank(run.status);
    const preferredRank = timelineRunStatusRank(preferred.status);
    if (
      rank < preferredRank ||
      (rank === preferredRank && compareTimelineRunOrder(run, preferred) > 0)
    ) {
      preferred = run;
    }
  }
  return preferred;
}

function timelineRunStatusRank(status: string): number {
  if (status === "running" || status === "cancel_requested") return 0;
  if (status === "queued") return 1;
  return 2;
}

function compareTimelineRunOrder(left: TimelineRunCandidate, right: TimelineRunCandidate): number {
  return (
    timelineRunSortValue(left).localeCompare(timelineRunSortValue(right)) ||
    dateString(left.created_at).localeCompare(dateString(right.created_at)) ||
    left.id.localeCompare(right.id)
  );
}

function timelineRunSortValue(run: TimelineRunCandidate): string {
  return dateString(
    run.status === "running" || run.status === "cancel_requested"
      ? run.started_at ?? run.queued_at
      : run.queued_at ?? run.started_at ?? run.finished_at ?? run.created_at
  );
}

async function insertRunUserMessage(pool: Pick<DbPool, "query">, runId: string, prompt: string): Promise<void> {
  await pool.query(
    `INSERT INTO run_events (run_id, seq, event_type, text, payload)
     VALUES ($1, -1, 'thread.message-sent', $2, $3)
     ON CONFLICT (run_id, seq) DO NOTHING`,
    [runId, prompt, { type: "thread.message-sent", role: "user", text: prompt }]
  );
}

async function insertDispatcherUserMessage(pool: Pick<DbPool, "query">, runId: string, prompt: string): Promise<void> {
  await pool.query(
    `INSERT INTO dispatcher_run_events (dispatcher_run_id, seq, event_type, text, payload)
     VALUES ($1, -1, 'thread.message-sent', $2, $3)
     ON CONFLICT (dispatcher_run_id, seq) DO NOTHING`,
    [runId, prompt, { type: "thread.message-sent", role: "user", text: prompt }]
  );
}

function withSyntheticUserMessages(
  runs: ReadonlyArray<Pick<TimelineRunRow, "id" | "prompt" | "queued_at">>,
  events: ReadonlyArray<TimelineEventRow>
): TimelineEventRow[] {
  const runsWithUserEvents = new Set(
    events
      .filter((event) => event.event_type === "thread.message-sent")
      .map((event) => event.run_id ?? event.dispatcher_run_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  const synthetic = runs.flatMap((run): TimelineEventRow[] => {
    if (!run.prompt?.trim() || runsWithUserEvents.has(run.id)) return [];
    return [
      {
        id: `user-message:${run.id}`,
        run_id: run.id,
        seq: -1,
        event_type: "thread.message-sent",
        text: run.prompt,
        payload: { type: "thread.message-sent", role: "user", text: run.prompt },
        created_at: run.queued_at ?? null
      }
    ];
  });
  return [...synthetic, ...events].sort(compareTimelineEvents);
}

function compareTimelineEvents(left: TimelineEventRow, right: TimelineEventRow): number {
  const leftTime = dateString(left.created_at);
  const rightTime = dateString(right.created_at);
  return (
    leftTime.localeCompare(rightTime) ||
    left.seq - right.seq ||
    String(left.id).localeCompare(String(right.id))
  );
}

function dateString(value: string | Date | null | undefined): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : value;
}

async function upsertTaskSession(
  pool: Pick<DbPool, "query">,
  taskId: string,
  codexHome: string,
  agentSnapshot: Record<string, unknown>
): Promise<{ id: string; codex_thread_id: string | null }> {
  const result = await pool.query<{ id: string; codex_thread_id: string | null }>(
    `INSERT INTO task_sessions (task_id, codex_home, agent_snapshot)
     VALUES ($1, $2, $3)
     ON CONFLICT (task_id) DO UPDATE
       SET codex_thread_id = CASE
             WHEN task_sessions.codex_home = EXCLUDED.codex_home
               AND task_sessions.agent_snapshot->>'agentId' = EXCLUDED.agent_snapshot->>'agentId'
               THEN task_sessions.codex_thread_id
             ELSE NULL
           END,
           codex_home = EXCLUDED.codex_home,
           agent_snapshot = EXCLUDED.agent_snapshot,
           updated_at = now()
     RETURNING id, codex_thread_id`,
    [taskId, codexHome, agentSnapshot]
  );
  return mustRow(result.rows[0]);
}

export async function synchronizeTaskSessionRuntime(
  pool: Pick<DbPool, "query">,
  sessionId: string,
  runtimeHome: string,
  providerThreadId: string | null
): Promise<void> {
  await pool.query(
    `UPDATE task_sessions
     SET codex_home = $2,
         codex_thread_id = $3,
         updated_at = now()
     WHERE id = $1`,
    [sessionId, runtimeHome, providerThreadId]
  );
}

async function resolveTaskSkills(pool: Pick<DbPool, "query">, task: Pick<TaskJoin, "id" | "project_id" | "agent_id">): Promise<CodexSkillSnapshot[]> {
  return resolveSelectedSkills(pool, task.agent_id, task.project_id, task.id);
}

async function resolveAgentSkills(pool: Pick<DbPool, "query">, agentId: string): Promise<CodexSkillSnapshot[]> {
  return resolveSelectedSkills(pool, agentId, null, null);
}

async function resolveSelectedSkills(
  pool: Pick<DbPool, "query">,
  agentId: string,
  projectId: string | null,
  taskId: string | null
): Promise<CodexSkillSnapshot[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    description: string;
    instructions: string;
    files: unknown;
    source: string;
  }>(
    `SELECT skills.id,
            skills.name,
            skills.description,
            skills.instructions,
            skills.files,
            selected.source
     FROM skills
     JOIN (
       SELECT id AS skill_id, 'default'::text AS source FROM skills WHERE default_for_agents = true
       UNION ALL SELECT skill_id, 'agent' FROM agent_skills WHERE agent_id = $1
       UNION ALL
         SELECT skills.id, 'instruction'
         FROM skills
         JOIN agents ON agents.id = $1
         WHERE position('@skill(' || skills.name || ')' in agents.instructions) > 0
       UNION ALL SELECT skill_id, 'project' FROM project_skills WHERE project_id = $2
       UNION ALL SELECT skill_id, 'task' FROM task_skills WHERE task_id = $3
     ) selected ON selected.skill_id = skills.id
     WHERE skills.enabled = true
     ORDER BY skills.name ASC`
    , [agentId, projectId, taskId]
  );
  return mergeSkillRows(result.rows);
}

function mergeSkillRows(
  rows: Array<{
    id: string;
    name: string;
    description: string;
    instructions: string;
    files: unknown;
    source: string;
  }>
): CodexSkillSnapshot[] {
  const byId = new Map<string, CodexSkillSnapshot>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing) {
      if (!existing.sources.includes(row.source)) existing.sources.push(row.source);
      continue;
    }
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      files: normalizeSkillFiles(row.files),
      sources: [row.source]
    });
  }
  return [...byId.values()];
}

function normalizeSkillFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(value as Record<string, unknown>)) {
    if (typeof content === "string") files[path] = content;
  }
  return files;
}

function validateSkillFiles(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== "string") {
      throwBadRequest(`Skill file ${path} must contain text`);
    }
    const parts = path.split("/");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throwBadRequest(`Skill file path is not allowed: ${path}`);
    }
    if (path === "SKILL.md" || path.endsWith("/SKILL.md")) {
      throwBadRequest("Aisevak generates SKILL.md from the skill instructions");
    }
  }
}

function throwBadRequest(message: string): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  throw error;
}

async function ensureNoDirectProjectRun(
  pool: Pick<DbPool, "query">,
  projectId: string,
  workspaceMode: "direct" | "git_worktree"
): Promise<void> {
  if (workspaceMode === "git_worktree") return;
  const active = await pool.query<{ count: string }>(
    `SELECT count(*)
     FROM task_runs
     JOIN tasks ON tasks.id = task_runs.task_id
     WHERE tasks.project_id = $1
       AND task_runs.run_kind = 'worker'
       AND task_runs.status IN ('queued', 'running', 'cancel_requested')`,
    [projectId]
  );
  if (Number(active.rows[0]?.count ?? 0) > 0) {
    throw new Error("This direct-mode project already has an active run");
  }
}

async function getDispatcherAgent(pool: Pick<DbPool, "query">): Promise<{
  id: string;
  model: string;
  model_options: unknown;
  instructions: string;
}> {
  const result = await pool.query<{ id: string; model: string; model_options: unknown; instructions: string }>(
    "SELECT id, model, model_options, instructions FROM agents WHERE kind = 'dispatcher' AND enabled = true ORDER BY created_at ASC LIMIT 1"
  );
  return mustRow(result.rows[0]);
}

async function getWorkerAgentByIdentifier(pool: DbPool, identifier: string): Promise<{
  id: string;
  name: string;
  model: string;
}> {
  const normalized = identifier.trim();
  const result = await pool.query<{ id: string; name: string; model: string }>(
    `SELECT id, name, model
     FROM agents
     WHERE kind = 'worker'
       AND enabled = true
       AND (id::text = $1 OR lower(name) = lower($1))
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalized]
  );
  return mustRow(result.rows[0]);
}

async function getDispatcherContext(pool: DbPool): Promise<{
  tasks: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
}> {
  const tasks = await pool.query(
    `SELECT tasks.id,
            tasks.number,
            tasks.title,
            tasks.body,
            tasks.status,
            tasks.project_id,
            projects.name AS project_name,
            projects.workspace_mode,
            CASE WHEN agents.kind = 'dispatcher' THEN 'Auto-route' ELSE agents.name END AS agent_name,
            agents.kind AS agent_kind,
            latest.status AS latest_worker_status,
            latest.id AS latest_worker_run_id
     FROM tasks
     LEFT JOIN projects ON projects.id = tasks.project_id
     JOIN agents ON agents.id = tasks.agent_id
     LEFT JOIN LATERAL (
       SELECT id, status
       FROM task_runs
       WHERE task_runs.task_id = tasks.id AND task_runs.run_kind = 'worker'
       ORDER BY created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE latest.status IN ('queued', 'running', 'cancel_requested', 'failed')
        OR tasks.status IN ('needs_attention', 'blocked')
        OR (
          tasks.status = 'open'
          AND COALESCE(latest.status::text, '') NOT IN ('queued', 'running', 'cancel_requested', 'succeeded')
        )
     ORDER BY tasks.created_at ASC`
  );
  const agents = await pool.query(
    `SELECT id, kind, name, description, model, enabled
     FROM agents
     WHERE enabled = true
     ORDER BY kind ASC, created_at ASC`
  );
  const projects = await pool.query(
    `SELECT id, name, source, local_path, workspace_mode, default_branch
     FROM projects
     WHERE active = true
     ORDER BY created_at ASC`
  );
  return { tasks: tasks.rows, agents: agents.rows, projects: projects.rows };
}

async function requireLegacyAgentCapabilities(
  pool: DbPool,
  request: FastifyRequest,
  ...capabilities: string[]
): Promise<AgentContext> {
  const context = await requireAgent(pool, request);
  for (const capability of capabilities) requireCapability(context, capability);
  return context;
}

async function getTaskByKey(pool: DbPool, key: string): Promise<{ id: string; number: number }> {
  const numberMatch = key.match(/^(?:TASK-)?(\d+)$/i);
  const result = numberMatch
    ? await pool.query<{ id: string; number: number }>("SELECT id, number FROM tasks WHERE number = $1", [
        Number(numberMatch[1])
      ])
    : await pool.query<{ id: string; number: number }>("SELECT id, number FROM tasks WHERE id = $1", [
        key
      ]);
  return mustRow(result.rows[0]);
}

async function upsertSecret(pool: DbPool, name: string, value: string): Promise<string> {
  const encrypted = encryptSecret(value, env.secretKey);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO secrets (name, encrypted_value)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = now()
     RETURNING id`,
    [name, encrypted]
  );
  return mustRow(result.rows[0]).id;
}

async function readSecret(pool: DbPool, name: string): Promise<string | undefined> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1",
    [name]
  );
  const row = result.rows[0];
  return row ? decryptSecret(row.encrypted_value, env.secretKey) : undefined;
}

function mustRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Expected database row was not found");
  }
  return row;
}

async function runCommand(
  command: string,
  args: string[],
  stdin?: string,
  secret?: string,
  cwd?: string,
  envOverrides?: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(secret ? { CODEX_API_KEY: secret, OPENAI_API_KEY: secret } : {}),
        ...envOverrides
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += error.message;
      resolve({ exitCode: 1, stdout, stderr });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function streamRunEvents(pool: DbPool, runId: string, reply: FastifyReply): Promise<void> {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  let seq = 0;
  let closed = false;
  reply.raw.on("close", () => {
    closed = true;
  });

  while (!closed) {
    const events = await pool.query(
      "SELECT * FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC",
      [runId, seq]
    );
    for (const event of events.rows) {
      seq = Math.max(seq, Number(event.seq));
      reply.raw.write(`event: run_event\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    const status = await pool.query<{ status: string }>("SELECT status FROM task_runs WHERE id = $1", [
      runId
    ]);
    const current = status.rows[0]?.status;
    if (current && !["queued", "running", "cancel_requested"].includes(current)) {
      reply.raw.write(`event: done\n`);
      reply.raw.write(`data: ${JSON.stringify({ status: current })}\n\n`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  reply.raw.end();
}

async function main(): Promise<void> {
  await mkdir(env.managedRoot, { recursive: true });
  const pool = createPool();
  await runMigrations(pool);
  const app = await buildServer(pool);
  app.log.info({ codexBinary: env.codexBinary }, "Codex harness configured");
  await app.listen({ host: env.apiHost, port: env.apiPort });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

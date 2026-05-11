import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import {
  buildCodexPrompt,
  buildDispatcherPrompt,
  createPool,
  decryptSecret,
  encryptSecret,
  fetchGithubInstallationToken,
  githubCloneEnv,
  githubHeaders,
  hashPassword,
  hashToken,
  managedCodexHome,
  managedGithubRepoPath,
  newSessionToken,
  normalizeGithubRepo,
  CODEX_HARNESS_MODELS,
  DEFAULT_CODEX_MODEL,
  runMigrations,
  taskBranchName,
  verifyPassword,
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
import { fileURLToPath } from "node:url";
import { z } from "zod";

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
  managedRoot: process.env.MANAGED_ROOT ?? "/srv/aisevak",
  codexBinary: process.env.CODEX_BINARY ?? "codex",
  codexDefaultModel: process.env.CODEX_DEFAULT_MODEL ?? DEFAULT_CODEX_MODEL,
  githubApiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com"
};

export async function buildServer(pool: DbPool): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(sensible);
  await app.register(cookie, { secret: env.cookieSecret });
  await app.register(cors, {
    origin: env.appOrigin,
    credentials: true
  });

  app.addHook("preHandler", async (request) => {
    request.user = await getUserFromCookie(pool, request);
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/onboarding/status", async () => {
    const users = await pool.query<{ count: string }>("SELECT count(*) FROM users");
    return { hasAdmin: Number(users.rows[0]?.count ?? 0) > 0 };
  });

  app.get("/api/me", async (request) => ({ user: request.user ?? null }));

  app.get("/api/codex/models", async (request) => {
    requireUser(request);
    return {
      defaultModel: env.codexDefaultModel,
      models: CODEX_HARNESS_MODELS
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
    const result = await pool.query("SELECT * FROM projects ORDER BY created_at DESC");
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
    return { project: result.rows[0] };
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
    return { project: mustRow(result.rows[0]) };
  });

  app.get("/api/agents", async (request) => {
    requireUser(request);
    const result = await pool.query("SELECT * FROM agents ORDER BY created_at DESC");
    return { agents: result.rows };
  });

  app.post("/api/agents", async (request) => {
    const user = requireAdmin(request);
    const body = agentSchema.parse(request.body);
    const result = await pool.query(
      `INSERT INTO agents (name, description, model, instructions, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [body.name, body.description ?? "", body.model ?? env.codexDefaultModel, body.instructions, true]
    );
    const agent = mustRow(result.rows[0]);
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
           instructions = COALESCE($5, instructions),
           enabled = COALESCE($6, enabled),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        body.name ?? null,
        body.description ?? null,
        body.model ?? null,
        body.instructions ?? null,
        body.enabled ?? null
      ]
    );
    const agent = mustRow(result.rows[0]);
    await insertAgentVersion(pool, agent, user.id);
    return { agent };
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
       JOIN projects ON projects.id = tasks.project_id
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
    const result = await pool.query(
      `INSERT INTO tasks (title, body, project_id, agent_id, created_by, open_pr_on_success)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [body.title, body.body ?? "", body.projectId, agentId, user.id, body.openPrOnSuccess ?? false]
    );
    return { task: result.rows[0] };
  });

  app.patch("/api/tasks/:id", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const body = taskPatchSchema.parse(request.body);
    const result = await pool.query(
      `UPDATE tasks
       SET title = COALESCE($2, title),
           body = COALESCE($3, body),
           status = COALESCE($4, status),
           project_id = COALESCE($5, project_id),
           agent_id = COALESCE($6, agent_id),
           open_pr_on_success = COALESCE($7, open_pr_on_success),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        body.title ?? null,
        body.body ?? null,
        body.status ?? null,
        body.projectId ?? null,
        body.agentId ?? null,
        body.openPrOnSuccess ?? null
      ]
    );
    return { task: mustRow(result.rows[0]) };
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

  app.post("/api/runs/:id/cancel", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const result = await pool.query(
      `UPDATE task_runs
       SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
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
         JOIN projects ON projects.id = tasks.project_id
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

  app.get("/api/agent-runs", async (request) => {
    requireUser(request);
    const result = await pool.query(
      `SELECT *
       FROM (
         SELECT task_runs.id,
                'worker' AS kind,
                task_runs.trigger,
                task_runs.status::text,
                task_runs.model,
                task_runs.task_id,
                tasks.number AS task_number,
                tasks.title AS task_title,
                projects.name AS project_name,
                COALESCE(task_sessions.agent_snapshot->>'name', agents.name) AS agent_name,
                task_runs.queued_at,
                task_runs.started_at,
                task_runs.finished_at,
                task_runs.error
         FROM task_runs
         JOIN tasks ON tasks.id = task_runs.task_id
         JOIN projects ON projects.id = tasks.project_id
         JOIN agents ON agents.id = tasks.agent_id
         JOIN task_sessions ON task_sessions.id = task_runs.task_session_id
         WHERE task_runs.run_kind = 'worker'
         UNION ALL
         SELECT dispatcher_runs.id,
                'dispatcher' AS kind,
                dispatcher_runs.trigger,
                dispatcher_runs.status::text,
                dispatcher_runs.model,
                dispatcher_runs.task_id,
                tasks.number AS task_number,
                tasks.title AS task_title,
                projects.name AS project_name,
                'Dispatcher' AS agent_name,
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
                  'Dispatcher' AS agent_name,
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
    const source = await pool.query<{ task_id: string }>("SELECT task_id FROM task_runs WHERE id = $1", [
      params.id
    ]);
    return getTaskSessionTimeline(pool, mustRow(source.rows[0]).task_id);
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
    await requireAgentTool(pool, request);
    return getDispatcherContext(pool);
  });

  app.post("/api/agent-tools/tasks", async (request) => {
    const context = await requireAgentTool(pool, request);
    const body = agentToolCreateTaskSchema.parse(request.body);
    const projectId = body.projectId ?? context.taskProjectId ?? (await getFirstProjectId(pool));
    const agentId = body.agentId ?? (await getDispatcherAgent(pool)).id;
    const result = await pool.query(
      `INSERT INTO tasks (title, body, status, project_id, agent_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [body.title, body.body ?? "", body.status ?? "open", projectId, agentId]
    );
    return { task: result.rows[0] };
  });

  app.patch("/api/agent-tools/tasks/:key", async (request) => {
    await requireAgentTool(pool, request);
    const { key } = taskKeyParams.parse(request.params);
    const task = await getTaskByKey(pool, key);
    const body = agentToolPatchTaskSchema.parse(request.body);
    const result = await pool.query(
      `UPDATE tasks
       SET title = COALESCE($2, title),
           body = COALESCE($3, body),
           status = COALESCE($4, status),
           agent_id = COALESCE($5, agent_id),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [task.id, body.title ?? null, body.body ?? null, body.status ?? null, body.agentId ?? null]
    );
    return { task: mustRow(result.rows[0]) };
  });

  app.post("/api/agent-tools/tasks/:key/comment", async (request) => {
    await requireAgentTool(pool, request);
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
    const context = await requireAgentTool(pool, request);
    if (context.role !== "dispatcher") {
      throw app.httpErrors.forbidden("Only Dispatcher can start worker runs");
    }
    const { key } = taskKeyParams.parse(request.params);
    const task = await getTaskByKey(pool, key);
    const body = agentToolAssignSchema.parse(request.body);
    const agent = await getWorkerAgentByIdentifier(pool, body.agent);
    await pool.query("UPDATE tasks SET agent_id = $2, status = 'open', updated_at = now() WHERE id = $1", [
      task.id,
      agent.id
    ]);
    const run = body.run ? await queueWorkerRun(pool, task.id, "agent_tool") : null;
    return { taskId: task.id, agent, run };
  });

  app.post("/api/github/app-manifest/start", async (request) => {
    requireAdmin(request);
    const body = githubManifestSchema.parse(request.body ?? {});
    const manifest = {
      name: body.name ?? "Aisevak",
      url: env.appOrigin,
      redirect_url: `${env.appOrigin}/github/callback`,
      public: false,
      default_permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write"
      }
    };
    return {
      manifest,
      manifestUrl: `https://github.com/settings/apps/new?manifest=${encodeURIComponent(
        JSON.stringify(manifest)
      )}`
    };
  });

  app.post("/api/github/app-manifest/callback", async (request) => {
    const user = requireAdmin(request);
    const body = githubCallbackSchema.parse(request.body);
    const privateKeySecretId = body.privateKey
      ? await upsertSecret(pool, `github_app_private_key_${body.appId}`, body.privateKey)
      : null;
    const webhookSecretId = body.webhookSecret
      ? await upsertSecret(pool, `github_app_webhook_${body.appId}`, body.webhookSecret)
      : null;
    const result = await pool.query(
      `INSERT INTO github_connections
       (auth_mode, name, app_id, client_id, private_key_secret_id, webhook_secret_id, created_by)
       VALUES ('app', $1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [body.name, body.appId, body.clientId ?? null, privateKeySecretId, webhookSecretId, user.id]
    );
    const connection = mustRow(result.rows[0]);
    if (body.installationId && body.accountLogin) {
      await pool.query(
        `INSERT INTO github_installations
         (connection_id, installation_id, account_login, permissions)
         VALUES ($1, $2, $3, '{}'::jsonb)`,
        [connection.id, body.installationId, body.accountLogin]
      );
    }
    return { connection };
  });

  app.post("/api/github/pat", async (request) => {
    const user = requireAdmin(request);
    const body = githubPatSchema.parse(request.body);
    const secretId = await upsertSecret(pool, `github_pat_${Date.now()}`, body.token);
    const result = await pool.query(
      `INSERT INTO github_connections (auth_mode, name, pat_secret_id, created_by)
       VALUES ('pat', $1, $2, $3)
       RETURNING *`,
      [body.name, secretId, user.id]
    );
    return { connection: result.rows[0] };
  });

  app.get("/api/github/installations", async (request) => {
    requireAdmin(request);
    const result = await pool.query(
      `SELECT github_installations.*, github_connections.name AS connection_name
       FROM github_installations
       JOIN github_connections ON github_connections.id = github_installations.connection_id
       ORDER BY github_installations.created_at DESC`
    );
    return { installations: result.rows };
  });

  app.get("/api/github/repositories", async (request) => {
    requireAdmin(request);
    const query = repositoriesQuerySchema.parse(request.query);
    if (query.refresh === "true") {
      await refreshPatRepositories(pool);
    }
    const result = await pool.query(
      `SELECT github_repositories.*, github_connections.name AS connection_name
       FROM github_repositories
       JOIN github_connections ON github_connections.id = github_repositories.connection_id
       ORDER BY github_repositories.full_name ASC`
    );
    return { repositories: result.rows };
  });

  app.post("/api/github/repositories/:id/import", async (request) => {
    const user = requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const repo = await pool.query(
      "SELECT * FROM github_repositories WHERE id = $1",
      [id]
    );
    const repoRow = mustRow(repo.rows[0]);
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

  app.post("/api/tasks/:id/pr/prepare", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const context = await getPullRequestContext(pool, id);
    const diff = await runCommand("git", ["diff", "--stat"], undefined, undefined, context.cwd);
    const patch = await runCommand("git", ["diff"], undefined, undefined, context.cwd);
    return { diffStat: diff.stdout, diff: patch.stdout, branch: context.branch };
  });

  app.post("/api/tasks/:id/pr/create-or-update", async (request) => {
    requireUser(request);
    const { id } = idParams.parse(request.params);
    const body = prSchema.parse(request.body ?? {});
    const result = await createOrUpdatePr(pool, id, body.title, body.body);
    return { pullRequest: result };
  });

  return app;
}

const idParams = z.object({ id: z.string().uuid() });
const taskKeyParams = z.object({ key: z.string().min(1) });
const runEventsParams = z.object({
  kind: z.enum(["worker", "dispatcher"]),
  id: z.string().uuid()
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const onboardingSchema = loginSchema.extend({
  name: z.string().min(1),
  openaiApiKey: z.string().optional()
});
const codexProbeSchema = z.object({
  openaiApiKey: z.string().optional(),
  runLiveProbe: z.boolean().optional()
});
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
const agentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  instructions: z.string().min(1)
});
const agentPatchSchema = agentSchema.partial().extend({ enabled: z.boolean().optional() });
const taskSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  projectId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  openPrOnSuccess: z.boolean().optional()
});
const taskPatchSchema = taskSchema.partial().extend({
  status: z.string().optional()
});
const sessionMessageSchema = z.object({
  message: z.string().trim().min(1)
});
const agentToolCreateTaskSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional()
});
const agentToolPatchTaskSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  status: z.string().optional(),
  agentId: z.string().uuid().optional()
});
const agentToolCommentSchema = z.object({ body: z.string().min(1) });
const agentToolAssignSchema = z.object({
  agent: z.string().min(1),
  run: z.boolean().optional()
});
const githubManifestSchema = z.object({ name: z.string().optional() });
const githubCallbackSchema = z.object({
  name: z.string().min(1),
  appId: z.string().min(1),
  clientId: z.string().optional(),
  installationId: z.string().optional(),
  accountLogin: z.string().optional(),
  privateKey: z.string().optional(),
  webhookSecret: z.string().optional()
});
const githubPatSchema = z.object({
  name: z.string().min(1),
  token: z.string().min(10)
});
const repositoriesQuerySchema = z.object({ refresh: z.string().optional() });
const prSchema = z.object({ title: z.string().optional(), body: z.string().optional() });

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
  project_id: string;
  agent_id: string;
  agent_kind: "worker" | "dispatcher";
  source: "local_path" | "github";
  local_path: string;
  workspace_mode: "direct" | "git_worktree";
  default_branch: string | null;
  agent_name: string;
  agent_description: string;
  agent_model: string;
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

interface AgentToolContext {
  role: "worker" | "dispatcher";
  taskId: string | null;
  taskProjectId: string | null;
}

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

async function getUserFromCookie(pool: DbPool, request: FastifyRequest): Promise<AuthUser | undefined> {
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
      name: "Dispatcher",
      description: "Routes Todo and Needs attention tasks to the right worker agent.",
      instructions:
        "You are the Aisevak Dispatcher. Review the task board, assign work to enabled worker agents, start worker runs with the aisevak CLI, and move ambiguous or blocked work to Needs attention with a precise comment."
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
    const result = await pool.query(
      `INSERT INTO agents (kind, name, description, model, instructions, enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [agent.kind, agent.name, agent.description, env.codexDefaultModel, agent.instructions]
    );
    await insertAgentVersion(pool, mustRow(result.rows[0]), userId);
  }
}

async function insertAgentVersion(pool: DbPool, agent: Record<string, unknown>, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO agent_versions (agent_id, name, description, model, instructions, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [agent.id, agent.name, agent.description, agent.model, agent.instructions, userId]
  );
}

async function getTaskJoin(pool: DbPool, taskId: string): Promise<TaskJoin> {
  const taskResult = await pool.query<TaskJoin>(
    `SELECT tasks.*, projects.local_path, projects.workspace_mode, projects.source, projects.default_branch,
            agents.kind AS agent_kind,
            agents.name AS agent_name, agents.description AS agent_description,
            agents.model AS agent_model, agents.instructions AS agent_instructions
     FROM tasks
     JOIN projects ON projects.id = tasks.project_id
     JOIN agents ON agents.id = tasks.agent_id
     WHERE tasks.id = $1`,
    [taskId]
  );
  return mustRow(taskResult.rows[0]);
}

async function queueWorkerRun(
  pool: DbPool,
  taskId: string,
  trigger: "manual" | "agent_tool",
  options: { promptOverride?: string; allowQueuedFollowUp?: boolean } = {}
): Promise<Record<string, unknown>> {
  const task = await getTaskJoin(pool, taskId);
  if (task.agent_kind === "dispatcher") {
    throw new Error("Auto-route tasks must be dispatched before a worker run can start");
  }
  if (!options.allowQueuedFollowUp) {
    await ensureNoDirectProjectRun(pool, task.project_id, task.workspace_mode);
  }

  const branch = task.source === "github" ? taskBranchName(task.number, task.title) : null;
  const codexHome = managedCodexHome(env.managedRoot, task.id);
  await mkdir(codexHome, { recursive: true });
  const prompt =
    options.promptOverride ??
    buildCodexPrompt({
      agentName: task.agent_name,
      agentInstructions: task.agent_instructions,
      taskTitle: task.title,
      taskBody: task.body,
      projectPath: task.local_path,
      branch
    });
  const agentSnapshot = {
    name: task.agent_name,
    description: task.agent_description,
    model: task.agent_model,
    instructions: task.agent_instructions
  };
  const session = await upsertTaskSession(pool, task.id, codexHome, agentSnapshot);
  const runResult = await pool.query(
    `INSERT INTO task_runs (task_id, task_session_id, run_kind, trigger, status, cwd, branch, model, prompt)
     VALUES ($1, $2, 'worker', $3, 'queued', $4, $5, $6, $7)
     RETURNING *`,
    [task.id, session.id, trigger, task.local_path, branch, task.agent_model, prompt]
  );
  const run = mustRow(runResult.rows[0]);
  await insertRunUserMessage(pool, String(run.id), prompt);
  return run;
}

async function queueDispatcherMessage(
  pool: DbPool,
  options: { sourceRunId?: string; taskId?: string; prompt: string }
): Promise<Record<string, unknown>> {
  const existing = options.sourceRunId
    ? await pool.query<{
        task_id: string | null;
        scope: string;
        cwd: string;
        codex_home: string;
        codex_thread_id: string | null;
        model: string;
      }>(
        `SELECT task_id, scope, cwd, codex_home, codex_thread_id, model
         FROM dispatcher_runs
         WHERE id = $1`,
        [options.sourceRunId]
      )
    : options.taskId
      ? await pool.query<{
          task_id: string | null;
          scope: string;
          cwd: string;
          codex_home: string;
          codex_thread_id: string | null;
          model: string;
        }>(
          `SELECT task_id, scope, cwd, codex_home, codex_thread_id, model
           FROM dispatcher_runs
           WHERE task_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [options.taskId]
        )
      : { rows: [] };

  const previous = existing.rows[0];
  if (options.sourceRunId && !previous) {
    throw new Error("Dispatcher run was not found");
  }
  const dispatcher = previous ? null : await getDispatcherAgent(pool);
  const codexHome =
    previous?.codex_home ?? managedCodexHome(env.managedRoot, `dispatcher-${randomUUID()}`);
  await mkdir(codexHome, { recursive: true });
  const result = await pool.query(
    `INSERT INTO dispatcher_runs
       (task_id, trigger, scope, status, cwd, codex_home, codex_thread_id, model, prompt)
     VALUES ($1, 'manual', $2, 'queued', $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      previous?.task_id ?? options.taskId ?? null,
      previous?.scope ?? (options.taskId ? "task" : "heartbeat"),
      previous?.cwd ?? env.managedRoot,
      codexHome,
      previous?.codex_thread_id ?? null,
      previous?.model ?? dispatcher?.model,
      options.prompt
    ]
  );
  const run = mustRow(result.rows[0]);
  await insertDispatcherUserMessage(pool, String(run.id), options.prompt);
  return run;
}

async function queueDispatcherRun(
  pool: DbPool,
  options: { taskId?: string | null; trigger: "heartbeat" | "auto_route" }
): Promise<Record<string, unknown>> {
  const dispatcher = await getDispatcherAgent(pool);
  const context = await getDispatcherContext(pool);
  const targetTask = options.taskId ? context.tasks.find((task) => task.id === options.taskId) : null;
  const targetTaskNumber = typeof targetTask?.number === "number" ? targetTask.number : null;
  const codexHome = managedCodexHome(env.managedRoot, `dispatcher-${randomUUID()}`);
  await mkdir(codexHome, { recursive: true });
  const prompt = buildDispatcherPrompt({
    dispatcherInstructions: dispatcher.instructions,
    targetTaskNumber,
    tasksJson: JSON.stringify(context.tasks, null, 2),
    agentsJson: JSON.stringify(context.agents, null, 2),
    projectsJson: JSON.stringify(context.projects, null, 2)
  });
  const result = await pool.query(
    `INSERT INTO dispatcher_runs (task_id, trigger, scope, status, cwd, codex_home, model, prompt)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
     RETURNING *`,
    [
      options.taskId ?? null,
      options.trigger,
      options.taskId ? "task" : "heartbeat",
      env.managedRoot,
      codexHome,
      dispatcher.model,
      prompt
    ]
  );
  const run = mustRow(result.rows[0]);
  await insertDispatcherUserMessage(pool, String(run.id), prompt);
  return run;
}

async function getTaskSessionTimeline(pool: DbPool, taskId: string): Promise<{
  run: TimelineRunRow | null;
  events: TimelineEventRow[];
}> {
  const [runsResult, eventsResult] = await Promise.all([
    pool.query<TimelineRunRow>(
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
       JOIN projects ON projects.id = tasks.project_id
       JOIN agents ON agents.id = tasks.agent_id
       JOIN task_sessions ON task_sessions.id = task_runs.task_session_id
       WHERE task_runs.task_id = $1 AND task_runs.run_kind = 'worker'
       ORDER BY task_runs.queued_at ASC, task_runs.created_at ASC`,
      [taskId]
    ),
    pool.query<TimelineEventRow>(
      `SELECT run_events.*
       FROM run_events
       JOIN task_runs ON task_runs.id = run_events.run_id
       WHERE task_runs.task_id = $1 AND task_runs.run_kind = 'worker'
       ORDER BY task_runs.queued_at ASC, task_runs.created_at ASC, run_events.seq ASC`,
      [taskId]
    )
  ]);
  const runs = runsResult.rows;
  const latest = runs.at(-1) ?? null;
  const aggregateStatus =
    runs.find((run) => run.status === "running" || run.status === "cancel_requested")?.status ??
    runs.find((run) => run.status === "queued")?.status ??
    latest?.status ??
    "open";
  return {
    run: latest ? { ...latest, status: aggregateStatus, prompt: null } : null,
    events: withSyntheticUserMessages(runs, eventsResult.rows)
  };
}

async function insertRunUserMessage(pool: DbPool, runId: string, prompt: string): Promise<void> {
  await pool.query(
    `INSERT INTO run_events (run_id, seq, event_type, text, payload)
     VALUES ($1, -1, 'thread.message-sent', $2, $3)
     ON CONFLICT (run_id, seq) DO NOTHING`,
    [runId, prompt, { type: "thread.message-sent", role: "user", text: prompt }]
  );
}

async function insertDispatcherUserMessage(pool: DbPool, runId: string, prompt: string): Promise<void> {
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
  pool: DbPool,
  taskId: string,
  codexHome: string,
  agentSnapshot: Record<string, unknown>
): Promise<{ id: string; codex_thread_id: string | null }> {
  const result = await pool.query<{ id: string; codex_thread_id: string | null }>(
    `INSERT INTO task_sessions (task_id, codex_home, agent_snapshot)
     VALUES ($1, $2, $3)
     ON CONFLICT (task_id) DO UPDATE
       SET updated_at = now()
     RETURNING id, codex_thread_id`,
    [taskId, codexHome, agentSnapshot]
  );
  return mustRow(result.rows[0]);
}

async function ensureNoDirectProjectRun(
  pool: DbPool,
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

async function getDispatcherAgent(pool: DbPool): Promise<{
  id: string;
  model: string;
  instructions: string;
}> {
  const result = await pool.query<{ id: string; model: string; instructions: string }>(
    "SELECT id, model, instructions FROM agents WHERE kind = 'dispatcher' AND enabled = true ORDER BY created_at ASC LIMIT 1"
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
            CASE WHEN agents.kind = 'dispatcher' THEN 'Auto-route' ELSE agents.name END AS agent_name,
            agents.kind AS agent_kind,
            latest.status AS latest_worker_status,
            latest.id AS latest_worker_run_id
     FROM tasks
     JOIN projects ON projects.id = tasks.project_id
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

async function requireAgentTool(pool: DbPool, request: FastifyRequest): Promise<AgentToolContext> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (!token) {
    const error = new Error("Agent tool token required") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
  const result = await pool.query<{
    role: "worker" | "dispatcher";
    task_id: string | null;
    task_project_id: string | null;
  }>(
    `SELECT agent_tool_tokens.role,
            agent_tool_tokens.task_id,
            tasks.project_id AS task_project_id
     FROM agent_tool_tokens
     LEFT JOIN tasks ON tasks.id = agent_tool_tokens.task_id
     WHERE agent_tool_tokens.token_hash = $1
       AND agent_tool_tokens.expires_at > now()
     LIMIT 1`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row) {
    const error = new Error("Invalid agent tool token") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
  return { role: row.role, taskId: row.task_id, taskProjectId: row.task_project_id };
}

async function getFirstProjectId(pool: DbPool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM projects WHERE active = true ORDER BY created_at ASC LIMIT 1"
  );
  return mustRow(result.rows[0]).id;
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

async function readSecretById(pool: DbPool, id: string): Promise<string> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE id = $1",
    [id]
  );
  return decryptSecret(mustRow(result.rows[0]).encrypted_value, env.secretKey);
}

async function refreshPatRepositories(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string; pat_secret_id: string | null }>(
    "SELECT id, pat_secret_id FROM github_connections WHERE auth_mode = 'pat'"
  );
  for (const connection of result.rows) {
    if (!connection.pat_secret_id) continue;
    const token = await readSecretById(pool, connection.pat_secret_id);
    const response = await fetch(`${env.githubApiUrl}/user/repos?per_page=100&sort=updated`, {
      headers: githubHeaders(token)
    });
    if (!response.ok) {
      throw new Error(`GitHub repo refresh failed: ${response.status} ${await response.text()}`);
    }
    const repos = (await response.json()) as Array<Record<string, unknown>>;
    for (const repoPayload of repos) {
      const repo = normalizeGithubRepo(repoPayload);
      await pool.query(
        `INSERT INTO github_repositories
         (connection_id, owner, name, full_name, clone_url, default_branch)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connection_id, full_name) DO UPDATE
           SET clone_url = excluded.clone_url,
               default_branch = excluded.default_branch,
               updated_at = now()`,
        [connection.id, repo.owner, repo.name, repo.fullName, repo.cloneUrl, repo.defaultBranch]
      );
    }
  }

  const appConnections = await pool.query<{
    connection_id: string;
    app_id: string;
    private_key_secret_id: string;
    installation_pk: string;
    installation_id: string;
  }>(
    `SELECT github_connections.id AS connection_id,
            github_connections.app_id,
            github_connections.private_key_secret_id,
            github_installations.id AS installation_pk,
            github_installations.installation_id
     FROM github_connections
     JOIN github_installations ON github_installations.connection_id = github_connections.id
     WHERE github_connections.auth_mode = 'app'
       AND github_connections.app_id IS NOT NULL
       AND github_connections.private_key_secret_id IS NOT NULL`
  );
  for (const connection of appConnections.rows) {
    const privateKey = await readSecretById(pool, connection.private_key_secret_id);
    const token = await fetchGithubInstallationToken({
      apiUrl: env.githubApiUrl,
      appId: connection.app_id,
      privateKey,
      installationId: connection.installation_id
    });
    const response = await fetch(`${env.githubApiUrl}/installation/repositories?per_page=100`, {
      headers: githubHeaders(token)
    });
    if (!response.ok) {
      throw new Error(`GitHub App repo refresh failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { repositories?: Array<Record<string, unknown>> };
    for (const repoPayload of payload.repositories ?? []) {
      const repo = normalizeGithubRepo(repoPayload);
      await pool.query(
        `INSERT INTO github_repositories
         (connection_id, installation_id, owner, name, full_name, clone_url, default_branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (connection_id, full_name) DO UPDATE
           SET clone_url = excluded.clone_url,
               default_branch = excluded.default_branch,
               updated_at = now()`,
        [
          connection.connection_id,
          connection.installation_pk,
          repo.owner,
          repo.name,
          repo.fullName,
          repo.cloneUrl,
          repo.defaultBranch
        ]
      );
    }
  }
}

async function getPullRequestContext(pool: DbPool, taskId: string): Promise<{
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  cwd: string;
  branch: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  connectionId: string;
  authMode: "pat" | "app";
  patSecretId: string | null;
  appId: string | null;
  privateKeySecretId: string | null;
  installationValue: string | null;
}> {
  const result = await pool.query(
    `SELECT tasks.id AS task_id, tasks.number AS task_number, tasks.title AS task_title,
            projects.local_path, projects.github_owner, projects.github_repo, projects.default_branch,
            github_repositories.connection_id, github_connections.auth_mode,
            github_connections.pat_secret_id, github_connections.app_id, github_connections.private_key_secret_id,
            github_installations.installation_id AS installation_value,
            latest.cwd, latest.branch
     FROM tasks
     JOIN projects ON projects.id = tasks.project_id
     JOIN github_repositories ON github_repositories.id = projects.github_repository_id
     JOIN github_connections ON github_connections.id = github_repositories.connection_id
     LEFT JOIN github_installations ON github_installations.id = github_repositories.installation_id
     LEFT JOIN LATERAL (
       SELECT cwd, branch FROM task_runs WHERE task_runs.task_id = tasks.id ORDER BY created_at DESC LIMIT 1
     ) latest ON true
     WHERE tasks.id = $1 AND projects.source = 'github'`,
    [taskId]
  );
  const row = mustRow(result.rows[0] as Record<string, unknown> | undefined);
  return {
    taskId: String(row.task_id),
    taskNumber: Number(row.task_number),
    taskTitle: String(row.task_title),
    cwd: String(row.cwd ?? row.local_path),
    branch: String(row.branch ?? taskBranchName(Number(row.task_number), String(row.task_title))),
    owner: String(row.github_owner),
    repo: String(row.github_repo),
    defaultBranch: String(row.default_branch ?? "main"),
    connectionId: String(row.connection_id),
    authMode: row.auth_mode === "app" ? "app" : "pat",
    patSecretId: row.pat_secret_id ? String(row.pat_secret_id) : null,
    appId: row.app_id ? String(row.app_id) : null,
    privateKeySecretId: row.private_key_secret_id ? String(row.private_key_secret_id) : null,
    installationValue: row.installation_value ? String(row.installation_value) : null
  };
}

async function createOrUpdatePr(pool: DbPool, taskId: string, title?: string, body?: string): Promise<unknown> {
  const context = await getPullRequestContext(pool, taskId);
  const token = await tokenForPullRequest(pool, context);
  await runCommand("git", ["checkout", context.branch], undefined, undefined, context.cwd);
  const status = await runCommand("git", ["status", "--porcelain"], undefined, undefined, context.cwd);
  if (status.stdout.trim()) {
    await runCommand("git", ["config", "user.name", "Aisevak"], undefined, undefined, context.cwd);
    await runCommand("git", ["config", "user.email", "aisevak@localhost"], undefined, undefined, context.cwd);
    await runCommand("git", ["add", "-A"], undefined, undefined, context.cwd);
    await runCommand(
      "git",
      ["commit", "-m", title ?? context.taskTitle],
      undefined,
      undefined,
      context.cwd
    );
  }
  await runCommand(
    "git",
    ["push", "-u", "origin", context.branch],
    undefined,
    token,
    context.cwd,
    githubCloneEnv(token)
  );

  const existing = await pool.query("SELECT * FROM pull_requests WHERE task_id = $1 LIMIT 1", [taskId]);
  if (existing.rows[0]?.url) {
    return existing.rows[0];
  }

  const response = await fetch(`${env.githubApiUrl}/repos/${context.owner}/${context.repo}/pulls`, {
    method: "POST",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: title ?? context.taskTitle,
      body: body ?? `Created by Aisevak for task #${context.taskNumber}.`,
      head: context.branch,
      base: context.defaultBranch
    })
  });
  if (!response.ok) {
    const error = await response.text();
    await pool.query(
      `INSERT INTO pull_requests (task_id, project_id, branch, title, body, state, error)
       SELECT tasks.id, tasks.project_id, $2, $3, $4, 'failed', $5 FROM tasks WHERE tasks.id = $1`,
      [taskId, context.branch, title ?? context.taskTitle, body ?? "", error]
    );
    throw new Error(`GitHub PR creation failed: ${response.status} ${error}`);
  }
  const pr = (await response.json()) as Record<string, unknown>;
  const stored = await pool.query(
    `INSERT INTO pull_requests (task_id, project_id, branch, title, body, number, url, state)
     SELECT tasks.id, tasks.project_id, $2, $3, $4, $5, $6, $7 FROM tasks WHERE tasks.id = $1
     RETURNING *`,
    [
      taskId,
      context.branch,
      title ?? context.taskTitle,
      body ?? "",
      typeof pr.number === "number" ? pr.number : null,
      typeof pr.html_url === "string" ? pr.html_url : null,
      typeof pr.state === "string" ? pr.state : "open"
    ]
  );
  return stored.rows[0];
}

async function tokenForPullRequest(
  pool: DbPool,
  context: Awaited<ReturnType<typeof getPullRequestContext>>
): Promise<string> {
  if (context.authMode === "pat") {
    if (!context.patSecretId) throw new Error("PAT GitHub connection is missing a secret");
    return readSecretById(pool, context.patSecretId);
  }
  if (!context.appId || !context.privateKeySecretId || !context.installationValue) {
    throw new Error("GitHub App connection is missing app id, private key, or installation id");
  }
  const privateKey = await readSecretById(pool, context.privateKeySecretId);
  return fetchGithubInstallationToken({
    apiUrl: env.githubApiUrl,
    appId: context.appId,
    privateKey,
    installationId: context.installationValue
  });
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
  await app.listen({ host: env.apiHost, port: env.apiPort });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

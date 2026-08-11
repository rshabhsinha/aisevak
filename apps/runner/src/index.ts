import {
  buildCodexConfigToml,
  buildDispatcherPrompt,
  buildScheduledAgentPrompt,
  codexChatGptAuthSecrets,
  CODEX_CHATGPT_AUTH_SECRET_NAME,
  createPool,
  decryptSecret,
  encryptSecret,
  extractPromptSkillNames,
  extractThreadId,
  hashToken,
  managedCodexHome,
  managedGithubRepoPath,
  managedWorktreePath,
  newSessionToken,
  nextScheduleRunAt,
  normalizeCodexSkillSnapshots,
  normalizeCodexEvent,
  parseCodexChatGptAuthFile,
  parseCodexJsonLine,
  redactSecrets,
  resolveCodexBinary,
  serializeCodexChatGptAuthFile,
  runMigrations,
  serializeCodexSkillSnapshots,
  withTransaction,
  type CodexSkillSnapshot,
  type CodexChatGptAuthFile,
  type DbPool
} from "@aisevak/core";
import { agentToolScript } from "@aisevak/cli";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeAllCodexAppServers,
  runCodexAppServerTurn,
  type AppServerTurnInput
} from "./appServerClient.js";
import {
  agentGithubEnvironment,
  authenticateGithubCli,
  discoverGithubRepositories,
  githubAccountLogin,
  resetGithubCliStorage,
  runGitCommand,
  safeChildEnvironment
} from "./githubCli.js";
import { skillMarkdown } from "./skillMarkdown.js";

const env = {
  managedRoot: resolve(process.env.MANAGED_ROOT ?? "/srv/aisevak"),
  codexBinary: resolveCodexBinary(process.env.CODEX_BINARY),
  codexHostAuthJson: process.env.CODEX_HOST_AUTH_JSON ?? join(homedir(), ".codex", "auth.json"),
  databaseUrl: process.env.DATABASE_URL,
  pollMs: Number(process.env.RUNNER_POLL_MS ?? "1500"),
  dispatcherHeartbeatMs: Number(process.env.DISPATCHER_HEARTBEAT_MS ?? "300000"),
  apiUrl: process.env.API_URL ?? "http://localhost:8787",
  secretKey: process.env.SECRET_KEY ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  githubBinary: process.env.GITHUB_CLI ?? "gh",
  githubHost: process.env.GITHUB_HOST ?? "github.com"
};

let shuttingDown = false;

interface ImportJob {
  id: string;
  github_repository_id: string;
  local_path: string | null;
  owner: string;
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  connection_id: string;
}

interface GithubConnectionJob {
  id: string;
  status: "pending" | "sync_requested" | "disconnect_requested";
  pat_secret_id: string | null;
}

interface RunJob {
  id: string;
  task_id: string;
  task_session_id: string;
  agent_thread_id: string | null;
  prompt: string;
  model: string;
  model_options: Array<{ id: string; value: string | number | boolean }>;
  cwd: string;
  branch: string | null;
  codex_home: string;
  codex_thread_id: string | null;
  workspace_mode: "direct" | "git_worktree";
  project_source: "local_path" | "github";
  skills_snapshot: CodexSkillSnapshot[];
  agent_id: string;
  coordination_thread_id: string | null;
}

interface DispatcherJob {
  id: string;
  agent_thread_id: string | null;
  task_id: string | null;
  prompt: string;
  model: string;
  model_options: Array<{ id: string; value: string | number | boolean }>;
  cwd: string;
  codex_home: string;
  codex_thread_id: string | null;
  skills_snapshot: CodexSkillSnapshot[];
  scope: string;
  agent_id: string;
  agent_kind: "worker" | "dispatcher";
  agent_name: string;
  agent_description: string;
  agent_instructions: string;
  coordination_thread_id: string | null;
  message_delivery_id: string | null;
}

async function main(): Promise<void> {
  const pool = createPool(env.databaseUrl);
  await runMigrations(pool);
  await mkdir(env.managedRoot, { recursive: true });
  await recoverInterruptedGithubJobs(pool);

  const beginShutdown = () => {
    shuttingDown = true;
  };
  process.on("SIGINT", beginShutdown);
  process.on("SIGTERM", beginShutdown);

  console.log(`Aisevak runner started (Codex: ${env.codexBinary})`);
  while (!shuttingDown) {
    try {
      await processOneGithubConnection(pool);
      await processOneImportJob(pool);
      await enqueueDueSchedule(pool);
      await enqueueDispatcherHeartbeat(pool);
      await processOneDispatcherRun(pool);
      await processOneRunJob(pool);
    } catch (error) {
      console.error("runner loop error", error);
    }
    await sleep(env.pollMs);
  }
  await closeAllCodexAppServers();
  await pool.end();
}

async function recoverInterruptedGithubJobs(pool: DbPool): Promise<void> {
  await pool.query(
    `UPDATE github_connections
     SET status = CASE
           WHEN status = 'disconnecting' THEN 'disconnect_requested'
           WHEN pat_secret_id IS NOT NULL THEN 'pending'
           ELSE 'sync_requested'
         END,
         updated_at = now()
     WHERE auth_mode = 'pat' AND status IN ('syncing', 'disconnecting')`
  );
  await pool.query(
    `UPDATE repo_import_jobs
     SET status = 'queued', started_at = NULL, updated_at = now()
     WHERE status = 'running'`
  );
}

interface DueSchedule {
  id: string;
  title: string;
  prompt: string;
  agent_id: string;
  schedule_kind: "once" | "interval";
  next_run_at: Date;
  interval_seconds: number | null;
  model: string;
  model_options: Array<{ id: string; value: string | number | boolean }>;
}

async function enqueueDueSchedule(pool: DbPool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const dueResult = await client.query<DueSchedule>(
      `SELECT schedules.id,
              schedules.title,
              schedules.prompt,
              schedules.agent_id,
              schedules.schedule_kind,
              schedules.next_run_at,
              schedules.interval_seconds,
              agents.model,
              agents.model_options
       FROM schedules
       JOIN agents ON agents.id = schedules.agent_id
       WHERE schedules.enabled = true
         AND schedules.next_run_at <= now()
         AND agents.enabled = true
       ORDER BY schedules.next_run_at ASC, schedules.created_at ASC
       LIMIT 1
       FOR UPDATE OF schedules SKIP LOCKED`
    );
    const schedule = dueResult.rows[0];
    if (!schedule) return;

    const scheduledFor = schedule.next_run_at;
    const runtimeHome = managedCodexHome(
      env.managedRoot,
      `schedule-${schedule.id}-${randomUUID()}`
    );
    const skillNames = extractPromptSkillNames(schedule.prompt);
    const skillsSnapshot = await resolveAgentSkills(client, schedule.agent_id, skillNames);
    const threadResult = await client.query<{ id: string }>(
      `INSERT INTO agent_threads
         (title, agent_id, provider_instance_id, model, model_options, cwd, runtime_home)
       VALUES ($1, $2, 'codex-local', $3, $4, $5, $6)
       RETURNING id`,
      [
        schedule.title,
        schedule.agent_id,
        schedule.model,
        JSON.stringify(schedule.model_options ?? []),
        env.managedRoot,
        runtimeHome
      ]
    );
    const threadId = mustRow(threadResult.rows[0]).id;
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO dispatcher_runs
         (agent_thread_id, trigger, scope, status, cwd, codex_home, model, model_options, prompt, skills_snapshot)
       VALUES ($1, 'schedule', 'schedule', 'queued', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        threadId,
        env.managedRoot,
        runtimeHome,
        schedule.model,
        JSON.stringify(schedule.model_options ?? []),
        schedule.prompt,
        serializeCodexSkillSnapshots(skillsSnapshot)
      ]
    );
    const dispatcherRunId = mustRow(runResult.rows[0]).id;
    await client.query(
      `INSERT INTO dispatcher_run_events (dispatcher_run_id, seq, event_type, text, payload)
       VALUES ($1, -1, 'thread.message-sent', $2, $3)`,
      [
        dispatcherRunId,
        schedule.prompt,
        { type: "thread.message-sent", role: "user", text: schedule.prompt, scheduled: true }
      ]
    );
    await client.query(
      `INSERT INTO schedule_runs (schedule_id, agent_thread_id, dispatcher_run_id, scheduled_for)
       VALUES ($1, $2, $3, $4)`,
      [schedule.id, threadId, dispatcherRunId, scheduledFor]
    );

    const nextRunAt =
      schedule.schedule_kind === "interval" && schedule.interval_seconds
        ? nextScheduleRunAt(scheduledFor, schedule.interval_seconds)
        : scheduledFor;
    await client.query(
      `UPDATE schedules
       SET enabled = CASE WHEN schedule_kind = 'once' THEN false ELSE enabled END,
           next_run_at = $2,
           last_run_at = now(),
           last_agent_thread_id = $3,
           updated_at = now()
       WHERE id = $1`,
      [schedule.id, nextRunAt, threadId]
    );
  });
}

async function processOneGithubConnection(pool: DbPool): Promise<void> {
  const job = await withTransaction(pool, async (client) => {
    const result = await client.query<GithubConnectionJob>(
      `SELECT id, status, pat_secret_id
       FROM github_connections
       WHERE auth_mode = 'pat'
         AND status IN ('pending', 'sync_requested', 'disconnect_requested')
       ORDER BY updated_at DESC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    const selected = result.rows[0];
    if (!selected) return null;
    await client.query(
      `UPDATE github_connections
       SET status = $2, error = NULL, updated_at = now()
       WHERE id = $1`,
      [selected.id, selected.status === "disconnect_requested" ? "disconnecting" : "syncing"]
    );
    return selected;
  });
  if (!job) return;

  try {
    if (job.status === "disconnect_requested") {
      await resetGithubCliStorage(env.managedRoot);
      if (job.pat_secret_id) await pool.query("DELETE FROM secrets WHERE id = $1", [job.pat_secret_id]);
      await pool.query(
        `DELETE FROM github_repositories
         WHERE connection_id = $1 AND imported_project_id IS NULL`,
        [job.id]
      );
      await pool.query(
        `UPDATE github_connections
         SET status = 'disconnected', account_login = NULL, error = NULL,
             pat_secret_id = NULL, updated_at = now()
         WHERE id = $1`,
        [job.id]
      );
      return;
    }

    let accountLogin: string | null = null;
    if (job.status === "pending") {
      if (!job.pat_secret_id) throw new Error("Reconnect GitHub with an authentication token");
      const token = await readSecretById(pool, job.pat_secret_id);
      accountLogin = await authenticateGithubCli(token, {
        managedRoot: env.managedRoot,
        binary: env.githubBinary,
        hostname: env.githubHost
      });
      await pool.query("DELETE FROM secrets WHERE id = $1", [job.pat_secret_id]);
      await pool.query(
        `UPDATE projects SET workspace_mode = 'git_worktree', updated_at = now()
         WHERE source = 'github' AND workspace_mode = 'direct'`
      );
    } else {
      accountLogin = await githubAccountLogin({
        managedRoot: env.managedRoot,
        binary: env.githubBinary,
        hostname: env.githubHost
      });
    }

    await syncGithubRepositories(pool, job.id);
    await pool.query(
      `UPDATE github_connections
       SET status = 'ready',
           account_login = COALESCE($2, account_login),
           error = NULL,
           last_synced_at = now(),
           pat_secret_id = NULL,
           updated_at = now()
       WHERE id = $1`,
      [job.id, accountLogin]
    );
  } catch (error) {
    await pool.query(
      `UPDATE github_connections
       SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1`,
      [job.id, String(error instanceof Error ? error.message : error).slice(0, 2000)]
    );
  }
}

async function syncGithubRepositories(pool: DbPool, connectionId: string): Promise<void> {
  const repositories = await discoverGithubRepositories({
    managedRoot: env.managedRoot,
    binary: env.githubBinary,
    hostname: env.githubHost
  });
  await withTransaction(pool, async (client) => {
    for (const repo of repositories) {
      await client.query(
        `INSERT INTO github_repositories
           (connection_id, owner, name, full_name, clone_url, default_branch)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connection_id, full_name) DO UPDATE
         SET owner = excluded.owner,
             name = excluded.name,
             clone_url = excluded.clone_url,
             default_branch = excluded.default_branch,
             updated_at = now()`,
        [connectionId, repo.owner, repo.name, repo.fullName, repo.cloneUrl, repo.defaultBranch]
      );
    }
    await client.query(
      `DELETE FROM github_repositories
       WHERE connection_id = $1
         AND imported_project_id IS NULL
         AND NOT (full_name = ANY($2::text[]))`,
      [connectionId, repositories.map((repo) => repo.fullName)]
    );
  });
}

async function processOneImportJob(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE repo_import_jobs
     SET status = 'running', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM repo_import_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     ) AND status = 'queued'
     RETURNING id`
  );
  const job = result.rows[0];
  if (!job) return;

  try {
    const detail = await pool.query<ImportJob>(
      `SELECT repo_import_jobs.*,
              github_repositories.owner,
              github_repositories.name,
              github_repositories.full_name,
              github_repositories.clone_url,
              github_repositories.default_branch,
              github_repositories.connection_id
       FROM repo_import_jobs
       JOIN github_repositories ON github_repositories.id = repo_import_jobs.github_repository_id
       JOIN github_connections ON github_connections.id = github_repositories.connection_id
       WHERE repo_import_jobs.id = $1 AND github_connections.status = 'ready'`,
      [job.id]
    );
    const full = mustRow(detail.rows[0]);
    const localPath = full.local_path ?? managedGithubRepoPath(env.managedRoot, full.owner, full.name);
    await mkdir(dirname(localPath), { recursive: true });

    if (existsSync(join(localPath, ".git"))) {
      await git(["fetch", "--prune", "origin"], localPath);
      await git(["checkout", full.default_branch], localPath);
      await git(["pull", "--ff-only", "origin", full.default_branch], localPath);
    } else {
      await git(["clone", full.clone_url, localPath]);
    }

    const existingProject = await pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE github_repository_id = $1 LIMIT 1",
      [full.github_repository_id]
    );
    const projectId =
      existingProject.rows[0]?.id ??
      (
        await pool.query<{ id: string }>(
          `INSERT INTO projects
           (name, source, local_path, workspace_mode, github_owner, github_repo, default_branch, remote_url, github_repository_id)
           VALUES ($1, 'github', $2, 'git_worktree', $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            full.full_name,
            localPath,
            full.owner,
            full.name,
            full.default_branch,
            full.clone_url,
            full.github_repository_id
          ]
        )
      ).rows[0]?.id;
    if (!projectId) throw new Error("Could not create the imported GitHub project");
    await pool.query(
      `UPDATE projects
       SET name = $2, local_path = $3, workspace_mode = 'git_worktree',
           github_owner = $4, github_repo = $5, default_branch = $6,
           remote_url = $7, updated_at = now()
       WHERE id = $1`,
      [
        projectId,
        full.full_name,
        localPath,
        full.owner,
        full.name,
        full.default_branch,
        full.clone_url
      ]
    );

    await pool.query("UPDATE github_repositories SET imported_project_id = $1 WHERE id = $2", [
      projectId,
      full.github_repository_id
    ]);
    await pool.query(
      `UPDATE repo_import_jobs
       SET status = 'succeeded', local_path = $2, finished_at = now(), updated_at = now()
       WHERE id = $1`,
      [full.id, localPath]
    );
  } catch (error) {
    await pool.query(
      `UPDATE repo_import_jobs
       SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
       WHERE id = $1`,
      [job.id, String(error instanceof Error ? error.message : error)]
    );
  }
}

async function enqueueDispatcherHeartbeat(pool: DbPool): Promise<void> {
  if (env.dispatcherHeartbeatMs <= 0) return;
  const pending = await pool.query<{ count: string }>(
    "SELECT count(*) FROM dispatcher_runs WHERE status IN ('queued', 'running', 'cancel_requested')"
  );
  if (Number(pending.rows[0]?.count ?? 0) > 0) return;

  const due = await pool.query<{ last_run_at: Date | null }>(
    "SELECT max(created_at) AS last_run_at FROM dispatcher_runs WHERE scope = 'heartbeat'"
  );
  const lastRunAt = due.rows[0]?.last_run_at?.getTime() ?? 0;
  if (lastRunAt && Date.now() - lastRunAt < env.dispatcherHeartbeatMs) return;

  const actionable = await pool.query<{ count: string }>(
    `SELECT count(*)
     FROM tasks
     LEFT JOIN LATERAL (
       SELECT status FROM task_runs
       WHERE task_runs.task_id = tasks.id AND task_runs.run_kind = 'worker'
       ORDER BY created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE latest.status = 'failed'
        OR tasks.status IN ('needs_attention', 'blocked')
        OR (
          tasks.status = 'open'
          AND COALESCE(latest.status::text, '') NOT IN ('queued', 'running', 'cancel_requested', 'succeeded')
        )`
  );
  if (Number(actionable.rows[0]?.count ?? 0) === 0) return;

  const codexHome = managedCodexHome(env.managedRoot, "dispatcher-heartbeat");
  const dispatcher = await getDispatcherAgent(pool, codexHome);
  const context = await getDispatcherContext(pool);
  await mkdir(codexHome, { recursive: true });
  const skillsSnapshot = await resolveAgentSkills(pool, dispatcher.id);
  const prompt = buildDispatcherPrompt({
    dispatcherInstructions: dispatcher.instructions,
    tasksJson: JSON.stringify(context.tasks, null, 2),
    agentsJson: JSON.stringify(context.agents, null, 2),
    projectsJson: JSON.stringify(context.projects, null, 2),
    skills: skillsSnapshot.map((skill) => ({ name: skill.name, description: skill.description }))
  });
  await pool.query(
    `INSERT INTO dispatcher_runs
       (trigger, scope, status, cwd, codex_home, codex_thread_id, model, prompt, skills_snapshot)
     VALUES ('heartbeat', 'heartbeat', 'queued', $1, $2, $3, $4, $5, $6)`,
    [
      env.managedRoot,
      codexHome,
      dispatcher.threadId ?? null,
      dispatcher.model,
      prompt,
      serializeCodexSkillSnapshots(skillsSnapshot)
    ]
  );
}

async function processOneDispatcherRun(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE dispatcher_runs
     SET status = 'running', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT candidate.id
       FROM dispatcher_runs candidate
       WHERE candidate.status = 'queued'
         AND (
           candidate.message_delivery_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM message_deliveries delivery
             WHERE delivery.id = candidate.message_delivery_id
               AND delivery.available_at <= now()
           )
         )
         AND (
           candidate.scope <> 'coordination'
           OR NOT EXISTS (
             SELECT 1 FROM dispatcher_runs active
             WHERE active.agent_thread_id = candidate.agent_thread_id
               AND active.scope = 'coordination'
               AND active.status = 'running'
           )
         )
       ORDER BY candidate.queued_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`
  );
  const picked = result.rows[0];
  if (!picked) return;
  const detail = await pool.query<DispatcherJob>(
    `SELECT dispatcher_runs.id,
            dispatcher_runs.scope,
            dispatcher_runs.agent_thread_id,
            dispatcher_runs.message_delivery_id,
            dispatcher_runs.task_id,
            dispatcher_runs.prompt,
            dispatcher_runs.model,
            dispatcher_runs.model_options,
            dispatcher_runs.cwd,
            dispatcher_runs.codex_home,
            COALESCE(agent_threads.provider_thread_id, dispatcher_runs.codex_thread_id) AS codex_thread_id,
            dispatcher_runs.skills_snapshot,
            agents.id AS agent_id,
            agents.kind AS agent_kind,
            agents.name AS agent_name,
            agents.description AS agent_description,
            agents.instructions AS agent_instructions,
            agent_threads.coordination_thread_id
     FROM dispatcher_runs
     LEFT JOIN agent_threads ON agent_threads.id = dispatcher_runs.agent_thread_id
     LEFT JOIN agents ON agents.id = agent_threads.agent_id
     WHERE dispatcher_runs.id = $1`,
    [picked.id]
  );
  const job = mustRow(detail.rows[0]);
  if (job.message_delivery_id) {
    await pool.query(
      `UPDATE message_deliveries
       SET status = 'running', attempt_count = attempt_count + 1,
           presented_at = now(), updated_at = now()
       WHERE id = $1`,
      [job.message_delivery_id]
    );
  }

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let finalStatus: "succeeded" | "failed" | "cancelled" = "failed";

  try {
    await mkdir(job.codex_home, { recursive: true });
    await writeFile(join(job.codex_home, "config.toml"), buildCodexConfigToml(job.model), "utf8");
    await materializeSkills(job.codex_home, normalizeCodexSkillSnapshots(job.skills_snapshot));
    const codexAuth = await materializeCodexAuth(pool, job.codex_home);
    const credentialSecrets = await readAgentAccessibleSecrets(pool);
    const toolToken = await createAgentToolToken(pool, {
      role: job.agent_kind ?? "dispatcher",
      dispatcherRunId: job.id,
      taskId: job.task_id,
      agentId: job.agent_id,
      agentThreadId: job.agent_thread_id,
      coordinationThreadId: job.coordination_thread_id
    });
    const agentTool = await writeAgentTool(job.codex_home, toolToken);
    const turn = await runCodexAppServerTurn({
      codexBinary: env.codexBinary,
      cwd: job.cwd,
      codexHome: job.codex_home,
      model: job.model,
      modelOptions: job.model_options,
      prompt:
        job.scope === "schedule"
          ? buildScheduledAgentPrompt({
              agentName: job.agent_name,
              agentDescription: job.agent_description,
              agentInstructions: job.agent_instructions,
              prompt: job.prompt
            })
          : job.prompt,
      threadId: job.codex_thread_id,
      env: {
        ...codexProcessEnv(),
        CODEX_HOME: job.codex_home,
        HOME: job.codex_home,
        AISEVAK_API_URL: env.apiUrl,
        AISEVAK_AGENT_TOKEN_FILE: agentTool.tokenFile,
        AISEVAK_SKILLS_DIR: materializedSkillsRoot(job.codex_home),
        PATH: `${agentTool.binDir}:${process.env.PATH ?? ""}`,
        ...(codexAuth.apiKey
          ? { CODEX_API_KEY: codexAuth.apiKey, OPENAI_API_KEY: codexAuth.apiKey }
          : {})
      },
      secrets: [...codexAuth.redactionSecrets, toolToken, ...credentialSecrets],
      onLine: (line, seq) => persistDispatcherCodexLine(pool, job, line, seq),
      onThreadId: async (threadId) => {
        await pool.query(
          "UPDATE dispatcher_runs SET codex_thread_id = $2, updated_at = now() WHERE id = $1",
          [job.id, threadId]
        );
        if (job.agent_thread_id) {
          await pool.query(
            `UPDATE agent_threads
             SET provider_thread_id = $2, last_activity_at = now(), updated_at = now()
             WHERE id = $1`,
            [job.agent_thread_id, threadId]
          );
        }
      },
      shouldCancel: async () => {
        const current = await pool.query<{ status: string }>(
          "SELECT status FROM dispatcher_runs WHERE id = $1",
          [job.id]
        );
        return current.rows[0]?.status === "cancel_requested";
      },
      nextInput: () => claimAgentTurnInput(pool, "dispatcher", job.id),
      onInputHandled: (input, error) => finishAgentTurnInput(pool, input, error)
    });
    stdout = turn.rawStdout;
    stderr = turn.rawStderr;
    if (codexAuth.chatGptAuth && codexAuth.chatGptAuthRevision) {
      try {
        await persistRefreshedCodexAuth(
          pool,
          job.codex_home,
          codexAuth.chatGptAuth,
          codexAuth.chatGptAuthRevision
        );
      } catch (error) {
        stderr += `\nCould not persist refreshed ChatGPT authentication: ${String(
          error instanceof Error ? error.message : error
        )}`;
      }
    }
    exitCode = turn.exitCode;
    finalStatus =
      turn.status === "interrupted" ? "cancelled" : turn.status === "completed" ? "succeeded" : "failed";
    if (turn.error) stderr += `\n${turn.error}`;
  } catch (error) {
    stderr += `\n${String(error instanceof Error ? error.stack ?? error.message : error)}`;
    finalStatus = "failed";
  } finally {
    await pool.query(
      `UPDATE dispatcher_runs
       SET status = $2::run_status,
           raw_stdout = $3,
           raw_stderr = $4,
           exit_code = $5,
           finished_at = now(),
           updated_at = now(),
           error = CASE WHEN $2::run_status = 'failed' THEN NULLIF($4, '') ELSE NULL END
       WHERE id = $1`,
      [job.id, finalStatus, stdout, stderr, exitCode]
    );
    await failPendingAgentTurnInputs(pool, "dispatcher", job.id, finalStatus);
    if (job.agent_thread_id) {
      await pool.query(
        "UPDATE agent_threads SET last_activity_at = now(), updated_at = now() WHERE id = $1",
        [job.agent_thread_id]
      );
    }
    if (job.message_delivery_id) {
      await finishMessageDelivery(pool, job, finalStatus, stderr);
    }
  }
}

async function processOneRunJob(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE task_runs
     SET status = 'running', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT candidate.id
       FROM task_runs candidate
       JOIN tasks candidate_task ON candidate_task.id = candidate.task_id
       JOIN projects candidate_project ON candidate_project.id = candidate_task.project_id
       WHERE candidate.status = 'queued'
         AND candidate.run_kind = 'worker'
         AND (
           candidate_project.workspace_mode <> 'direct'
           OR NOT EXISTS (
             SELECT 1
             FROM task_runs active
             JOIN tasks active_task ON active_task.id = active.task_id
             WHERE active_task.project_id = candidate_task.project_id
               AND active.status = 'running'
           )
         )
       ORDER BY candidate.queued_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`
  );
  const picked = result.rows[0];
  if (!picked) return;
  const detail = await pool.query<RunJob>(
    `SELECT task_runs.id,
            task_runs.task_id,
            task_runs.task_session_id,
            task_runs.agent_thread_id,
            task_runs.prompt,
            task_runs.model,
            task_runs.model_options,
            task_runs.cwd,
            task_runs.branch,
            task_sessions.codex_home,
            COALESCE(agent_threads.provider_thread_id, task_sessions.codex_thread_id) AS codex_thread_id,
            projects.workspace_mode,
            projects.source AS project_source,
            task_runs.skills_snapshot,
            tasks.agent_id,
            agent_threads.coordination_thread_id
     FROM task_runs
     JOIN task_sessions ON task_sessions.id = task_runs.task_session_id
     LEFT JOIN agent_threads ON agent_threads.id = task_runs.agent_thread_id
     JOIN tasks ON tasks.id = task_runs.task_id
     JOIN projects ON projects.id = tasks.project_id
     WHERE task_runs.id = $1`,
    [picked.id]
  );
  const job = mustRow(detail.rows[0]);

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let finalStatus: "succeeded" | "failed" | "cancelled" = "failed";

  try {
    const cwd = await prepareWorkspace(pool, job);
    await pool.query("UPDATE task_runs SET cwd = $2, updated_at = now() WHERE id = $1", [
      job.id,
      cwd
    ]);
    await mkdir(job.codex_home, { recursive: true });
    await writeFile(join(job.codex_home, "config.toml"), buildCodexConfigToml(job.model), "utf8");
    await materializeSkills(job.codex_home, normalizeCodexSkillSnapshots(job.skills_snapshot));
    const codexAuth = await materializeCodexAuth(pool, job.codex_home);
    const credentialSecrets = await readAgentAccessibleSecrets(pool);
    const toolToken = await createAgentToolToken(pool, {
      role: "worker",
      taskRunId: job.id,
      taskId: job.task_id,
      agentId: job.agent_id,
      agentThreadId: job.agent_thread_id,
      coordinationThreadId: job.coordination_thread_id
    });
    const agentTool = await writeAgentTool(job.codex_home, toolToken);
    const turn = await runCodexAppServerTurn({
      codexBinary: env.codexBinary,
      cwd,
      codexHome: job.codex_home,
      model: job.model,
      modelOptions: job.model_options,
      prompt: job.prompt,
      threadId: job.codex_thread_id,
      env: {
        ...codexProcessEnv(),
        CODEX_HOME: job.codex_home,
        HOME: job.codex_home,
        AISEVAK_API_URL: env.apiUrl,
        AISEVAK_AGENT_TOKEN_FILE: agentTool.tokenFile,
        AISEVAK_SKILLS_DIR: materializedSkillsRoot(job.codex_home),
        PATH: `${agentTool.binDir}:${process.env.PATH ?? ""}`,
        ...(codexAuth.apiKey
          ? { CODEX_API_KEY: codexAuth.apiKey, OPENAI_API_KEY: codexAuth.apiKey }
          : {})
      },
      secrets: [...codexAuth.redactionSecrets, toolToken, ...credentialSecrets],
      onLine: (line, seq) => persistCodexLine(pool, job, line, seq),
      onThreadId: async (threadId) => {
        await pool.query(
          `UPDATE task_sessions SET codex_thread_id = $2, updated_at = now() WHERE id = $1`,
          [job.task_session_id, threadId]
        );
        await pool.query("UPDATE task_runs SET codex_thread_id = $2 WHERE id = $1", [job.id, threadId]);
        if (job.agent_thread_id) {
          await pool.query(
            `UPDATE agent_threads
             SET provider_thread_id = $2, last_activity_at = now(), updated_at = now()
             WHERE id = $1`,
            [job.agent_thread_id, threadId]
          );
        }
      },
      shouldCancel: async () => {
        const current = await pool.query<{ status: string }>(
          "SELECT status FROM task_runs WHERE id = $1",
          [job.id]
        );
        return current.rows[0]?.status === "cancel_requested";
      },
      nextInput: () => claimAgentTurnInput(pool, "worker", job.id),
      onInputHandled: (input, error) => finishAgentTurnInput(pool, input, error)
    });
    stdout = turn.rawStdout;
    stderr = turn.rawStderr;
    if (codexAuth.chatGptAuth && codexAuth.chatGptAuthRevision) {
      try {
        await persistRefreshedCodexAuth(
          pool,
          job.codex_home,
          codexAuth.chatGptAuth,
          codexAuth.chatGptAuthRevision
        );
      } catch (error) {
        stderr += `\nCould not persist refreshed ChatGPT authentication: ${String(
          error instanceof Error ? error.message : error
        )}`;
      }
    }
    exitCode = turn.exitCode;
    finalStatus =
      turn.status === "interrupted" ? "cancelled" : turn.status === "completed" ? "succeeded" : "failed";
    if (turn.error) stderr += `\n${turn.error}`;
  } catch (error) {
    stderr += `\n${String(error instanceof Error ? error.stack ?? error.message : error)}`;
    finalStatus = "failed";
  } finally {
    await finalizeWorkerRunState(pool, {
      runId: job.id,
      taskId: job.task_id,
      agentThreadId: job.agent_thread_id,
      coordinationThreadId: job.coordination_thread_id,
      finalStatus,
      stdout,
      stderr,
      exitCode
    });
    await failPendingAgentTurnInputs(pool, "worker", job.id, finalStatus);
  }
}

export async function finalizeWorkerRunState(
  pool: DbPool,
  input: {
    runId: string;
    taskId: string;
    agentThreadId: string | null;
    coordinationThreadId: string | null;
    finalStatus: "succeeded" | "failed" | "cancelled";
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }
): Promise<void> {
  const taskStatus = input.finalStatus === "succeeded" ? "completed" : "needs_attention";
  const threadStatus = input.finalStatus === "succeeded" ? "completed" : "blocked";
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE task_runs
       SET status = $2::run_status,
           raw_stdout = $3,
           raw_stderr = $4,
           exit_code = $5,
           finished_at = now(),
           updated_at = now(),
           error = CASE WHEN $2::run_status = 'failed' THEN NULLIF($4, '') ELSE NULL END
       WHERE id = $1`,
      [input.runId, input.finalStatus, input.stdout, input.stderr, input.exitCode]
    );
    await client.query(
      `UPDATE tasks
       SET status = $2,
           updated_at = now()
       WHERE id = $1
         AND status = 'open'`,
      [input.taskId, taskStatus]
    );
    if (input.coordinationThreadId) {
      await client.query(
        `UPDATE coordination_threads
         SET status = $2,
             last_activity_at = now(),
             updated_at = now()
         WHERE id = $1
           AND status = 'active'`,
        [input.coordinationThreadId, threadStatus]
      );
    }
    if (input.agentThreadId) {
      await client.query(
        "UPDATE agent_threads SET last_activity_at = now(), updated_at = now() WHERE id = $1",
        [input.agentThreadId]
      );
    }
  });
}

interface MaterializedCodexAuth {
  apiKey?: string;
  chatGptAuth?: CodexChatGptAuthFile;
  chatGptAuthRevision?: string;
  redactionSecrets: string[];
}

async function materializeCodexAuth(pool: DbPool, codexHome: string): Promise<MaterializedCodexAuth> {
  const authPath = join(codexHome, "auth.json");
  const storedChatGptAuth = await readSecretSnapshot(pool, CODEX_CHATGPT_AUTH_SECRET_NAME);
  if (storedChatGptAuth) {
    const auth = parseCodexChatGptAuthFile(storedChatGptAuth.value);
    await writeFile(authPath, serializeCodexChatGptAuthFile(auth), { encoding: "utf8", mode: 0o600 });
    await chmod(authPath, 0o600);
    return {
      chatGptAuth: auth,
      chatGptAuthRevision: storedChatGptAuth.encryptedValue,
      redactionSecrets: codexChatGptAuthSecrets(auth)
    };
  }

  const apiKey = await readSecret(pool, "openai_api_key");
  if (apiKey) {
    await rm(authPath, { force: true });
    return { apiKey, redactionSecrets: [apiKey] };
  }

  if (existsSync(env.codexHostAuthJson)) {
    await copyFile(env.codexHostAuthJson, authPath);
    await chmod(authPath, 0o600);
    return { redactionSecrets: authFileRedactionSecrets(await readFile(authPath, "utf8")) };
  }

  throw new Error(
    "Codex is not authenticated. An admin must connect ChatGPT from Manage > ChatGPT in Aisevak."
  );
}

export async function persistRefreshedCodexAuth(
  pool: DbPool,
  codexHome: string,
  original: CodexChatGptAuthFile,
  originalEncryptedValue: string
): Promise<boolean> {
  const refreshed = parseCodexChatGptAuthFile(await readFile(join(codexHome, "auth.json"), "utf8"));
  if (refreshed.tokens.account_id !== original.tokens.account_id) {
    throw new Error("Codex changed to a different ChatGPT account during the run");
  }
  const encrypted = encryptSecret(serializeCodexChatGptAuthFile(refreshed), env.secretKey);
  const result = await pool.query<{ id: string }>(
    `UPDATE secrets
     SET description = $2,
         encrypted_value = $3,
         agent_accessible = false,
         updated_at = now()
     WHERE name = $1 AND encrypted_value = $4
     RETURNING id`,
    [
      CODEX_CHATGPT_AUTH_SECRET_NAME,
      "Internal ChatGPT authentication used by the Codex runner",
      encrypted,
      originalEncryptedValue
    ]
  );
  return Boolean(result.rows[0]);
}

function codexProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...safeChildEnvironment(),
    ...agentGithubEnvironment(env.managedRoot)
  };
}

function authFileRedactionSecrets(value: string): string[] {
  try {
    return codexChatGptAuthSecrets(parseCodexChatGptAuthFile(value));
  } catch {
    try {
      const parsed = JSON.parse(value) as { OPENAI_API_KEY?: unknown };
      return typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0
        ? [parsed.OPENAI_API_KEY]
        : [];
    } catch {
      return [];
    }
  }
}

async function prepareWorkspace(pool: DbPool, job: RunJob): Promise<string> {
  if (job.project_source !== "github" || !job.branch) return job.cwd;

  if (job.workspace_mode === "git_worktree") {
    const worktreePath = managedWorktreePath(env.managedRoot, job.task_id, job.branch);
    await mkdir(dirname(worktreePath), { recursive: true });
    if (!existsSync(join(worktreePath, ".git"))) {
      await git(["fetch", "origin"], job.cwd);
      await git(["worktree", "add", "-B", job.branch, worktreePath, `origin/${await defaultBranch(job.cwd)}`], job.cwd);
    }
    await pool.query("UPDATE task_runs SET worktree_path = $2, branch = $3 WHERE id = $1", [
      job.id,
      worktreePath,
      job.branch
    ]);
    return worktreePath;
  }

  await git(["fetch", "origin"], job.cwd);
  const status = await git(["status", "--porcelain"], job.cwd);
  if (status.stdout.trim()) {
    throw new Error("Direct project working tree is dirty; commit, stash, or enable worktree mode");
  }
  const currentBranches = await git(["branch", "--list", job.branch], job.cwd);
  if (currentBranches.stdout.trim()) {
    await git(["checkout", job.branch], job.cwd);
  } else {
    await git(["checkout", "-B", job.branch, `origin/${await defaultBranch(job.cwd)}`], job.cwd);
  }
  return job.cwd;
}

export async function materializeSkills(codexHome: string, skills: CodexSkillSnapshot[] | null | undefined): Promise<void> {
  const skillsRoot = materializedSkillsRoot(codexHome);
  await rm(skillsRoot, { recursive: true, force: true });
  await mkdir(skillsRoot, { recursive: true });
  for (const skill of skills ?? []) {
    const skillDir = join(skillsRoot, safeSkillDirectoryName(skill.name));
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skillMarkdown(skill), "utf8");
    for (const [relativePath, content] of Object.entries(skill.files ?? {})) {
      const filePath = safeSkillFilePath(skillDir, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }
  }
}

export function materializedSkillsRoot(codexHome: string): string {
  return join(codexHome, ".agents", "skills");
}

function safeSkillDirectoryName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return name;
}

function safeSkillFilePath(skillDir: string, relativePath: string): string {
  const parts = relativePath.split("/");
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath === "SKILL.md" ||
    relativePath.endsWith("/SKILL.md") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid skill file path: ${relativePath}`);
  }
  return join(skillDir, ...parts);
}

async function persistCodexLine(pool: DbPool, job: RunJob, line: string, seq: number): Promise<void> {
  const raw = parseCodexJsonLine(line);
  if (!raw) return;
  const normalized = normalizeCodexEvent(raw);
  const threadId = extractThreadId(normalized);
  if (threadId) {
    await pool.query(
      `UPDATE task_sessions SET codex_thread_id = $2, updated_at = now() WHERE id = $1`,
      [job.task_session_id, threadId]
    );
    await pool.query("UPDATE task_runs SET codex_thread_id = $2 WHERE id = $1", [job.id, threadId]);
  }
  await pool.query(
    `INSERT INTO run_events (run_id, seq, event_type, text, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id, seq) DO NOTHING`,
    [job.id, seq, normalized.type, normalized.text ?? null, normalized]
  );
}

async function persistDispatcherCodexLine(
  pool: DbPool,
  job: DispatcherJob,
  line: string,
  seq: number
): Promise<void> {
  const raw = parseCodexJsonLine(line);
  if (!raw) return;
  const normalized = normalizeCodexEvent(raw);
  const threadId = extractThreadId(normalized);
  if (threadId) {
    await pool.query(
      "UPDATE dispatcher_runs SET codex_thread_id = $2, updated_at = now() WHERE id = $1",
      [job.id, threadId]
    );
  }
  await pool.query(
    `INSERT INTO dispatcher_run_events (dispatcher_run_id, seq, event_type, text, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dispatcher_run_id, seq) DO NOTHING`,
    [job.id, seq, normalized.type, normalized.text ?? null, normalized]
  );
}

export async function finishMessageDelivery(
  pool: DbPool,
  job: Pick<DispatcherJob, "id" | "message_delivery_id">,
  status: "succeeded" | "failed" | "cancelled",
  error: string
): Promise<void> {
  if (!job.message_delivery_id) return;
  if (status === "succeeded") {
    await pool.query(
      `UPDATE message_deliveries
       SET status = 'completed', completed_at = now(), error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [job.message_delivery_id]
    );
    return;
  }

  try {
    await withTransaction(pool, async (client) => {
      const result = await client.query<{
        status: string;
        attempt_count: number;
        presented_at: Date | null;
        provider_thread_id: string | null;
      }>(
        `SELECT delivery.status,
                delivery.attempt_count,
                delivery.presented_at,
                COALESCE(agent_threads.provider_thread_id, source_run.codex_thread_id) AS provider_thread_id
         FROM message_deliveries delivery
         LEFT JOIN dispatcher_runs source_run
           ON source_run.id = $2 AND source_run.message_delivery_id = delivery.id
         LEFT JOIN agent_threads ON agent_threads.id = source_run.agent_thread_id
         WHERE delivery.id = $1
         FOR UPDATE OF delivery`,
        [job.message_delivery_id, job.id]
      );
      const delivery = result.rows[0];
      if (!delivery || delivery.status !== "running") return;

      if (status !== "failed" || delivery.attempt_count >= 3) {
        await client.query(
          `UPDATE message_deliveries
           SET status = 'failed', completed_at = now(), error = NULLIF($2, ''), updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [job.message_delivery_id, error]
        );
        return;
      }

      if (delivery.presented_at && delivery.provider_thread_id) {
        await client.query(
          `UPDATE message_deliveries
           SET status = 'failed', completed_at = now(), error = $2, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [
            job.message_delivery_id,
            `Automatic delivery retry suppressed: the coordination message was already presented to an established provider thread.${error ? ` Original error: ${error}` : ""}`
          ]
        );
        return;
      }

      const retry = await client.query<{ id: string }>(
        `INSERT INTO dispatcher_runs
           (task_id, trigger, scope, agent_thread_id, message_delivery_id, status, cwd, codex_home,
            codex_thread_id, model, model_options, prompt, skills_snapshot)
         SELECT source_run.task_id, 'retry', source_run.scope, source_run.agent_thread_id,
                source_run.message_delivery_id, 'queued', source_run.cwd, source_run.codex_home,
                source_run.codex_thread_id, source_run.model, source_run.model_options,
                source_run.prompt, source_run.skills_snapshot
         FROM dispatcher_runs source_run
         WHERE source_run.id = $1
           AND source_run.message_delivery_id = $2
           AND NOT EXISTS (
             SELECT 1
             FROM dispatcher_runs overlapping_run
             WHERE overlapping_run.message_delivery_id = $2
               AND overlapping_run.id <> source_run.id
               AND overlapping_run.status IN ('queued', 'running', 'cancel_requested')
           )
         RETURNING id`,
        [job.id, job.message_delivery_id]
      );
      if (!retry.rows[0]) {
        await client.query(
          `UPDATE message_deliveries
           SET status = 'failed', completed_at = now(), error = $2, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [
            job.message_delivery_id,
            `Automatic delivery retry suppressed: the source run was unavailable or another run for this coordination message was already queued or active.${error ? ` Original error: ${error}` : ""}`
          ]
        );
        return;
      }

      await client.query(
        `UPDATE message_deliveries
         SET status = 'retrying', available_at = now() + ($2 * interval '5 seconds'),
             error = NULLIF($3, ''), updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [job.message_delivery_id, delivery.attempt_count, error]
      );
    });
  } catch (retryError) {
    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
    await pool.query(
      `UPDATE message_deliveries
       SET status = 'failed', completed_at = now(),
           error = $2, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [
        job.message_delivery_id,
        `Could not enqueue delivery retry: ${retryMessage}${error ? `. Original error: ${error}` : ""}`
      ]
    );
  }
}

async function createAgentToolToken(
  pool: DbPool,
  options: {
    role: "worker" | "dispatcher";
    taskRunId?: string;
    dispatcherRunId?: string;
    taskId?: string | null;
    agentId?: string | null;
    agentThreadId?: string | null;
    coordinationThreadId?: string | null;
  }
): Promise<string> {
  const token = newSessionToken();
  await pool.query(
    `INSERT INTO agent_tool_tokens
     (token_hash, task_run_id, dispatcher_run_id, task_id, agent_id, agent_thread_id,
      coordination_thread_id, role, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '24 hours')`,
    [
      hashToken(token),
      options.taskRunId ?? null,
      options.dispatcherRunId ?? null,
      options.taskId ?? null,
      options.agentId ?? null,
      options.agentThreadId ?? null,
      options.coordinationThreadId ?? null,
      options.role
    ]
  );
  return token;
}

async function writeAgentTool(
  codexHome: string,
  token: string
): Promise<{ binDir: string; tokenFile: string }> {
  const binDir = join(codexHome, "bin");
  await mkdir(binDir, { recursive: true });
  const toolPath = join(binDir, "aisevak");
  const tokenFile = join(codexHome, "agent-tool-token");
  await writeFile(toolPath, agentToolScript(), "utf8");
  await chmod(toolPath, 0o700);
  await writeFile(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenFile, 0o600);
  return { binDir, tokenFile };
}

async function claimAgentTurnInput(
  pool: DbPool,
  kind: "worker" | "dispatcher",
  runId: string
): Promise<AppServerTurnInput | null> {
  const runColumn = kind === "worker" ? "task_run_id" : "dispatcher_run_id";
  const result = await pool.query<AppServerTurnInput>(
    `UPDATE agent_turn_inputs
     SET status = 'delivering', updated_at = now()
     WHERE id = (
       SELECT id
       FROM agent_turn_inputs
       WHERE ${runColumn} = $1 AND status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, message`,
    [runId]
  );
  return result.rows[0] ?? null;
}

async function finishAgentTurnInput(
  pool: DbPool,
  input: AppServerTurnInput,
  error?: string
): Promise<void> {
  await pool.query(
    `UPDATE agent_turn_inputs
     SET status = $2,
         error = $3,
         delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
         updated_at = now()
     WHERE id = $1`,
    [input.id, error ? "failed" : "delivered", error ?? null]
  );
}

async function failPendingAgentTurnInputs(
  pool: DbPool,
  kind: "worker" | "dispatcher",
  runId: string,
  finalStatus: "succeeded" | "failed" | "cancelled"
): Promise<void> {
  const runColumn = kind === "worker" ? "task_run_id" : "dispatcher_run_id";
  await pool.query(
    `UPDATE agent_turn_inputs
     SET status = 'failed',
         error = $2,
         updated_at = now()
     WHERE ${runColumn} = $1 AND status IN ('queued', 'delivering')`,
    [
      runId,
      finalStatus === "cancelled"
        ? "The turn was stopped before this message could be delivered"
        : "The turn finished before this message could be delivered"
    ]
  );
}

export async function getDispatcherAgent(pool: DbPool, codexHome: string): Promise<{
  id: string;
  model: string;
  instructions: string;
  threadId: string | null;
}> {
  const result = await pool.query<{ id: string; model: string; instructions: string; thread_id: string | null }>(
    `SELECT agents.id,
            agents.model,
            agents.instructions,
            latest.codex_thread_id AS thread_id
     FROM agents
     LEFT JOIN LATERAL (
       SELECT codex_thread_id
       FROM dispatcher_runs
       WHERE scope = 'heartbeat'
         AND status = 'succeeded'
         AND codex_home = $1
         AND codex_thread_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE agents.kind = 'dispatcher' AND agents.enabled = true
     ORDER BY agents.created_at ASC
     LIMIT 1`,
    [codexHome]
  );
  const row = mustRow(result.rows[0]);
  return { id: row.id, model: row.model, instructions: row.instructions, threadId: row.thread_id };
}

type Queryable = Pick<DbPool, "query">;

async function resolveAgentSkills(
  pool: Queryable,
  agentId: string,
  promptSkillNames: string[] = []
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
       UNION ALL SELECT id, 'prompt' FROM skills WHERE name = ANY($2::text[])
     ) selected ON selected.skill_id = skills.id
     WHERE skills.enabled = true
     ORDER BY skills.name ASC`
    , [agentId, promptSkillNames]
  );
  const byId = new Map<string, CodexSkillSnapshot>();
  for (const row of result.rows) {
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

async function readSecret(pool: DbPool, name: string): Promise<string | undefined> {
  const snapshot = await readSecretSnapshot(pool, name);
  return snapshot?.value;
}

async function readSecretSnapshot(
  pool: DbPool,
  name: string
): Promise<{ value: string; encryptedValue: string } | undefined> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1",
    [name]
  );
  const row = result.rows[0];
  return row
    ? {
        value: decryptSecret(row.encrypted_value, env.secretKey),
        encryptedValue: row.encrypted_value
      }
    : undefined;
}

async function readAgentAccessibleSecrets(pool: DbPool): Promise<string[]> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE agent_accessible = true"
  );
  return result.rows.map((row) => decryptSecret(row.encrypted_value, env.secretKey));
}

async function readSecretById(pool: DbPool, id: string): Promise<string> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE id = $1",
    [id]
  );
  return decryptSecret(mustRow(result.rows[0]).encrypted_value, env.secretKey);
}

async function git(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return runGitCommand(args, cwd, { managedRoot: env.managedRoot });
}

async function defaultBranch(cwd: string): Promise<string> {
  const result = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  return result.stdout.trim().split("/").pop() || "main";
}

function mustRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Expected database row was not found");
  return row;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

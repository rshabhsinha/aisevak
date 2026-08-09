import {
  buildCodexConfigToml,
  buildDispatcherPrompt,
  codexChatGptAuthSecrets,
  CODEX_CHATGPT_AUTH_SECRET_NAME,
  createPool,
  decryptSecret,
  encryptSecret,
  extractThreadId,
  fetchGithubInstallationToken,
  githubCloneEnv,
  githubHeaders,
  hashToken,
  managedCodexHome,
  managedWorktreePath,
  newSessionToken,
  normalizeCodexSkillSnapshots,
  normalizeCodexEvent,
  parseCodexChatGptAuthFile,
  parseCodexJsonLine,
  redactSecrets,
  resolveCodexBinary,
  serializeCodexChatGptAuthFile,
  runMigrations,
  serializeCodexSkillSnapshots,
  type CodexSkillSnapshot,
  type CodexChatGptAuthFile,
  type DbPool
} from "@aisevak/core";
import { agentToolScript } from "@aisevak/cli";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexAppServerTurn } from "./appServerClient.js";
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
  githubApiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com"
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
  auth_mode: "pat" | "app";
  pat_secret_id: string | null;
  app_id: string | null;
  private_key_secret_id: string | null;
  installation_value: string | null;
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
  coordination_thread_id: string | null;
  message_delivery_id: string | null;
}

async function main(): Promise<void> {
  const pool = createPool(env.databaseUrl);
  await runMigrations(pool);
  await mkdir(env.managedRoot, { recursive: true });

  process.on("SIGINT", () => {
    shuttingDown = true;
  });
  process.on("SIGTERM", () => {
    shuttingDown = true;
  });

  console.log(`Aisevak runner started (Codex: ${env.codexBinary})`);
  while (!shuttingDown) {
    try {
      await processOneImportJob(pool);
      await enqueueDispatcherHeartbeat(pool);
      await processOneDispatcherRun(pool);
      await processOneRunJob(pool);
    } catch (error) {
      console.error("runner loop error", error);
    }
    await sleep(env.pollMs);
  }
  await pool.end();
}

async function processOneImportJob(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE repo_import_jobs
     SET status = 'running', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM repo_import_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
     )
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
              github_repositories.connection_id,
              github_connections.auth_mode,
              github_connections.pat_secret_id,
              github_connections.app_id,
              github_connections.private_key_secret_id,
              github_installations.installation_id AS installation_value
       FROM repo_import_jobs
       JOIN github_repositories ON github_repositories.id = repo_import_jobs.github_repository_id
       JOIN github_connections ON github_connections.id = github_repositories.connection_id
       LEFT JOIN github_installations ON github_installations.id = github_repositories.installation_id
       WHERE repo_import_jobs.id = $1`,
      [job.id]
    );
    const full = mustRow(detail.rows[0]);
    const token = await tokenForGithubRepo(pool, full);
    const localPath =
      full.local_path ?? join(env.managedRoot, "workspaces", "github", full.owner, full.name);
    await mkdir(dirname(localPath), { recursive: true });

    if (existsSync(join(localPath, ".git"))) {
      await git(["fetch", "--prune", "origin"], localPath, token);
      await git(["checkout", full.default_branch], localPath, token);
      await git(["pull", "--ff-only", "origin", full.default_branch], localPath, token);
    } else {
      await git(["clone", full.clone_url, localPath], undefined, token);
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
           VALUES ($1, 'github', $2, 'direct', $3, $4, $5, $6, $7)
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

  const dispatcher = await getDispatcherAgent(pool);
  const context = await getDispatcherContext(pool);
  const codexHome = managedCodexHome(env.managedRoot, "dispatcher-heartbeat");
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
    const toolBin = await writeAgentTool(job.codex_home);
    const turn = await runCodexAppServerTurn({
      codexBinary: env.codexBinary,
      cwd: job.cwd,
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
        AISEVAK_AGENT_TOKEN: toolToken,
        PATH: `${toolBin}:${process.env.PATH ?? ""}`,
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
      }
    });
    stdout = turn.rawStdout;
    stderr = turn.rawStderr;
    if (codexAuth.chatGptAuth) {
      try {
        await persistRefreshedCodexAuth(pool, job.codex_home, codexAuth.chatGptAuth);
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
    const toolBin = await writeAgentTool(job.codex_home);
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
        AISEVAK_AGENT_TOKEN: toolToken,
        PATH: `${toolBin}:${process.env.PATH ?? ""}`,
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
      }
    });
    stdout = turn.rawStdout;
    stderr = turn.rawStderr;
    if (codexAuth.chatGptAuth) {
      try {
        await persistRefreshedCodexAuth(pool, job.codex_home, codexAuth.chatGptAuth);
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
      `UPDATE task_runs
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
    if (job.agent_thread_id) {
      await pool.query(
        "UPDATE agent_threads SET last_activity_at = now(), updated_at = now() WHERE id = $1",
        [job.agent_thread_id]
      );
    }
    if (finalStatus === "succeeded") {
      await pool.query("UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = $1", [
        job.task_id
      ]);
    } else if (finalStatus === "failed" || finalStatus === "cancelled") {
      await pool.query("UPDATE tasks SET status = 'needs_attention', updated_at = now() WHERE id = $1", [
        job.task_id
      ]);
    }
  }
}

interface MaterializedCodexAuth {
  apiKey?: string;
  chatGptAuth?: CodexChatGptAuthFile;
  redactionSecrets: string[];
}

async function materializeCodexAuth(pool: DbPool, codexHome: string): Promise<MaterializedCodexAuth> {
  const authPath = join(codexHome, "auth.json");
  const storedChatGptAuth = await readSecret(pool, CODEX_CHATGPT_AUTH_SECRET_NAME);
  if (storedChatGptAuth) {
    const auth = parseCodexChatGptAuthFile(storedChatGptAuth);
    await writeFile(authPath, serializeCodexChatGptAuthFile(auth), { encoding: "utf8", mode: 0o600 });
    await chmod(authPath, 0o600);
    return { chatGptAuth: auth, redactionSecrets: codexChatGptAuthSecrets(auth) };
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

async function persistRefreshedCodexAuth(
  pool: DbPool,
  codexHome: string,
  original: CodexChatGptAuthFile
): Promise<void> {
  const refreshed = parseCodexChatGptAuthFile(await readFile(join(codexHome, "auth.json"), "utf8"));
  if (refreshed.tokens.account_id !== original.tokens.account_id) {
    throw new Error("Codex changed to a different ChatGPT account during the run");
  }
  const encrypted = encryptSecret(serializeCodexChatGptAuthFile(refreshed), env.secretKey);
  await pool.query(
    `INSERT INTO secrets (name, description, encrypted_value, agent_accessible)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (name) DO UPDATE
     SET description = excluded.description,
         encrypted_value = excluded.encrypted_value,
         agent_accessible = false,
         updated_at = now()`,
    [
      CODEX_CHATGPT_AUTH_SECRET_NAME,
      "Internal ChatGPT authentication used by the Codex runner",
      encrypted
    ]
  );
}

function codexProcessEnv(): NodeJS.ProcessEnv {
  const value = { ...process.env };
  delete value.CODEX_API_KEY;
  delete value.OPENAI_API_KEY;
  return value;
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
    await git(["checkout", "-B", job.branch], job.cwd);
  }
  return job.cwd;
}

async function materializeSkills(codexHome: string, skills: CodexSkillSnapshot[] | null | undefined): Promise<void> {
  const skillsRoot = join(codexHome, ".agents", "skills");
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

async function finishMessageDelivery(
  pool: DbPool,
  job: DispatcherJob,
  status: "succeeded" | "failed" | "cancelled",
  error: string
): Promise<void> {
  if (!job.message_delivery_id) return;
  if (status === "succeeded") {
    await pool.query(
      `UPDATE message_deliveries
       SET status = 'completed', completed_at = now(), error = NULL, updated_at = now()
       WHERE id = $1`,
      [job.message_delivery_id]
    );
    return;
  }

  const delivery = await pool.query<{ attempt_count: number }>(
    "SELECT attempt_count FROM message_deliveries WHERE id = $1",
    [job.message_delivery_id]
  );
  const attempts = delivery.rows[0]?.attempt_count ?? 3;
  if (status === "failed" && attempts < 3) {
    await pool.query(
      `UPDATE message_deliveries
       SET status = 'retrying', available_at = now() + ($2 * interval '5 seconds'),
           error = NULLIF($3, ''), updated_at = now()
       WHERE id = $1`,
      [job.message_delivery_id, attempts, error]
    );
    await pool.query(
      `INSERT INTO dispatcher_runs
         (task_id, trigger, scope, agent_thread_id, message_delivery_id, status, cwd, codex_home,
          codex_thread_id, model, model_options, prompt, skills_snapshot)
       SELECT task_id, 'retry', scope, agent_thread_id, message_delivery_id, 'queued', cwd, codex_home,
              codex_thread_id, model, model_options, prompt, skills_snapshot
       FROM dispatcher_runs WHERE id = $1`,
      [job.id]
    );
    return;
  }
  await pool.query(
    `UPDATE message_deliveries
     SET status = 'failed', completed_at = now(), error = NULLIF($2, ''), updated_at = now()
     WHERE id = $1`,
    [job.message_delivery_id, error]
  );
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

async function writeAgentTool(codexHome: string): Promise<string> {
  const binDir = join(codexHome, "bin");
  await mkdir(binDir, { recursive: true });
  const toolPath = join(binDir, "aisevak");
  await writeFile(toolPath, agentToolScript(), "utf8");
  await chmod(toolPath, 0o700);
  return binDir;
}

async function getDispatcherAgent(pool: DbPool): Promise<{
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
       WHERE codex_thread_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE agents.kind = 'dispatcher' AND agents.enabled = true
     ORDER BY agents.created_at ASC
     LIMIT 1`
  );
  const row = mustRow(result.rows[0]);
  return { id: row.id, model: row.model, instructions: row.instructions, threadId: row.thread_id };
}

async function resolveAgentSkills(pool: DbPool, agentId: string): Promise<CodexSkillSnapshot[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    description: string;
    instructions: string;
    files: unknown;
  }>(
    `SELECT skills.id,
            skills.name,
            skills.description,
            skills.instructions,
            skills.files
     FROM skills
     JOIN agent_skills ON agent_skills.skill_id = skills.id
     WHERE skills.enabled = true AND agent_skills.agent_id = $1
     ORDER BY skills.name ASC`
    , [agentId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    files: normalizeSkillFiles(row.files),
    sources: ["agent"]
  }));
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

async function tokenForGithubRepo(pool: DbPool, job: ImportJob): Promise<string> {
  if (job.auth_mode === "pat") {
    if (!job.pat_secret_id) throw new Error("PAT GitHub connection is missing a secret");
    return readSecretById(pool, job.pat_secret_id);
  }
  if (!job.app_id || !job.private_key_secret_id || !job.installation_value) {
    throw new Error("GitHub App connection is missing app id, private key, or installation id");
  }
  const privateKey = await readSecretById(pool, job.private_key_secret_id);
  return fetchGithubInstallationToken({
    apiUrl: env.githubApiUrl,
    appId: job.app_id,
    privateKey,
    installationId: job.installation_value
  });
}

async function readSecret(pool: DbPool, name: string): Promise<string | undefined> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1",
    [name]
  );
  const row = result.rows[0];
  return row ? decryptSecret(row.encrypted_value, env.secretKey) : undefined;
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

async function git(args: string[], cwd?: string, token?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: token ? githubCloneEnv(token) : process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += redactSecrets(String(chunk), [token]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += redactSecrets(String(chunk), [token]);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
      }
    });
  });
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

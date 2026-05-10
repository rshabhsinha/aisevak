import {
  buildCodexArgs,
  buildCodexConfigToml,
  buildDispatcherPrompt,
  createPool,
  decryptSecret,
  extractThreadId,
  fetchGithubInstallationToken,
  githubCloneEnv,
  githubHeaders,
  hashToken,
  managedWorktreePath,
  newSessionToken,
  normalizeCodexEvent,
  parseCodexJsonLine,
  redactSecrets,
  runMigrations,
  type DbPool
} from "@aisevak/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = {
  managedRoot: process.env.MANAGED_ROOT ?? "/srv/aisevak",
  codexBinary: process.env.CODEX_BINARY ?? "codex",
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
  prompt: string;
  model: string;
  cwd: string;
  branch: string | null;
  codex_home: string;
  codex_thread_id: string | null;
  workspace_mode: "direct" | "git_worktree";
  project_source: "local_path" | "github";
}

interface DispatcherJob {
  id: string;
  task_id: string | null;
  prompt: string;
  model: string;
  cwd: string;
  codex_home: string;
  codex_thread_id: string | null;
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

  console.log("Aisevak runner started");
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
  const codexHome = join(env.managedRoot, "codex-homes", `dispatcher-heartbeat`);
  await mkdir(codexHome, { recursive: true });
  const prompt = buildDispatcherPrompt({
    dispatcherInstructions: dispatcher.instructions,
    tasksJson: JSON.stringify(context.tasks, null, 2),
    agentsJson: JSON.stringify(context.agents, null, 2),
    projectsJson: JSON.stringify(context.projects, null, 2)
  });
  await pool.query(
    `INSERT INTO dispatcher_runs (trigger, scope, status, cwd, codex_home, codex_thread_id, model, prompt)
     VALUES ('heartbeat', 'heartbeat', 'queued', $1, $2, $3, $4, $5)`,
    [env.managedRoot, codexHome, dispatcher.threadId ?? null, dispatcher.model, prompt]
  );
}

async function processOneDispatcherRun(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE dispatcher_runs
     SET status = 'running', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM dispatcher_runs WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1
     )
     RETURNING id`
  );
  const picked = result.rows[0];
  if (!picked) return;
  const detail = await pool.query<DispatcherJob>(
    `SELECT id, task_id, prompt, model, cwd, codex_home, codex_thread_id
     FROM dispatcher_runs
     WHERE id = $1`,
    [picked.id]
  );
  const job = mustRow(detail.rows[0]);

  let child: ChildProcessWithoutNullStreams | undefined;
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let finalStatus: "succeeded" | "failed" | "cancelled" = "failed";

  try {
    await mkdir(job.codex_home, { recursive: true });
    await writeFile(join(job.codex_home, "config.toml"), buildCodexConfigToml(job.model), "utf8");
    const apiKey = await readSecret(pool, "openai_api_key");
    await ensureCodexAuth(job.codex_home, apiKey);
    const toolToken = await createAgentToolToken(pool, {
      role: "dispatcher",
      dispatcherRunId: job.id,
      taskId: job.task_id
    });
    const toolBin = await writeAgentTool(job.codex_home);
    const args = buildCodexArgs({ model: job.model, resumeThreadId: job.codex_thread_id });
    child = spawn(env.codexBinary, args, {
      cwd: job.cwd,
      env: {
        ...process.env,
        CODEX_HOME: job.codex_home,
        AISEVAK_API_URL: env.apiUrl,
        AISEVAK_AGENT_TOKEN: toolToken,
        PATH: `${toolBin}:${process.env.PATH ?? ""}`,
        ...(apiKey ? { CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let seq = 0;
    let stdoutBuffer = "";
    child.stdout.on("data", async (chunk) => {
      const text = redactSecrets(String(chunk), [apiKey, toolToken]);
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        await persistDispatcherCodexLine(pool, job, line, seq++);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += redactSecrets(String(chunk), [apiKey, toolToken]);
    });
    child.stdin.write(job.prompt);
    child.stdin.end();

    const cancellation = watchDispatcherCancellation(pool, job.id, () => {
      child?.kill("SIGTERM");
    });

    exitCode = await waitForClose(child);
    clearInterval(cancellation);
    if (stdoutBuffer.trim()) {
      await persistDispatcherCodexLine(pool, job, stdoutBuffer, seq++);
    }
    const current = await pool.query<{ status: string }>(
      "SELECT status FROM dispatcher_runs WHERE id = $1",
      [job.id]
    );
    finalStatus =
      current.rows[0]?.status === "cancel_requested"
        ? "cancelled"
        : exitCode === 0
          ? "succeeded"
          : "failed";
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
  }
}

async function processOneRunJob(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE task_runs
     SET status = 'running', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT id
       FROM task_runs
       WHERE status = 'queued' AND run_kind = 'worker'
       ORDER BY queued_at ASC
       LIMIT 1
     )
     RETURNING id`
  );
  const picked = result.rows[0];
  if (!picked) return;
  const detail = await pool.query<RunJob>(
    `SELECT task_runs.id,
            task_runs.task_id,
            task_runs.task_session_id,
            task_runs.prompt,
            task_runs.model,
            task_runs.cwd,
            task_runs.branch,
            task_sessions.codex_home,
            task_sessions.codex_thread_id,
            projects.workspace_mode,
            projects.source AS project_source
     FROM task_runs
     JOIN task_sessions ON task_sessions.id = task_runs.task_session_id
     JOIN tasks ON tasks.id = task_runs.task_id
     JOIN projects ON projects.id = tasks.project_id
     WHERE task_runs.id = $1`,
    [picked.id]
  );
  const job = mustRow(detail.rows[0]);

  let child: ChildProcessWithoutNullStreams | undefined;
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
    const apiKey = await readSecret(pool, "openai_api_key");
    await ensureCodexAuth(job.codex_home, apiKey);
    const toolToken = await createAgentToolToken(pool, {
      role: "worker",
      taskRunId: job.id,
      taskId: job.task_id
    });
    const toolBin = await writeAgentTool(job.codex_home);
    const args = buildCodexArgs({ model: job.model, resumeThreadId: job.codex_thread_id });
    child = spawn(env.codexBinary, args, {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: job.codex_home,
        AISEVAK_API_URL: env.apiUrl,
        AISEVAK_AGENT_TOKEN: toolToken,
        PATH: `${toolBin}:${process.env.PATH ?? ""}`,
        ...(apiKey ? { CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let seq = 0;
    let stdoutBuffer = "";
    child.stdout.on("data", async (chunk) => {
      const text = redactSecrets(String(chunk), [apiKey, toolToken]);
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        await persistCodexLine(pool, job, line, seq++);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += redactSecrets(String(chunk), [apiKey, toolToken]);
    });
    child.stdin.write(job.prompt);
    child.stdin.end();

    const cancellation = watchCancellation(pool, job.id, () => {
      child?.kill("SIGTERM");
    });

    exitCode = await waitForClose(child);
    clearInterval(cancellation);
    if (stdoutBuffer.trim()) {
      await persistCodexLine(pool, job, stdoutBuffer, seq++);
    }
    const current = await pool.query<{ status: string }>("SELECT status FROM task_runs WHERE id = $1", [
      job.id
    ]);
    finalStatus = current.rows[0]?.status === "cancel_requested" ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
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

async function ensureCodexAuth(codexHome: string, apiKey: string | undefined): Promise<void> {
  if (apiKey) return;
  if (!existsSync(env.codexHostAuthJson)) return;
  await copyFile(env.codexHostAuthJson, join(codexHome, "auth.json"));
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

function watchCancellation(pool: DbPool, runId: string, onCancel: () => void): NodeJS.Timeout {
  return setInterval(async () => {
    const result = await pool.query<{ status: string }>("SELECT status FROM task_runs WHERE id = $1", [
      runId
    ]);
    if (result.rows[0]?.status === "cancel_requested") {
      onCancel();
    }
  }, 1000);
}

function watchDispatcherCancellation(pool: DbPool, runId: string, onCancel: () => void): NodeJS.Timeout {
  return setInterval(async () => {
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM dispatcher_runs WHERE id = $1",
      [runId]
    );
    if (result.rows[0]?.status === "cancel_requested") {
      onCancel();
    }
  }, 1000);
}

async function createAgentToolToken(
  pool: DbPool,
  options: {
    role: "worker" | "dispatcher";
    taskRunId?: string;
    dispatcherRunId?: string;
    taskId?: string | null;
  }
): Promise<string> {
  const token = newSessionToken();
  await pool.query(
    `INSERT INTO agent_tool_tokens
     (token_hash, task_run_id, dispatcher_run_id, task_id, role, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')`,
    [
      hashToken(token),
      options.taskRunId ?? null,
      options.dispatcherRunId ?? null,
      options.taskId ?? null,
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

function agentToolScript(): string {
  return `#!/usr/bin/env node
const apiUrl = process.env.AISEVAK_API_URL || "http://localhost:8787";
const token = process.env.AISEVAK_AGENT_TOKEN;
if (!token) fail("AISEVAK_AGENT_TOKEN is missing");

const args = process.argv.slice(2);
main().catch((error) => fail(error && error.message ? error.message : String(error)));

async function main() {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") return help();
  if (args[0] === "context") return print(await request("/api/agent-tools/context"));
  if (args[0] !== "task") return fail("Unknown command. Run: aisevak help");
  const command = args[1];
  if (command === "create") {
    return print(await request("/api/agent-tools/tasks", {
      method: "POST",
      body: {
        title: option("--title", true),
        body: option("--body"),
        status: option("--status"),
        projectId: option("--project-id"),
        agentId: option("--agent-id")
      }
    }));
  }
  const key = args[2];
  if (!key) return fail("Task key is required, for example TASK-12");
  if (command === "comment") {
    return print(await request("/api/agent-tools/tasks/" + encodeURIComponent(key) + "/comment", {
      method: "POST",
      body: { body: restAfter(3) }
    }));
  }
  if (command === "attention") {
    const reason = restAfter(3);
    await request("/api/agent-tools/tasks/" + encodeURIComponent(key), {
      method: "PATCH",
      body: { status: "needs_attention" }
    });
    return print(await request("/api/agent-tools/tasks/" + encodeURIComponent(key) + "/comment", {
      method: "POST",
      body: { body: reason }
    }));
  }
  if (command === "complete") {
    const summary = option("--summary") || restAfter(3);
    await request("/api/agent-tools/tasks/" + encodeURIComponent(key), {
      method: "PATCH",
      body: { status: "completed" }
    });
    if (summary) {
      await request("/api/agent-tools/tasks/" + encodeURIComponent(key) + "/comment", {
        method: "POST",
        body: { body: summary }
      });
    }
    return print({ ok: true });
  }
  if (command === "update") {
    return print(await request("/api/agent-tools/tasks/" + encodeURIComponent(key), {
      method: "PATCH",
      body: {
        title: option("--title"),
        body: option("--body"),
        status: option("--status"),
        agentId: option("--agent-id")
      }
    }));
  }
  if (command === "assign") {
    return print(await request("/api/agent-tools/tasks/" + encodeURIComponent(key) + "/assign-run", {
      method: "POST",
      body: {
        agent: option("--agent", true),
        run: args.includes("--run")
      }
    }));
  }
  return fail("Unknown task command. Run: aisevak help");
}

async function request(path, options = {}) {
  const response = await fetch(apiUrl + path, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }
  if (!response.ok) throw new Error(typeof payload === "string" ? payload : JSON.stringify(payload));
  return payload;
}

function option(name, required = false) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && !value) fail(name + " is required");
  return value;
}

function restAfter(index) {
  return args.slice(index).join(" ").trim();
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function help() {
  console.log([
    "aisevak context",
    "aisevak task create --title <title> [--body <body>] [--status needs_attention]",
    "aisevak task assign TASK-1 --agent <agent-name> --run",
    "aisevak task attention TASK-1 <reason>",
    "aisevak task comment TASK-1 <note>",
    "aisevak task complete TASK-1 --summary <summary>",
    "aisevak task update TASK-1 [--status open|needs_attention|completed]"
  ].join("\\n"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
`;
}

async function getDispatcherAgent(pool: DbPool): Promise<{
  model: string;
  instructions: string;
  threadId: string | null;
}> {
  const result = await pool.query<{ model: string; instructions: string; thread_id: string | null }>(
    `SELECT agents.model,
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
  return { model: row.model, instructions: row.instructions, threadId: row.thread_id };
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

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    child.on("close", resolve);
  });
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

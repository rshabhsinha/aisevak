import { withTransaction, type DbPool } from "@aisevak/core";
import type { PoolClient } from "pg";
import { lstat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cachedCodexProcessIds, closeIdleCodexSession, setCodexThreadArchived } from "./appServerClient.js";
import { cachedAcpProcessIds, closeIdleAcpSession } from "./acpClient.js";
import { assertNoSymlinks, hasLiveWorktreeProcess, pathContains, removeCleanManagedWorktree } from "./worktreeCleanup.js";
interface Thread {id:string;task_id:string|null;runtime_home:string;provider_thread_id:string|null;driver:string;
  archived_at:Date|null;cleanup_state:string|null;provider_archived_at:Date|null}
interface Worktree {task_id:string;path:string;repo:string;branch:string}
const active = "status IN ('queued','running','cancel_requested')";
const cachedPids = (homes: string[]) => [...cachedCodexProcessIds(homes), ...cachedAcpProcessIds(homes)];
async function closeHome(home: string): Promise<void> {
  if (!await closeIdleCodexSession(home) || !await closeIdleAcpSession(home)) throw new Error("Provider session is still active");
}
async function cleanWorkspace(client: PoolClient, worktree: Worktree, root: string): Promise<void> {
  const owners = await client.query<{id:string;runtime_home:string}>(
    "SELECT id, runtime_home FROM agent_threads WHERE task_id = $1 ORDER BY id FOR UPDATE",[worktree.task_id]);
  const busy = await client.query(`SELECT 1 FROM (
    SELECT task_id, status, cwd, worktree_path FROM task_runs
    UNION ALL SELECT task_id, status, cwd, NULL::text FROM dispatcher_runs
    ) runs WHERE ${active} AND (task_id = $1 OR worktree_path = $2 OR cwd = $2 OR starts_with(cwd, $2 || '/')) LIMIT 1`,[worktree.task_id,worktree.path]);
  if (busy.rows[0]) throw new Error("Queued or active runs still own this worktree");
  const shared = await client.query(`SELECT id FROM agent_threads WHERE archived_at IS NULL
    AND (cwd = $1 OR starts_with(cwd, $1 || '/')) LIMIT 1`,[worktree.path]);
  if (shared.rows[0]) throw new Error("An unarchived chat shares this checkout");
  // Before closing a provider, check its descendants and other processes. The
  // idle app-server's own cwd is allowed; a detached terminal or open file isn't.
  const homes = new Set(owners.rows.map(owner=>owner.runtime_home));
  const legacy = await client.query<{codex_home:string}>("SELECT codex_home FROM task_sessions WHERE task_id = $1",[worktree.task_id]);
  for (const row of legacy.rows) homes.add(row.codex_home);
  if (await hasLiveWorktreeProcess(worktree.path,cachedPids([...homes]))) throw new Error("Worktree still has live processes");
  for (const home of homes) await closeHome(home);
  await removeCleanManagedWorktree({root,repo:worktree.repo,path:worktree.path,branch:worktree.branch});
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function homeInUseByOpenTask(client: PoolClient, home: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM task_sessions JOIN tasks ON tasks.id = task_sessions.task_id
    WHERE task_sessions.codex_home = $1 AND tasks.status NOT IN ('completed','cancelled') LIMIT 1`,[home]);
  return Boolean(result.rows[0]);
}

export async function sweepLifecycleCleanup(pool: DbPool, root: string, binary: string): Promise<void> {
  const cleanupEnabled = process.env.AISEVAK_AUTO_WORKTREE_CLEANUP !== "0";
  await pool.query("DELETE FROM agent_tool_tokens WHERE expires_at < now()");
  const pending = await pool.query<{id:string;task_id:string|null}>(`SELECT id, task_id FROM agent_threads
    WHERE cleanup_state IN ('pending','restoring','storage_disabled') AND ($1::boolean OR cleanup_state <> 'storage_disabled') AND (cleanup_attempt_at IS NULL OR cleanup_attempt_at < now() - interval '5 minutes')
    ORDER BY cleanup_attempt_at NULLS FIRST, updated_at LIMIT 25`,[cleanupEnabled]);
  for (const candidate of pending.rows) {
    await withTransaction(pool, async client => {
      // Cleanup holds its row locks across slow filesystem, git and provider work.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = 0");
      if (candidate.task_id) await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE",[candidate.task_id]);
      const locked = await client.query<Thread>(`SELECT agent_threads.*, provider_instances.driver FROM agent_threads
        JOIN provider_instances ON provider_instances.id = agent_threads.provider_instance_id
        WHERE agent_threads.id = $1 FOR UPDATE OF agent_threads SKIP LOCKED`,[candidate.id]);
      const thread = locked.rows[0];
      if (!thread || thread.task_id !== candidate.task_id || !['pending','restoring','storage_disabled'].includes(thread.cleanup_state ?? '')) return;
      await client.query("UPDATE agent_threads SET cleanup_attempt_at = now() WHERE id = $1",[thread.id]);
      try {
        const busy = await client.query(`SELECT 1 FROM (SELECT agent_thread_id,status FROM task_runs UNION ALL
          SELECT agent_thread_id,status FROM dispatcher_runs) runs WHERE agent_thread_id = $1 AND ${active} LIMIT 1`,[thread.id]);
        if (busy.rows[0]) throw new Error("Waiting for cancelled turns to stop");
        const shared = await client.query("SELECT id FROM agent_threads WHERE id <> $1 AND runtime_home = $2 AND archived_at IS NULL LIMIT 1",[thread.id,thread.runtime_home]);
        if (shared.rows[0]) throw new Error("Runtime home is shared with another chat");
        const home = resolve(thread.runtime_home), homesRoot=resolve(root,"codex-homes");
        if (home === homesRoot || !pathContains(homesRoot,home)) throw new Error("Runtime home is outside managed storage");
        try { await assertNoSymlinks(home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (await hasLiveWorktreeProcess(home,cachedPids([home]))) throw new Error("Runtime home still has live processes");
        await closeHome(home);
        // The Codex thread is archived in its provider only when the home is
        // kept (storage cleanup off). With cleanup on, the whole home is
        // deleted below, so archiving it first is pointless, and it needs a
        // working app-server in that home: it used to fail and retry forever.
        // A restore unarchives a thread whose home is still on disk.
        if (thread.driver === 'codex' && thread.provider_thread_id && await pathExists(home)) {
          const archive = Boolean(thread.archived_at) && !cleanupEnabled && !thread.provider_archived_at;
          const restore = thread.cleanup_state === 'restoring';
          if (archive || restore) {
            await setCodexThreadArchived({codexBinary:binary,codexHome:home,cwd:root,
              env:{...process.env,HOME:home,CODEX_HOME:home}},thread.provider_thread_id,archive);
            await client.query("UPDATE agent_threads SET provider_archived_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1",[thread.id,archive]);
          }
        }
        if (thread.archived_at && cleanupEnabled) {
          const worktrees = await client.query<Worktree>(`SELECT DISTINCT task_id,worktree_path AS path,cwd AS repo,branch
            FROM task_runs WHERE agent_thread_id = $1 AND workspace_mode = 'git_worktree' AND workspace_source = 'github'
              AND worktree_path IS NOT NULL AND branch IS NOT NULL`,[thread.id]);
          for (const worktree of worktrees.rows) {
            if (worktree.task_id !== thread.task_id) throw new Error("Historical checkout ownership changed; deferred to completed-task cleanup");
            await cleanWorkspace(client,worktree,root);
          }
          // Archiving clears the chat from its harness: the whole runtime home
          // (provider sessions, transcripts, caches) goes, unless an open
          // task's worker session still runs in it. A restored chat starts a
          // fresh provider session; its history stays in the database until
          // the archive is purged (retention.ts).
          if (await homeInUseByOpenTask(client, home)) throw new Error("An open task's worker session uses this runtime home");
          await rm(home,{recursive:true,force:true});
          await client.query("UPDATE agent_threads SET provider_thread_id = NULL, provider_archived_at = NULL WHERE id = $1",[thread.id]);
          // A task chat's session id is also kept on its task session; a restore would bring it back.
          await client.query("UPDATE task_sessions SET codex_thread_id = NULL, updated_at = now() WHERE codex_home = $1",[thread.runtime_home]);
        }
        await client.query("UPDATE agent_threads SET cleanup_state = CASE WHEN archived_at IS NULL THEN NULL WHEN $2::boolean THEN 'done' ELSE 'storage_disabled' END, cleanup_error = NULL WHERE id = $1",[thread.id,cleanupEnabled]);
      } catch (error) {
        await client.query("UPDATE agent_threads SET cleanup_error = $2 WHERE id = $1",[thread.id,error instanceof Error ? error.message : 'Cleanup deferred']);
      }
    });
  }
  if (!cleanupEnabled) return;
  const completed = await pool.query<Worktree>(`SELECT DISTINCT runs.task_id,runs.worktree_path AS path,runs.cwd AS repo,runs.branch
    FROM task_runs runs JOIN tasks ON tasks.id = runs.task_id
    LEFT JOIN worktree_cleanup_attempts attempt ON attempt.path = runs.worktree_path
    WHERE tasks.status IN ('completed','cancelled') AND runs.workspace_mode = 'git_worktree' AND runs.workspace_source = 'github'
      AND runs.worktree_path IS NOT NULL AND runs.branch IS NOT NULL
      AND (attempt.last_attempt_at IS NULL OR attempt.last_attempt_at < now() - interval '5 minutes')
      AND (attempt.cleaned_at IS NULL OR tasks.updated_at > attempt.cleaned_at OR runs.created_at > attempt.cleaned_at) LIMIT 5`);
  for (const worktree of completed.rows) {
    await withTransaction(pool, async client => {
      // Cleanup holds its row locks across slow filesystem, git and provider work.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = 0");
      const task = await client.query<{status:string}>("SELECT status FROM tasks WHERE id = $1 FOR UPDATE SKIP LOCKED",[worktree.task_id]);
      if (!task.rows[0] || !['completed','cancelled'].includes(task.rows[0].status)) return;
      let error: string|null = null;
      try { await cleanWorkspace(client,worktree,root); }
      catch (failure) { error = failure instanceof Error ? failure.message : 'Cleanup deferred'; }
      await client.query(`INSERT INTO worktree_cleanup_attempts(path,last_attempt_at,cleaned_at,error) VALUES($1,now(),CASE WHEN $2::text IS NULL THEN now() ELSE NULL END,$2)
        ON CONFLICT(path) DO UPDATE SET last_attempt_at = now(), cleaned_at = EXCLUDED.cleaned_at, error = EXCLUDED.error`,[worktree.path,error]);
    });
  }
}

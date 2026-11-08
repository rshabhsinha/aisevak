// Everything aisevak stores has a lifetime. Run output, messages and finished
// tasks expire after the retention window; chats nobody has used in that window
// are archived; an archived chat is cleared from its harness at once
// (lifecycleCleanup.ts) and deleted from the database after a short grace
// period, so an accidental archive can still be restored. Agent homes and
// scratch files nothing references are removed from disk.
//
// Deletes run in small batches under a time budget so a large backlog never
// holds long locks or one huge transaction; the next sweep continues it.

import type { DbPool } from "@aisevak/core";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathContains } from "./worktreeCleanup.js";

type Queryable = Pick<DbPool, "query">;

export interface RetentionPolicy {
  /** Runs, events, messages and finished tasks older than this are deleted; 0 disables retention. */
  retentionDays: number;
  /** An archived chat is deleted from the database this long after it was archived. */
  archivePurgeDays: number;
  /** Unreferenced agent homes and scratch entries untouched this long are removed. */
  scratchDays: number;
  /** Stop starting new batches after this long; the next sweep continues. */
  budgetMs: number;
  batchSize: number;
}

export function retentionPolicyFromEnv(environment: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    retentionDays: nonNegativeInteger(environment.AISEVAK_RETENTION_DAYS, 30),
    archivePurgeDays: nonNegativeInteger(environment.AISEVAK_ARCHIVE_PURGE_DAYS, 7),
    scratchDays: nonNegativeInteger(environment.AISEVAK_SCRATCH_RETENTION_DAYS, 7),
    budgetMs: 60_000,
    batchSize: 50
  };
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const TERMINAL_RUN = "status IN ('succeeded','failed','cancelled')";
const ACTIVE_RUN = "status IN ('queued','running','cancel_requested')";
const PENDING_DELIVERY = "status IN ('queued','retrying','running')";
/** A run that created a managed worktree not yet cleaned up: lifecycleCleanup finds the checkout through it. */
const UNCLEANED_WORKTREE = (run: string) => `${run}.workspace_mode = 'git_worktree' AND ${run}.workspace_source = 'github'
  AND ${run}.worktree_path IS NOT NULL AND ${run}.branch IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM worktree_cleanup_attempts attempt WHERE attempt.path = ${run}.worktree_path AND attempt.cleaned_at IS NOT NULL)`;

export interface RetentionResult {
  archivedThreads: number;
  purgedThreads: number;
  deleted: Record<string, number>;
  removedPaths: number;
  complete: boolean;
  /** Steps that failed this sweep; the others still ran. */
  errors: string[];
}

/** Rows one event-delete statement removes; a run can carry thousands of events. */
const EVENT_CHUNK = 5_000;
/** Runs whose events are cleared per batch. */
const RUN_CHUNK = 20;
/** Retention statements may legitimately take longer than an API request. */
const RETENTION_STATEMENT_TIMEOUT = "120s";

/** A task that is finished and that nothing (run, chat, schedule, checkout) has used in the window. */
const IDLE_FINISHED_TASK = (task: string) => `${task}.status IN ('completed','cancelled')
  AND ${task}.updated_at < now() - $1::interval
  AND NOT EXISTS (SELECT 1 FROM schedules WHERE schedules.task_id = ${task}.id AND schedules.enabled)
  AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.task_id = ${task}.id
                  AND (task_runs.${ACTIVE_RUN} OR task_runs.queued_at >= now() - $1::interval))
  AND NOT EXISTS (SELECT 1 FROM dispatcher_runs WHERE dispatcher_runs.task_id = ${task}.id
                  AND (dispatcher_runs.${ACTIVE_RUN} OR dispatcher_runs.queued_at >= now() - $1::interval))
  AND NOT EXISTS (SELECT 1 FROM agent_threads chat WHERE chat.task_id = ${task}.id
                  -- Archiving touches updated_at; it is not use of the chat.
                  AND (GREATEST(CASE WHEN chat.archived_at IS NULL THEN chat.updated_at ELSE chat.created_at END,
                                COALESCE(chat.last_activity_at, chat.created_at)) >= now() - $1::interval
                       OR EXISTS (SELECT 1 FROM dispatcher_runs WHERE dispatcher_runs.agent_thread_id = chat.id
                                  AND (dispatcher_runs.${ACTIVE_RUN} OR dispatcher_runs.queued_at >= now() - $1::interval))))
  AND NOT EXISTS (SELECT 1 FROM task_runs run WHERE run.task_id = ${task}.id AND ${UNCLEANED_WORKTREE("run")})`;

/** A task still being worked on: its chats, threads and messages are kept whatever their age. */
const OPEN_TASK = (task: string) => `${task}.status NOT IN ('completed','cancelled')`;

export async function sweepRetention(
  pool: DbPool,
  root: string,
  policy: RetentionPolicy = retentionPolicyFromEnv(),
  now: () => number = Date.now
): Promise<RetentionResult> {
  const result: RetentionResult = { archivedThreads: 0, purgedThreads: 0, deleted: {}, removedPaths: 0, complete: true, errors: [] };
  if (policy.retentionDays === 0) return result;
  const deadline = now() + policy.budgetMs;
  const inBudget = () => now() < deadline;
  const cutoff = `${policy.retentionDays} days`;
  const count = (name: string, rows: number) => {
    if (rows > 0) result.deleted[name] = (result.deleted[name] ?? 0) + rows;
  };
  // One step failing (a timeout, a lock) is logged and the others still run.
  const step = async (name: string, work: () => Promise<boolean | void>) => {
    if (!inBudget()) {
      result.complete = false;
      return;
    }
    try {
      if ((await work()) === false) result.complete = false;
    } catch (error) {
      result.complete = false;
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '${RETENTION_STATEMENT_TIMEOUT}'`);
    await step("archive idle chats", async () => {
      result.archivedThreads = await archiveInactiveThreads(client, cutoff, policy.batchSize);
    });
    await step("purge archived chats", async () => {
      const purge = await purgeArchivedThreads(client, root, `${policy.archivePurgeDays} days`, policy.batchSize, inBudget);
      result.purgedThreads = purge.purged;
      count("dispatcher_run_events", purge.events);
      return purge.complete;
    });
    for (const table of ["dispatcher_runs", "task_runs"] as const) {
      await step(`expire ${table}`, async () => {
        const expired = `SELECT run.id FROM ${table} run
          WHERE run.${TERMINAL_RUN} AND COALESCE(run.finished_at, run.updated_at) < now() - $1::interval
            ${table === "task_runs" ? `AND NOT (${UNCLEANED_WORKTREE("run")})` : ""}`;
        const removed = await deleteRunsInChunks(client, table, expired, [cutoff], inBudget);
        count(table, removed.runs);
        count(table === "task_runs" ? "run_events" : "dispatcher_run_events", removed.events);
        return removed.complete;
      });
    }
    const batches: { name: string; sql: string; size: number }[] = [
      {
        // Cascades to the task's chats, sessions, runs, comments and assignments.
        name: "tasks",
        size: 10,
        sql: `DELETE FROM tasks WHERE id IN (
                SELECT task.id FROM tasks task WHERE ${IDLE_FINISHED_TASK("task")}
                ORDER BY task.updated_at LIMIT $2 FOR UPDATE SKIP LOCKED)`
      },
      {
        // Cascades to deliveries. Kept: messages being delivered, open
        // requests, messages an open assignment points to, and the
        // conversation of a task still being worked on.
        name: "thread_messages",
        size: 500,
        sql: `DELETE FROM thread_messages WHERE id IN (
                SELECT message.id FROM thread_messages message
                WHERE message.created_at < now() - $1::interval
                  AND message.request_state IS DISTINCT FROM 'open'
                  AND NOT EXISTS (SELECT 1 FROM message_deliveries delivery
                                  WHERE delivery.message_id = message.id AND delivery.${PENDING_DELIVERY})
                  AND NOT EXISTS (SELECT 1 FROM task_assignments assignment
                                  WHERE assignment.status NOT IN ('completed','cancelled')
                                    AND message.id IN (assignment.request_message_id, assignment.last_message_id))
                  AND NOT EXISTS (SELECT 1 FROM coordination_threads thread JOIN tasks task ON task.id = thread.task_id
                                  WHERE thread.id = message.thread_id AND ${OPEN_TASK("task")})
                ORDER BY message.created_at LIMIT $2)`
      },
      {
        // Threads quiet for the window whose work is finished (or gone) and
        // that hold nothing still pending.
        name: "coordination_threads",
        size: 50,
        sql: `DELETE FROM coordination_threads WHERE id IN (
                SELECT thread.id FROM coordination_threads thread
                LEFT JOIN tasks task ON task.id = thread.task_id
                WHERE COALESCE(thread.last_activity_at, thread.updated_at) < now() - $1::interval
                  AND (task.id IS NULL OR NOT (${OPEN_TASK("task")}))
                  AND NOT EXISTS (SELECT 1 FROM thread_messages message
                                  WHERE message.thread_id = thread.id
                                    AND (message.request_state = 'open'
                                         OR EXISTS (SELECT 1 FROM message_deliveries delivery
                                                    WHERE delivery.message_id = message.id AND delivery.${PENDING_DELIVERY})))
                ORDER BY thread.last_activity_at NULLS FIRST LIMIT $2)`
      },
      {
        name: "usage_events",
        size: 5000,
        sql: `DELETE FROM usage_events WHERE event_id IN (
                SELECT event_id FROM usage_events WHERE created_at < now() - $1::interval LIMIT $2)`
      },
      {
        name: "schedule_runs",
        size: 1000,
        sql: `DELETE FROM schedule_runs WHERE id IN (
                SELECT id FROM schedule_runs WHERE created_at < now() - $1::interval LIMIT $2)`
      },
      {
        name: "job_safety_events",
        size: 1000,
        sql: `DELETE FROM job_safety_events WHERE id IN (
                SELECT id FROM job_safety_events WHERE created_at < now() - $1::interval LIMIT $2)`
      },
      {
        name: "worktree_cleanup_attempts",
        size: 1000,
        sql: `DELETE FROM worktree_cleanup_attempts WHERE path IN (
                SELECT attempt.path FROM worktree_cleanup_attempts attempt
                WHERE COALESCE(attempt.cleaned_at, attempt.last_attempt_at) < now() - $1::interval
                  AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.worktree_path = attempt.path)
                LIMIT $2)`
      }
    ];
    for (const batch of batches) {
      await step(`expire ${batch.name}`, async () => {
        for (;;) {
          if (!inBudget()) return false;
          const deleted = await client.query(batch.sql, [cutoff, batch.size]);
          count(batch.name, deleted.rowCount ?? 0);
          if ((deleted.rowCount ?? 0) < batch.size) return true;
        }
      });
    }
    await step("remove orphan homes", async () => {
      result.removedPaths += await removeOrphanHomes(client, root, policy.scratchDays, now);
    });
    await step("remove stale scratch", async () => {
      result.removedPaths += await removeStaleScratch(client, root, policy.scratchDays, now);
    });
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch (error) {
      client.release(true);
      throw error;
    }
    client.release();
  }
  return result;
}

/**
 * Delete runs a query selects: each chunk's events first, in row-bounded
 * statements, then the runs themselves (whose remaining children are small).
 * `selectRuns` must select `run.id` and may use the given parameters.
 */
async function deleteRunsInChunks(
  client: Queryable,
  table: "dispatcher_runs" | "task_runs",
  selectRuns: string,
  params: unknown[],
  inBudget: () => boolean
): Promise<{ runs: number; events: number; complete: boolean }> {
  const events = table === "dispatcher_runs" ? "dispatcher_run_events" : "run_events";
  const runColumn = table === "dispatcher_runs" ? "dispatcher_run_id" : "run_id";
  const ids = `$${params.length + 1}::uuid[]`;
  let runs = 0;
  let eventRows = 0;
  for (;;) {
    if (!inBudget()) return { runs, events: eventRows, complete: false };
    const chunk = await client.query<{ id: string }>(`${selectRuns} ORDER BY run.id LIMIT ${RUN_CHUNK}`, params);
    const runIds = chunk.rows.map((row) => row.id);
    if (runIds.length === 0) return { runs, events: eventRows, complete: true };
    for (;;) {
      const deleted = await client.query(
        `DELETE FROM ${events} WHERE id IN (SELECT id FROM ${events} WHERE ${runColumn} = ANY($1::uuid[]) LIMIT ${EVENT_CHUNK})`,
        [runIds]
      );
      eventRows += deleted.rowCount ?? 0;
      if ((deleted.rowCount ?? 0) < EVENT_CHUNK) break;
      if (!inBudget()) return { runs, events: eventRows, complete: false };
    }
    // Re-selected under the delete: a run that stopped qualifying is kept.
    const removed = await client.query(`DELETE FROM ${table} WHERE id IN (${selectRuns} AND run.id = ANY(${ids}))`, [...params, runIds]);
    runs += removed.rowCount ?? 0;
    // None removed: the chunk stopped qualifying; selecting it again would spin.
    if (runIds.length < RUN_CHUNK || !removed.rowCount) return { runs, events: eventRows, complete: true };
  }
}

/**
 * Archive chats with no run, delivery or activity in the retention window.
 * Only chats whose work is over: no task, or a finished one. A chat of a task
 * still being worked on, or one a schedule runs into, is never archived here.
 */
export async function archiveInactiveThreads(client: Queryable, window: string, limit: number): Promise<number> {
  const archived = await client.query(
    `UPDATE agent_threads thread
     SET archived_at = now(), cleanup_state = 'pending', cleanup_error = NULL, cleanup_attempt_at = NULL,
         ownership_generation = ownership_generation + 1, updated_at = now()
     WHERE thread.id IN (
       SELECT candidate.id FROM agent_threads candidate
       WHERE candidate.archived_at IS NULL AND candidate.cleanup_state IS NULL
         AND GREATEST(candidate.created_at, candidate.updated_at, COALESCE(candidate.last_activity_at, candidate.created_at)) < now() - $1::interval
         AND NOT EXISTS (SELECT 1 FROM tasks task WHERE task.id = candidate.task_id AND ${OPEN_TASK("task")})
         AND NOT EXISTS (SELECT 1 FROM coordination_threads coordination JOIN tasks task ON task.id = coordination.task_id
                         WHERE coordination.id = candidate.coordination_thread_id AND ${OPEN_TASK("task")})
         AND NOT EXISTS (SELECT 1 FROM dispatcher_runs WHERE dispatcher_runs.agent_thread_id = candidate.id
                         AND (dispatcher_runs.${ACTIVE_RUN} OR dispatcher_runs.queued_at >= now() - $1::interval))
         AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.agent_thread_id = candidate.id
                         AND (task_runs.${ACTIVE_RUN} OR task_runs.queued_at >= now() - $1::interval))
         AND NOT EXISTS (SELECT 1 FROM message_deliveries WHERE message_deliveries.agent_thread_id = candidate.id
                         AND message_deliveries.${PENDING_DELIVERY})
         AND NOT EXISTS (SELECT 1 FROM agent_turn_inputs WHERE agent_turn_inputs.agent_thread_id = candidate.id
                         AND agent_turn_inputs.status IN ('queued','delivering'))
         AND NOT EXISTS (SELECT 1 FROM schedules WHERE schedules.last_agent_thread_id = candidate.id AND schedules.enabled)
       ORDER BY candidate.updated_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )`,
    [window, limit]
  );
  return archived.rowCount ?? 0;
}

/**
 * Delete archived chats whose harness cleanup finished more than the grace
 * period ago: their runs (with events) first in chunks, then the chat. Every
 * chunk re-checks that the chat is still archived, so a restore during the
 * purge keeps whatever history is left.
 */
export async function purgeArchivedThreads(
  client: Queryable,
  root: string,
  grace: string,
  limit: number,
  inBudget: () => boolean
): Promise<{ purged: number; events: number; complete: boolean }> {
  const candidates = await client.query<{ id: string; runtime_home: string | null }>(
    `SELECT id, runtime_home FROM agent_threads
     WHERE archived_at < now() - $1::interval AND cleanup_state = 'done'
     ORDER BY archived_at
     LIMIT $2`,
    [grace, limit]
  );
  const stillPurgeable = `EXISTS (SELECT 1 FROM agent_threads purged WHERE purged.id = $1
    AND purged.archived_at < now() - $2::interval AND purged.cleanup_state = 'done')`;
  let purged = 0;
  let events = 0;
  for (const thread of candidates.rows) {
    if (!inBudget()) return { purged, events, complete: false };
    let complete = true;
    for (const table of ["dispatcher_runs", "task_runs"] as const) {
      const runs = `SELECT run.id FROM ${table} run WHERE run.agent_thread_id = $1 AND run.${TERMINAL_RUN} AND ${stillPurgeable}
        ${table === "task_runs" ? `AND NOT (${UNCLEANED_WORKTREE("run")})` : ""}`;
      const removed = await deleteRunsInChunks(client, table, runs, [thread.id, grace], inBudget);
      events += removed.events;
      complete &&= removed.complete;
    }
    if (!complete) return { purged, events, complete: false };
    const removed = await client.query(
      `DELETE FROM agent_threads thread
       WHERE thread.id = $1 AND thread.archived_at < now() - $2::interval AND thread.cleanup_state = 'done'
         AND NOT EXISTS (SELECT 1 FROM dispatcher_runs WHERE dispatcher_runs.agent_thread_id = thread.id)
         AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.agent_thread_id = thread.id)`,
      [thread.id, grace]
    );
    if (!removed.rowCount) continue;
    purged += 1;
    // Archive cleanup already removed the home; this catches one recreated since.
    if (thread.runtime_home) await removeUnreferencedHome(client, root, thread.runtime_home);
  }
  return { purged, events, complete: true };
}

async function removeUnreferencedHome(pool: Queryable, root: string, home: string): Promise<boolean> {
  const homesRoot = resolve(root, "codex-homes");
  const path = resolve(home);
  if (path === homesRoot || !pathContains(homesRoot, path)) return false;
  if (await homeIsReferenced(pool, path)) return false;
  await rm(path, { recursive: true, force: true });
  return true;
}

async function homeIsReferenced(pool: Queryable, home: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM agent_threads WHERE runtime_home = $1 AND (archived_at IS NULL OR cleanup_state IS DISTINCT FROM 'done')
     UNION ALL SELECT 1 FROM task_sessions WHERE codex_home = $1
     UNION ALL SELECT 1 FROM dispatcher_runs WHERE codex_home = $1 AND ${ACTIVE_RUN}
     LIMIT 1`,
    [home]
  );
  return Boolean(result.rows[0]);
}

/** Agent homes no chat, task session or live run uses, untouched for the scratch window. */
export async function removeOrphanHomes(pool: Queryable, root: string, days: number, now: () => number): Promise<number> {
  if (days === 0) return 0;
  const homesRoot = resolve(root, "codex-homes");
  // A home a run used inside the window is kept even when its directory's own
  // timestamp is old: providers write deep inside it (e.g. sessions/<date>/).
  const referenced = await pool.query<{ home: string }>(
    `SELECT runtime_home AS home FROM agent_threads
     WHERE runtime_home IS NOT NULL AND (archived_at IS NULL OR cleanup_state IS DISTINCT FROM 'done')
     UNION SELECT codex_home FROM task_sessions
     UNION SELECT codex_home FROM dispatcher_runs WHERE ${ACTIVE_RUN} OR created_at >= now() - $1::interval`,
    [`${days} days`]
  );
  const keep = new Set(referenced.rows.map((row) => resolve(row.home)));
  return removeStaleEntries(homesRoot, days, now, (path) => !keep.has(path));
}

/**
 * Agents' scratch space (root/tmp): logs, checkouts and notes they leave
 * behind. Entries untouched for the scratch window are removed, except one a
 * live run is working in.
 */
export async function removeStaleScratch(pool: Queryable, root: string, days: number, now: () => number): Promise<number> {
  const scratchRoot = resolve(root, "tmp");
  const active = await pool.query<{ cwd: string }>(
    `SELECT cwd FROM dispatcher_runs WHERE ${ACTIVE_RUN} UNION SELECT cwd FROM task_runs WHERE ${ACTIVE_RUN}`
  );
  const busy = active.rows.map((row) => resolve(row.cwd));
  return removeStaleEntries(scratchRoot, days, now, (path) => !busy.some((cwd) => cwd === path || pathContains(path, cwd)));
}

async function removeStaleEntries(
  directory: string,
  days: number,
  now: () => number,
  removable: (path: string) => boolean
): Promise<number> {
  if (days === 0) return 0;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const cutoff = now() - days * 86_400_000;
  let removed = 0;
  for (const name of names) {
    const path = join(directory, name);
    if (!removable(path)) continue;
    try {
      // lstat: a symlink's own age, and rm never follows it.
      if ((await newestChange(path, 2)) >= cutoff) continue;
      await forceRemove(path);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Retention could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return removed;
}

/**
 * The newest modification time of `path` and its entries down to `depth`
 * levels (lstat: symlinks are not followed). A directory's own timestamp only
 * changes when its direct entries do, so work deeper inside would look stale.
 */
async function newestChange(path: string, depth: number): Promise<number> {
  const stats = await lstat(path);
  let newest = stats.mtimeMs;
  if (depth === 0 || !stats.isDirectory()) return newest;
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return newest;
  }
  for (const name of names.slice(0, 2000)) {
    try {
      newest = Math.max(newest, await newestChange(join(path, name), depth - 1));
    } catch {
      // Removed while scanning, or unreadable: its parent's time stands.
    }
  }
  return newest;
}

/**
 * Remove a tree, including directories an agent left read-only (npm package
 * contents often are): on a permission error, make the tree's own directories
 * writable and try once more. Symlinks are never followed.
 */
async function forceRemove(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    await makeDirectoriesWritable(path);
    await rm(path, { recursive: true, force: true });
  }
}

async function makeDirectoriesWritable(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return;
  await chmod(path, (stats.mode & 0o777) | 0o700);
  for (const name of await readdir(path)) await makeDirectoriesWritable(join(path, name));
}

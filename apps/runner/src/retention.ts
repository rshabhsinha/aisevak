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
import { lstat, readdir, rm } from "node:fs/promises";
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
    batchSize: 100
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
}

export async function sweepRetention(
  pool: DbPool,
  root: string,
  policy: RetentionPolicy = retentionPolicyFromEnv(),
  now: () => number = Date.now
): Promise<RetentionResult> {
  const result: RetentionResult = { archivedThreads: 0, purgedThreads: 0, deleted: {}, removedPaths: 0, complete: true };
  if (policy.retentionDays === 0) return result;
  const deadline = now() + policy.budgetMs;
  const inBudget = () => now() < deadline;
  const days = (value: number) => `${value} days`;

  result.archivedThreads = await archiveInactiveThreads(pool, days(policy.retentionDays), policy.batchSize);
  result.purgedThreads = await purgeArchivedThreads(pool, root, days(policy.archivePurgeDays), policy.batchSize, inBudget);

  const cutoff = days(policy.retentionDays);
  const steps: { name: string; sql: string }[] = [
    {
      // Runs (and, by cascade, their events, inputs and tool tokens).
      name: "dispatcher_runs",
      sql: `DELETE FROM dispatcher_runs WHERE id IN (
              SELECT id FROM dispatcher_runs
              WHERE ${TERMINAL_RUN} AND COALESCE(finished_at, updated_at) < now() - $1::interval
              LIMIT $2)`
    },
    {
      name: "task_runs",
      sql: `DELETE FROM task_runs WHERE id IN (
              SELECT run.id FROM task_runs run
              WHERE run.${TERMINAL_RUN} AND COALESCE(run.finished_at, run.updated_at) < now() - $1::interval
                AND NOT (${UNCLEANED_WORKTREE("run")})
              LIMIT $2)`
    },
    {
      // Finished tasks cascade to their chats, sessions, runs and comments.
      // A task a schedule still runs into is kept.
      name: "tasks",
      sql: `DELETE FROM tasks WHERE id IN (
              SELECT tasks.id FROM tasks
              WHERE tasks.status IN ('completed','cancelled') AND tasks.updated_at < now() - $1::interval
                AND NOT EXISTS (SELECT 1 FROM schedules WHERE schedules.task_id = tasks.id AND schedules.enabled)
                AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.task_id = tasks.id AND task_runs.${ACTIVE_RUN})
                AND NOT EXISTS (SELECT 1 FROM dispatcher_runs WHERE dispatcher_runs.task_id = tasks.id AND dispatcher_runs.${ACTIVE_RUN})
                AND NOT EXISTS (SELECT 1 FROM task_runs run WHERE run.task_id = tasks.id AND ${UNCLEANED_WORKTREE("run")})
              LIMIT $2)`
    },
    {
      // Messages cascade to their deliveries; a message still being delivered stays.
      name: "thread_messages",
      sql: `DELETE FROM thread_messages WHERE id IN (
              SELECT message.id FROM thread_messages message
              WHERE message.created_at < now() - $1::interval
                AND NOT EXISTS (SELECT 1 FROM message_deliveries delivery
                                WHERE delivery.message_id = message.id AND delivery.${PENDING_DELIVERY})
              LIMIT $2)`
    },
    {
      // Threads quiet for the whole window whose work is finished (or gone).
      name: "coordination_threads",
      sql: `DELETE FROM coordination_threads WHERE id IN (
              SELECT thread.id FROM coordination_threads thread
              LEFT JOIN tasks ON tasks.id = thread.task_id
              WHERE COALESCE(thread.last_activity_at, thread.updated_at) < now() - $1::interval
                AND (thread.task_id IS NULL OR tasks.id IS NULL OR tasks.status IN ('completed','cancelled'))
                AND NOT EXISTS (SELECT 1 FROM thread_messages message
                                JOIN message_deliveries delivery ON delivery.message_id = message.id
                                WHERE message.thread_id = thread.id AND delivery.${PENDING_DELIVERY})
              LIMIT $2)`
    },
    {
      name: "schedule_runs",
      sql: `DELETE FROM schedule_runs WHERE id IN (
              SELECT id FROM schedule_runs WHERE created_at < now() - $1::interval LIMIT $2)`
    },
    {
      name: "job_safety_events",
      sql: `DELETE FROM job_safety_events WHERE id IN (
              SELECT id FROM job_safety_events WHERE created_at < now() - $1::interval LIMIT $2)`
    },
    {
      name: "worktree_cleanup_attempts",
      sql: `DELETE FROM worktree_cleanup_attempts WHERE path IN (
              SELECT attempt.path FROM worktree_cleanup_attempts attempt
              WHERE COALESCE(attempt.cleaned_at, attempt.last_attempt_at) < now() - $1::interval
                AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.worktree_path = attempt.path)
              LIMIT $2)`
    }
  ];
  for (const step of steps) {
    let total = 0;
    for (;;) {
      if (!inBudget()) {
        result.complete = false;
        break;
      }
      const deleted = await pool.query(step.sql, [cutoff, policy.batchSize]);
      total += deleted.rowCount ?? 0;
      if ((deleted.rowCount ?? 0) < policy.batchSize) break;
    }
    if (total > 0) result.deleted[step.name] = total;
    if (!result.complete) break;
  }

  if (result.complete && inBudget()) {
    result.removedPaths += await removeOrphanHomes(pool, root, policy.scratchDays, now);
    result.removedPaths += await removeStaleScratch(pool, root, policy.scratchDays, now);
  }
  return result;
}

/**
 * Archive chats with no run, delivery or activity in the retention window.
 * A chat a schedule runs into keeps running; the schedule is its activity.
 */
export async function archiveInactiveThreads(pool: Queryable, window: string, limit: number): Promise<number> {
  const archived = await pool.query(
    `UPDATE agent_threads thread
     SET archived_at = now(), cleanup_state = 'pending', cleanup_error = NULL, cleanup_attempt_at = NULL,
         ownership_generation = ownership_generation + 1, updated_at = now()
     WHERE thread.id IN (
       SELECT candidate.id FROM agent_threads candidate
       WHERE candidate.archived_at IS NULL AND candidate.cleanup_state IS NULL
         AND GREATEST(candidate.created_at, candidate.updated_at, COALESCE(candidate.last_activity_at, candidate.created_at)) < now() - $1::interval
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
 * period ago: their runs (with events) first in batches, then the chat.
 */
export async function purgeArchivedThreads(
  pool: DbPool,
  root: string,
  grace: string,
  limit: number,
  inBudget: () => boolean
): Promise<number> {
  const candidates = await pool.query<{ id: string; runtime_home: string | null }>(
    `SELECT id, runtime_home FROM agent_threads
     WHERE archived_at < now() - $1::interval AND cleanup_state = 'done'
     ORDER BY archived_at
     LIMIT $2`,
    [grace, limit]
  );
  let purged = 0;
  for (const thread of candidates.rows) {
    if (!inBudget()) break;
    for (const table of ["dispatcher_runs", "task_runs"]) {
      for (;;) {
        const deleted = await pool.query(
          `DELETE FROM ${table} WHERE id IN (
             SELECT run.id FROM ${table} run WHERE run.agent_thread_id = $1 AND run.${TERMINAL_RUN}
               ${table === "task_runs" ? `AND NOT (${UNCLEANED_WORKTREE("run")})` : ""}
             LIMIT 50)`,
          [thread.id]
        );
        if ((deleted.rowCount ?? 0) < 50 || !inBudget()) break;
      }
    }
    if (!inBudget()) break;
    // Re-checked under the delete: a restore or a new run since the select keeps the chat.
    const removed = await pool.query(
      `DELETE FROM agent_threads thread
       WHERE thread.id = $1 AND thread.archived_at < now() - $2::interval AND thread.cleanup_state = 'done'
         AND NOT EXISTS (SELECT 1 FROM dispatcher_runs WHERE dispatcher_runs.agent_thread_id = thread.id)
         AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.agent_thread_id = thread.id)`,
      [thread.id, grace]
    );
    if (!removed.rowCount) continue;
    purged += 1;
    // Archive cleanup already removed the home; this catches one recreated since.
    if (thread.runtime_home) await removeUnreferencedHome(pool, root, thread.runtime_home);
  }
  return purged;
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
      await rm(path, { recursive: true, force: true });
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

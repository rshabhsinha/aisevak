import { createRuntimeNormalizer, type DbPool, type RuntimeNormalizer } from "@aisevak/core";
import { currentRunnerId, RUN_LEASE_MS, trackActiveRun } from "./runLeases.js";

// A harness can start a model cycle on its own after a turn ended: Claude Code
// does when a background command it launched finishes ("You will be notified
// when it completes"). Those cycles used to run with nothing recording them,
// so the thread looked stuck at "running in the background" while the agent
// had in fact finished, and their tokens were missing from usage. Each such
// cycle is now recorded as a dispatcher run of scope 'background' on the same
// agent thread.
//
// The run is 'running' while the cycle lasts, leased to this runner (the lease
// heartbeat renews it) and so blocks new turns on the thread like any other
// run. Its scope keeps it out of coordination recovery and input injection; a
// runner restart fails it through the non-coordination recovery.

export const BACKGROUND_SCOPE = "background";
// The adapter reports a cycle's spend (usage_update) when its result arrives.
// The cycle normally ends there; a short wait catches a trailing message.
const END_AFTER_RESULT_MS = 5_000;
// Silence that ends a cycle whose result was never seen.
const END_AFTER_SILENCE_MS = 120_000;
// A cycle never stays open longer than this.
const MAX_CYCLE_MS = 60 * 60_000;

export interface BackgroundCycleSource {
  // The run whose turn just ended; the cycle copies its workspace and model.
  sourceRunId: string;
  driver: Parameters<typeof createRuntimeNormalizer>[0];
}

export type PersistBackgroundLine = (
  runId: string,
  line: string,
  seq: number,
  normalizer: RuntimeNormalizer
) => Promise<void>;

export interface BackgroundCycleTimings {
  endAfterResultMs?: number;
  endAfterSilenceMs?: number;
  maxCycleMs?: number;
}

export function createBackgroundCycleRecorder(
  pool: Pick<DbPool, "query">,
  source: BackgroundCycleSource,
  persist: PersistBackgroundLine,
  timings: BackgroundCycleTimings = {}
): (line: string) => Promise<void> {
  const endAfterResultMs = timings.endAfterResultMs ?? END_AFTER_RESULT_MS;
  const endAfterSilenceMs = timings.endAfterSilenceMs ?? END_AFTER_SILENCE_MS;
  const maxCycleMs = timings.maxCycleMs ?? MAX_CYCLE_MS;
  let chain: Promise<void> = Promise.resolve();
  let cycle: {
    runId: string | null; // null: the cycle could not be recorded; its lines are dropped
    seq: number;
    normalizer: RuntimeNormalizer;
    release: () => void;
    startedAt: number;
    timer: NodeJS.Timeout | null;
  } | null = null;

  const enqueue = (step: () => Promise<void>): Promise<void> => {
    chain = chain.then(step).catch((error: unknown) => {
      console.warn("Background cycle recording failed", {
        sourceRunId: source.sourceRunId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return chain;
  };

  const arm = (ms: number) => {
    if (!cycle) return;
    if (cycle.timer) clearTimeout(cycle.timer);
    const remaining = Math.max(0, maxCycleMs - (Date.now() - cycle.startedAt));
    cycle.timer = setTimeout(() => { void enqueue(end); }, Math.min(ms, remaining));
    cycle.timer.unref?.();
  };

  const end = async () => {
    const current = cycle;
    if (!current) return;
    cycle = null;
    if (current.timer) clearTimeout(current.timer);
    try {
      if (!current.runId) return;
      const finished = await pool.query<{ agent_thread_id: string | null }>(
        `UPDATE dispatcher_runs
         SET status = CASE WHEN status = 'cancel_requested' THEN 'cancelled'::run_status ELSE 'succeeded'::run_status END,
             finished_at = now(), updated_at = now()
         WHERE id = $1 AND status IN ('running', 'cancel_requested')
         RETURNING agent_thread_id`,
        [current.runId]
      );
      const threadId = finished.rows[0]?.agent_thread_id;
      if (threadId) {
        await pool.query("UPDATE agent_threads SET last_activity_at = now(), updated_at = now() WHERE id = $1", [threadId]);
      }
    } finally {
      current.release();
    }
  };

  const start = async () => {
    const opened = await pool.query<{ id: string; codex_thread_id: string | null }>(
      `INSERT INTO dispatcher_runs
         (task_id, trigger, scope, agent_thread_id, agent_thread_generation, workspace_key, workspace_mode, workspace_source,
          status, cwd, codex_home, codex_thread_id, model, model_options, prompt, skills_snapshot,
          started_at, launch_attempted_at, runner_id, lease_expires_at)
       SELECT source_run.task_id, 'background', $3, source_run.agent_thread_id, source_run.agent_thread_generation,
              source_run.workspace_key, source_run.workspace_mode, source_run.workspace_source,
              'running', source_run.cwd, source_run.codex_home, agent_threads.provider_thread_id,
              source_run.model, source_run.model_options, '', source_run.skills_snapshot,
              now(), now(), $2, now() + ($4::integer * interval '1 millisecond')
       FROM dispatcher_runs source_run
       JOIN agent_threads ON agent_threads.id = source_run.agent_thread_id
       WHERE source_run.id = $1
         AND agent_threads.ownership_generation = source_run.agent_thread_generation
         AND agent_threads.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM dispatcher_runs active
           WHERE active.agent_thread_id = source_run.agent_thread_id
             AND active.status IN ('running', 'cancel_requested')
             -- The turn that just ended may not be finalized yet.
             AND active.id <> source_run.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM task_runs active
           WHERE active.agent_thread_id = source_run.agent_thread_id
             AND active.status IN ('running', 'cancel_requested')
         )
       RETURNING id, codex_thread_id`,
      [source.sourceRunId, currentRunnerId(), BACKGROUND_SCOPE, RUN_LEASE_MS]
    );
    const row = opened.rows[0];
    cycle = {
      runId: row?.id ?? null,
      seq: 0,
      normalizer: createRuntimeNormalizer(source.driver, { sessionId: row?.codex_thread_id ?? null }),
      release: row ? trackActiveRun("dispatcher", row.id) : () => undefined,
      startedAt: Date.now(),
      timer: null
    };
  };

  return (line: string) => enqueue(async () => {
    if (!cycle) await start();
    const current = cycle;
    if (!current) return;
    arm(isCycleResult(line) ? endAfterResultMs : endAfterSilenceMs);
    if (!current.runId) return;
    current.seq += 1;
    await persist(current.runId, line, current.seq, current.normalizer);
  });
}

// The adapter sends usage_update with a cost only at a cycle's result;
// mid-cycle context readings carry no cost.
export function isCycleResult(line: string): boolean {
  try {
    const message = JSON.parse(line) as {
      method?: unknown;
      params?: { update?: { sessionUpdate?: unknown; cost?: unknown } };
    };
    const update = message.params?.update;
    return message.method === "session/update" && update?.sessionUpdate === "usage_update" &&
      typeof update.cost === "object" && update.cost !== null;
  } catch {
    return false;
  }
}

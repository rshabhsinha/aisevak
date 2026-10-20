import type { DbPool } from "@aisevak/core";
import { hostname } from "node:os";

// A claimed turn is leased to the runner that claimed it. The runner renews
// the lease while the process is alive; recovery only takes over a turn whose
// lease expired, so a second runner (or a slow restart) never fails a turn
// that is still running somewhere else.
export const RUN_LEASE_MS = 60_000;
export const RUN_HEARTBEAT_MS = 15_000;
// A sweep waits this long past expiry before taking over another runner's
// turn, so a brief database or network blip on that runner (which stops its
// heartbeat but not its provider turn) does not cause a takeover.
export const RUN_TAKEOVER_GRACE_MS = 120_000;

export type RunKind = "worker" | "dispatcher";

// The turns this process is actually executing. Only these leases are renewed:
// a row left 'running' by a job that died inside this process must expire and
// be recovered like any other.
const activeRuns: Record<RunKind, Set<string>> = { worker: new Set(), dispatcher: new Set() };

export function trackActiveRun(kind: RunKind, runId: string): () => void {
  activeRuns[kind].add(runId);
  return () => { activeRuns[kind].delete(runId); };
}

export function activeRunIds(kind: RunKind): string[] {
  return [...activeRuns[kind]];
}

// Stable across restarts on the same host, so a restarted runner recovers its
// own previous turns immediately instead of waiting for their leases.
export function currentRunnerId(): string {
  return process.env.AISEVAK_RUNNER_ID?.trim() || hostname();
}

// AISEVAK_COORDINATION_LEGACY=1 restores the pre-v2 behaviour for one release:
// every running turn is recovered at boot, interrupted deliveries fail and
// block their assignment, and ping turns finalize the task like any worker run.
export function legacyCoordination(): boolean {
  return process.env.AISEVAK_COORDINATION_LEGACY === "1";
}

export interface RecoveryScope {
  runnerId: string;
  // Boot also recovers turns of this runner's previous process and legacy
  // turns without a lease; a sweep only takes over other runners' expired turns.
  boot: boolean;
}

export function bootRecoveryScope(): RecoveryScope {
  return { runnerId: currentRunnerId(), boot: true };
}

// SQL predicate over a run table alias selecting the running turns this
// runner may recover. `param` is the placeholder bound to scope.runnerId.
export function recoverableRunPredicate(scope: RecoveryScope, alias: string, param: string): string {
  // The legacy forms still reference the parameter so callers bind the same values.
  if (legacyCoordination()) return scope.boot ? `(${param}::text IS NULL OR true)` : `(${param}::text IS NULL AND false)`;
  // Another runner's turn is only taken over past the grace period, at boot
  // as in sweeps; this runner's own previous turns are recovered at once.
  const othersExpired = `${alias}.lease_expires_at < now() - interval '${RUN_TAKEOVER_GRACE_MS} milliseconds'`;
  return scope.boot
    ? `(${alias}.runner_id IS NULL OR ${alias}.runner_id = ${param} OR ${othersExpired})`
    : `(${alias}.runner_id IS NOT NULL AND ${alias}.runner_id <> ${param} AND ${othersExpired})`;
}


export async function renewRunLeases(
  pool: Pick<DbPool, "query">,
  runnerId: string,
  leaseMs = RUN_LEASE_MS,
  runIds: Record<RunKind, string[]> = { worker: activeRunIds("worker"), dispatcher: activeRunIds("dispatcher") }
): Promise<void> {
  for (const [kind, table] of [["worker", "task_runs"], ["dispatcher", "dispatcher_runs"]] as const) {
    if (runIds[kind].length === 0) continue;
    await pool.query(
      `UPDATE ${table}
       SET lease_expires_at = now() + ($2::integer * interval '1 millisecond')
       WHERE id = ANY($3::uuid[]) AND runner_id = $1 AND status IN ('running', 'cancel_requested')`,
      [runnerId, leaseMs, runIds[kind]]
    );
  }
}

// True when another runner took this turn over (its lease lapsed and a sweep
// recovered it): the turn must stop and must not settle anything.
export function runTakenOver(row: { status: string; runner_id?: string | null } | undefined, runnerId: string): boolean {
  if (!row) return false;
  if (!["running", "cancel_requested"].includes(row.status)) return true;
  return Boolean(row.runner_id) && row.runner_id !== runnerId;
}

export function startRunLeaseHeartbeat(pool: Pick<DbPool, "query">, runnerId: string, intervalMs = RUN_HEARTBEAT_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    renewRunLeases(pool, runnerId)
      .catch((error) => console.error("Run lease heartbeat failed", error))
      .finally(() => { busy = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const INTERRUPTED_PREAMBLE =
  "Platform notice: your previous turn was interrupted by a platform restart while you were handling the message below. " +
  "Check what you already did (files, commits, aisevak state) before redoing anything, then continue. " +
  "Commands with idempotency keys are safe to repeat.";

export function withInterruptedPreamble(message: string): string {
  return message.startsWith(INTERRUPTED_PREAMBLE) ? message : `${INTERRUPTED_PREAMBLE}\n\n${message}`;
}

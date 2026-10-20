import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_PREAMBLE,
  recoverableRunPredicate,
  renewRunLeases,
  runTakenOver,
  trackActiveRun,
  withInterruptedPreamble
} from "./runLeases.js";

afterEach(() => { delete process.env.AISEVAK_COORDINATION_LEGACY; });

describe("turns ending during a runner stop", () => {
  it("leaves unsuccessful turns for boot recovery only while stopping", async () => {
    const { deferFinalizationForShutdown } = await import("./index.js");
    expect(deferFinalizationForShutdown(true, "failed")).toBe(true);
    // Our own cancellations (Stop, ownership changes) settle as usual.
    expect(deferFinalizationForShutdown(true, "cancelled")).toBe(false);
    expect(deferFinalizationForShutdown(true, "succeeded")).toBe(false);
    expect(deferFinalizationForShutdown(false, "failed")).toBe(false);
    process.env.AISEVAK_COORDINATION_LEGACY = "1";
    expect(deferFinalizationForShutdown(true, "failed")).toBe(false);
  });
});

describe("run leases", () => {
  it("lets a boot recover its own previous turns, unleased legacy turns, and other runners' leases past the grace period", () => {
    const sql = recoverableRunPredicate({ runnerId: "runner-a", boot: true }, "runs", "$1");
    expect(sql).toBe("(runs.runner_id IS NULL OR runs.runner_id = $1 OR runs.lease_expires_at < now() - interval '120000 milliseconds')");
  });

  it("lets a sweep take over only other runners' expired turns", () => {
    const sql = recoverableRunPredicate({ runnerId: "runner-a", boot: false }, "runs", "$2");
    expect(sql).toBe("(runs.runner_id IS NOT NULL AND runs.runner_id <> $2 AND runs.lease_expires_at < now() - interval '120000 milliseconds')");
  });

  it("recovers everything at boot and nothing in sweeps in legacy mode, still binding the parameter", () => {
    process.env.AISEVAK_COORDINATION_LEGACY = "1";
    expect(recoverableRunPredicate({ runnerId: "r", boot: true }, "runs", "$1")).toBe("($1::text IS NULL OR true)");
    expect(recoverableRunPredicate({ runnerId: "r", boot: false }, "runs", "$1")).toBe("($1::text IS NULL AND false)");
  });

  it("renews only the turns this process is executing", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = { async query(sql: string, params?: unknown[]) { queries.push({ sql, params }); return { rows: [] }; } } as unknown as DbPool;
    const release = trackActiveRun("dispatcher", "run-1");
    try {
      await renewRunLeases(pool, "runner-a", 60_000);
    } finally {
      release();
    }
    // No worker turn is active, so task_runs is not touched at all.
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("UPDATE dispatcher_runs");
    expect(queries[0]?.sql).toContain("WHERE id = ANY($3::uuid[]) AND runner_id = $1 AND status IN ('running', 'cancel_requested')");
    expect(queries[0]?.params).toEqual(["runner-a", 60_000, ["run-1"]]);
    queries.length = 0;
    await renewRunLeases(pool, "runner-a", 60_000);
    expect(queries).toHaveLength(0);
  });

  it("treats a run that left this runner as taken over", () => {
    expect(runTakenOver({ status: "running", runner_id: "runner-a" }, "runner-a")).toBe(false);
    expect(runTakenOver({ status: "cancel_requested", runner_id: "runner-a" }, "runner-a")).toBe(false);
    expect(runTakenOver({ status: "failed", runner_id: "runner-a" }, "runner-a")).toBe(true);
    expect(runTakenOver({ status: "running", runner_id: "runner-b" }, "runner-a")).toBe(true);
    expect(runTakenOver({ status: "running", runner_id: null }, "runner-a")).toBe(false);
  });

  it("adds the interrupted note once", () => {
    const once = withInterruptedPreamble("Review ASSIGNMENT-70.");
    expect(once.startsWith(INTERRUPTED_PREAMBLE)).toBe(true);
    expect(once.endsWith("Review ASSIGNMENT-70.")).toBe(true);
    expect(withInterruptedPreamble(once)).toBe(once);
  });
});

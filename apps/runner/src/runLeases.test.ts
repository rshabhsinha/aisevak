import type { DbPool } from "@aisevak/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_PREAMBLE,
  recoverableRunPredicate,
  renewRunLeases,
  withInterruptedPreamble
} from "./runLeases.js";

afterEach(() => { delete process.env.AISEVAK_COORDINATION_LEGACY; });

describe("run leases", () => {
  it("lets a boot recover its own previous turns, unleased legacy turns, and expired leases", () => {
    const sql = recoverableRunPredicate({ runnerId: "runner-a", boot: true }, "runs", "$1");
    expect(sql).toBe("(runs.runner_id IS NULL OR runs.runner_id = $1 OR runs.lease_expires_at < now())");
  });

  it("lets a sweep take over only other runners' expired turns", () => {
    const sql = recoverableRunPredicate({ runnerId: "runner-a", boot: false }, "runs", "$2");
    expect(sql).toBe("(runs.runner_id IS NOT NULL AND runs.runner_id <> $2 AND runs.lease_expires_at < now())");
  });

  it("recovers everything at boot and nothing in sweeps in legacy mode, still binding the parameter", () => {
    process.env.AISEVAK_COORDINATION_LEGACY = "1";
    expect(recoverableRunPredicate({ runnerId: "r", boot: true }, "runs", "$1")).toBe("($1::text IS NULL OR true)");
    expect(recoverableRunPredicate({ runnerId: "r", boot: false }, "runs", "$1")).toBe("($1::text IS NULL AND false)");
  });

  it("renews only this runner's active turns in both run tables", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = { async query(sql: string, params?: unknown[]) { queries.push({ sql, params }); return { rows: [] }; } } as unknown as DbPool;
    await renewRunLeases(pool, "runner-a", 60_000);
    expect(queries.map((query) => query.sql.match(/UPDATE (\w+)/)?.[1])).toEqual(["task_runs", "dispatcher_runs"]);
    for (const query of queries) {
      expect(query.sql).toContain("WHERE runner_id = $1 AND status IN ('running', 'cancel_requested')");
      expect(query.params).toEqual(["runner-a", 60_000]);
    }
  });

  it("adds the interrupted note once", () => {
    const once = withInterruptedPreamble("Review ASSIGNMENT-70.");
    expect(once.startsWith(INTERRUPTED_PREAMBLE)).toBe(true);
    expect(once.endsWith("Review ASSIGNMENT-70.")).toBe(true);
    expect(withInterruptedPreamble(once)).toBe(once);
  });
});

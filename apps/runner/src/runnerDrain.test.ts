import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { waitForRunJobsWithin } from "./index.js";

describe("runner shutdown drain", () => {
  it("reports a drain once every in-flight job settles", async () => {
    const jobs = new Set<Promise<void>>();
    const job = new Promise<void>((resolve) => setTimeout(resolve, 20));
    jobs.add(job);
    void job.finally(() => jobs.delete(job));

    await expect(waitForRunJobsWithin(jobs, 1_000)).resolves.toBe(true);
    expect(jobs.size).toBe(0);
  });

  it("stops waiting at the deadline and leaves jobs running", async () => {
    const jobs = new Set<Promise<void>>();
    let release!: () => void;
    const job = new Promise<void>((resolve) => { release = resolve; });
    jobs.add(job);

    const started = Date.now();
    await expect(waitForRunJobsWithin(jobs, 50)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(jobs.size).toBe(1);
    release();
  });

  it("gives systemd's stop timeout room for the drain and only signals the runner", async () => {
    const unit = await readFile(new URL("../aisevak-runner.service", import.meta.url), "utf8");
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain("ExecStart=/usr/bin/env node dist/index.js");
    expect(unit).toContain("WorkingDirectory=/opt/aisevak/current/apps/runner");
    const stopSeconds = Number(/TimeoutStopSec=(\d+)/.exec(unit)?.[1]);
    // Default RUNNER_DRAIN_TIMEOUT_MS (540s) plus time to record outcomes.
    expect(stopSeconds).toBeGreaterThanOrEqual(540 + 30);
  });
});

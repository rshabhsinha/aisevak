import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneHeartbeatRollouts } from "./heartbeatRollouts.js";

const DAY = 24 * 60 * 60 * 1000;
let home: string | undefined;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function file(path: string, ageMs: number, now: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "{}\n");
  const time = new Date(now - ageMs);
  await utimes(path, time, time);
}

describe("heartbeat rollout retention", () => {
  it("removes rollouts past retention and their emptied day folders, keeping recent ones and other files", async () => {
    home = await mkdtemp(join(tmpdir(), "heartbeat-rollouts-"));
    const now = Date.now();
    const oldDay = join(home, "sessions", "2026", "10", "10");
    const newDay = join(home, "sessions", "2026", "10", "20");
    await file(join(oldDay, "rollout-old.jsonl"), 10 * DAY, now);
    await file(join(newDay, "rollout-new.jsonl"), DAY, now);
    await file(join(newDay, "notes.txt"), 10 * DAY, now);

    expect(await pruneHeartbeatRollouts(home, now)).toBe(1);
    expect(await readdir(join(home, "sessions", "2026", "10"))).toEqual(["20"]);
    expect((await readdir(newDay)).sort()).toEqual(["notes.txt", "rollout-new.jsonl"]);
  });

  it("does nothing when the home has no sessions yet", async () => {
    home = await mkdtemp(join(tmpdir(), "heartbeat-rollouts-"));
    expect(await pruneHeartbeatRollouts(home)).toBe(0);
  });
});

import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Every dispatcher heartbeat starts a fresh Codex conversation, so nothing
// resumes an old heartbeat rollout; a few days are kept for debugging.
export const HEARTBEAT_ROLLOUT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export async function pruneHeartbeatRollouts(
  codexHome: string,
  now = Date.now(),
  retentionMs = HEARTBEAT_ROLLOUT_RETENTION_MS
): Promise<number> {
  return pruneRollouts(join(codexHome, "sessions"), now - retentionMs, false);
}

async function pruneRollouts(dir: string, cutoffMs: number, removeIfEmpty: boolean): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Dirent never reports a symlink as a directory or file, so links are left alone.
    if (entry.isDirectory()) removed += await pruneRollouts(path, cutoffMs, true);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) && (await stat(path)).mtimeMs < cutoffMs) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  // rmdir only succeeds on an empty directory.
  if (removeIfEmpty) await rmdir(dir).catch(() => undefined);
  return removed;
}

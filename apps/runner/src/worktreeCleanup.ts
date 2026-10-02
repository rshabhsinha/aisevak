import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {cwd, timeout:30_000, maxBuffer:4*1024*1024})).stdout;
}
export function pathContains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export async function assertNoSymlinks(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlink paths are protected from automatic cleanup");
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}

// Check this service user's cwd and open files, including detached terminals.
// Unknown liveness for an existing service process defers deletion.
export async function hasLiveWorktreeProcess(path: string, ignoredPids: number[] = [], processRoot = "/proc"): Promise<boolean> {
  if (processRoot === "/proc" && process.platform !== "linux") throw new Error("Automatic process liveness checks require Linux");
  const uid = process.getuid?.();
  for (const entry of await readdir(processRoot)) {
    if (!/^\d+$/.test(entry) || ignoredPids.includes(Number(entry))) continue;
    const proc = join(processRoot, entry);
    try {
      if ((await stat(proc)).uid !== uid) continue;
      const cwd = await readlink(join(proc, "cwd"));
      if (pathContains(path, cwd)) return true;
      for (const fd of await readdir(join(proc, "fd"))) {
        try { if (pathContains(path, await readlink(join(proc, "fd", fd)))) return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") {
        // cwd disappears after a multithreaded process's main thread exits,
        // even while surviving threads still hold the checkout. Only a gone
        // process or a confirmed zombie is safe to skip.
        try {
          await stat(proc);
          if (/^State:\s+[ZX]\b/m.test(await readFile(join(proc, "status"), "utf8"))) continue;
        } catch (checkError) {
          if ((checkError as NodeJS.ErrnoException).code === "ENOENT") {
            try { await stat(proc); } catch (gone) {
              if ((gone as NodeJS.ErrnoException).code === "ENOENT" || (gone as NodeJS.ErrnoException).code === "ESRCH") continue;
            }
          }
        }
      }
      throw new Error(`Cannot verify liveness of process ${entry}`);
    }
  }
  return false;
}

export async function removeCleanManagedWorktree(options: {
  root: string; repo: string; path: string; branch: string;
  hasLiveProcess?: (path: string) => Promise<boolean>;
}): Promise<void> {
  const path = resolve(options.path), root = resolve(options.root, "worktrees");
  if (!pathContains(root, path) || path === root) throw new Error("Only managed linked worktrees may be removed");
  try { await lstat(path); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await assertNoSymlinks(path);
  await assertNoSymlinks(options.repo);
  if (!(await lstat(join(path, ".git"))).isFile()) throw new Error("Primary repositories are protected");
  const entries = (await git(options.repo, ["worktree", "list", "--porcelain", "-z"])).split("\0\0").map(entry => entry.split("\0"));
  const index = entries.findIndex(entry => entry.includes(`worktree ${path}`));
  const registered = entries[index];
  if (index <= 0 || !registered || registered.some(field => field === "locked" || field.startsWith("locked ")) || !registered.includes(`branch refs/heads/${options.branch}`)) {
    throw new Error("Worktree ownership, branch or registration is unverified");
  }
  if (await realpath(path) !== path) throw new Error("Noncanonical worktree path is protected");
  const status = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  const changes = status.split("\0").filter(Boolean);
  if (changes.some(change => !change.startsWith("!! node_modules/"))) throw new Error("Dirty, untracked or unknown ignored files are protected");
  const head = (await git(path, ["rev-parse", "HEAD"])).trim();
  if (await (options.hasLiveProcess ?? hasLiveWorktreeProcess)(path)) throw new Error("Live processes still use this worktree");
  if ((await git(path, ["rev-parse", "HEAD"])).trim() !== head || await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]) !== status) {
    throw new Error("Worktree changed during cleanup");
  }
  // No --force, branch deletion, repository deletion or history deletion.
  await git(options.repo, ["worktree", "remove", "--", path]);
}

export async function recreateManagedWorktree(repo: string, path: string, branch: string, defaultBranch: string): Promise<void> {
  const existing = (await git(repo, ["branch", "--list", branch])).trim();
  // Prune only missing worktree registrations. Preserve an existing branch's
  // unmerged/unpushed commits when recreating a previously cleaned checkout.
  await git(repo, ["worktree", "prune"]);
  await git(repo, existing ? ["worktree", "add", "--", path, branch]
    : ["worktree", "add", "-b", branch, "--", path, `origin/${defaultBranch}`]);
}

import { resolve } from "node:path";

export interface GithubRepositoryRecord {
  owner: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function taskBranchName(taskNumber: number, title: string): string {
  const slug = slugify(title) || "task";
  return `agent/${taskNumber}-${slug}`;
}

export function managedGithubRepoPath(managedRoot: string, owner: string, repo: string): string {
  const root = resolve(managedRoot, "workspaces", "github");
  const repoPath = resolve(root, slugify(owner), slugify(repo));
  if (!repoPath.startsWith(root)) {
    throw new Error("Resolved repository path escaped managed workspace root");
  }
  return repoPath;
}

export function managedCodexHome(managedRoot: string, taskId: string): string {
  return resolve(managedRoot, "codex-homes", taskId);
}

export function managedWorktreePath(managedRoot: string, taskId: string, branch: string): string {
  return resolve(managedRoot, "worktrees", taskId, slugify(branch));
}

export function normalizeGithubRepo(input: Record<string, unknown>): GithubRepositoryRecord {
  const fullName = stringField(input, "full_name");
  const [owner, name] = fullName.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository full_name: ${fullName}`);
  }
  return {
    owner,
    name,
    fullName,
    cloneUrl: stringField(input, "clone_url"),
    defaultBranch: stringField(input, "default_branch")
  };
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing GitHub repository field: ${key}`);
  }
  return value;
}

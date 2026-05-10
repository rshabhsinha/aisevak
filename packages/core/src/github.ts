import { join, resolve } from "node:path";
import { createSign } from "node:crypto";

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

export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

export function createGithubAppJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

export async function fetchGithubInstallationToken(options: {
  apiUrl: string;
  appId: string;
  privateKey: string;
  installationId: string;
}): Promise<string> {
  const jwt = createGithubAppJwt(options.appId, options.privateKey);
  const response = await fetch(
    `${options.apiUrl}/app/installations/${options.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token failed: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error("GitHub installation token response did not include token");
  }
  return payload.token;
}

export function githubCloneEnv(token: string, username = "x-access-token"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: join(process.cwd(), "scripts", "git-askpass.js"),
    GIT_USERNAME: username,
    GIT_PASSWORD: token
  };
}

export function sanitizeRemoteUrl(url: string): string {
  return url.replace(/https:\/\/[^:@/]+:[^@/]+@/g, "https://");
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

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

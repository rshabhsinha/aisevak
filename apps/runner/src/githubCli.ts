import { normalizeGithubRepo, redactSecrets, type GithubRepositoryRecord } from "@aisevak/core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "COLORTERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS"
] as const;

export interface GithubCliPaths {
  root: string;
  home: string;
  configDir: string;
  gitConfig: string;
}

export interface GithubCliOptions {
  managedRoot: string;
  binary?: string;
  hostname?: string;
  sourceEnv?: NodeJS.ProcessEnv;
}

export function githubCliPaths(managedRoot: string): GithubCliPaths {
  const root = resolve(managedRoot, "github-auth");
  return {
    root,
    home: resolve(root, "home"),
    configDir: resolve(root, "gh"),
    gitConfig: resolve(root, "home", ".gitconfig")
  };
}

export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export function githubCredentialEnvironment(
  managedRoot: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const paths = githubCliPaths(managedRoot);
  return {
    ...safeChildEnvironment(source),
    HOME: paths.home,
    GH_CONFIG_DIR: paths.configDir,
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1"
  };
}

export function agentGithubEnvironment(managedRoot: string): NodeJS.ProcessEnv {
  const paths = githubCliPaths(managedRoot);
  return {
    GH_CONFIG_DIR: paths.configDir,
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1"
  };
}

export async function authenticateGithubCli(
  token: string,
  options: GithubCliOptions
): Promise<string> {
  const binary = options.binary ?? "gh";
  const hostname = options.hostname ?? "github.com";
  const paths = githubCliPaths(options.managedRoot);
  await resetGithubCliStorage(options.managedRoot);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  const env = githubCredentialEnvironment(options.managedRoot, options.sourceEnv);

  await runCommand(
    binary,
    [
      "auth",
      "login",
      "--hostname",
      hostname,
      "--git-protocol",
      "https",
      "--with-token",
      "--insecure-storage"
    ],
    { env, stdin: `${token.trim()}\n`, secrets: [token.trim()] }
  );
  await runCommand(binary, ["auth", "setup-git", "--hostname", hostname], { env });
  const hostsFile = resolve(paths.configDir, "hosts.yml");
  if (existsSync(hostsFile)) await chmod(hostsFile, 0o600);
  if (existsSync(paths.gitConfig)) await chmod(paths.gitConfig, 0o600);
  return githubAccountLogin(options);
}

export async function githubAccountLogin(options: GithubCliOptions): Promise<string> {
  const result = await runCommand(options.binary ?? "gh", ["api", "user", "--jq", ".login"], {
    env: githubCredentialEnvironment(options.managedRoot, options.sourceEnv)
  });
  const login = result.stdout.trim();
  if (!login) throw new Error("GitHub CLI did not return the authenticated account login");
  return login;
}

export async function discoverGithubRepositories(
  options: GithubCliOptions
): Promise<GithubRepositoryRecord[]> {
  const binary = options.binary ?? "gh";
  const hostname = options.hostname ?? "github.com";
  const result = await runCommand(
    binary,
    [
      "api",
      "--hostname",
      hostname,
      "--paginate",
      "--slurp",
      "/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member"
    ],
    { env: githubCredentialEnvironment(options.managedRoot, options.sourceEnv) }
  );
  return parseGithubRepositoryPages(result.stdout);
}

export function parseGithubRepositoryPages(output: string): GithubRepositoryRecord[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("GitHub CLI returned an invalid repository response");
  const pages = parsed.every(Array.isArray) ? parsed : [parsed];
  return pages.flatMap((page) =>
    (page as unknown[]).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("GitHub CLI returned an invalid repository entry");
      }
      return normalizeGithubRepo(entry as Record<string, unknown>);
    })
  );
}

export async function resetGithubCliStorage(managedRoot: string): Promise<void> {
  const managed = resolve(managedRoot);
  const root = githubCliPaths(managedRoot).root;
  const child = relative(managed, root);
  if (!child || child.startsWith("..") || resolve(managed, child) !== root) {
    throw new Error("Refusing to clear GitHub CLI storage outside the managed root");
  }
  await rm(root, { recursive: true, force: true });
}

export async function runGitCommand(
  args: string[],
  cwd: string | undefined,
  options: Pick<GithubCliOptions, "managedRoot" | "sourceEnv">
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("git", args, {
    cwd,
    env: githubCredentialEnvironment(options.managedRoot, options.sourceEnv)
  });
}

interface CommandOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  secrets?: Array<string | null | undefined>;
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const secrets = options.secrets ?? [];
    child.stdout.on("data", (chunk) => {
      stdout += redactSecrets(String(chunk), secrets);
    });
    child.stderr.on("data", (chunk) => {
      stderr += redactSecrets(String(chunk), secrets);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`));
      }
    });
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

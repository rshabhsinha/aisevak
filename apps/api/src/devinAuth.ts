import {
  DEVIN_API_KEY_SECRET_NAME,
  DEVIN_AUTH_SECRET_NAME,
  decryptSecret,
  devinBundleApiKey,
  devinCredentialsPaths,
  encryptSecret,
  materializeDevinAuthBundle,
  parseDevinAuthStatus,
  parseDevinLoginUrl,
  parseDevinVersion,
  type DbPool
} from "@aisevak/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { collectCliOutput, runHarnessCommand } from "./harnessCommand.js";

const LOGIN_TTL_MS = 15 * 60 * 1000;

interface LoginState {
  requestedBy: string;
  verificationUrl: string | null;
  codeSubmitted: boolean;
  home: string;
  expiresAt: number;
  child: ChildProcessWithoutNullStreams;
  launchError?: Error;
  closed: Promise<void>;
  expiryTimer?: NodeJS.Timeout;
}

export interface DevinAuthStatusResponse {
  connected: boolean;
  activeMethod: "subscription" | "api_key" | null;
  installed: boolean;
  version: string | null;
  email: string | null;
  subscription: string | null;
  needsLogin: boolean;
  lastError: string | null;
}

export interface DevinLogin {
  loginId: string;
  verificationUrl: string | null;
  awaitingCode: boolean;
  expiresAt: number;
}

export class DevinAuthManager {
  private readonly logins = new Map<string, LoginState>();

  constructor(
    private readonly pool: DbPool,
    private readonly secretKey: string,
    private readonly devinBinary: string,
    private readonly authHomeRoot: string,
    private readonly hostHome = homedir()
  ) {}

  async getStatus(): Promise<DevinAuthStatusResponse> {
    const apiKey = await this.readSecret(DEVIN_API_KEY_SECRET_NAME);
    if (apiKey) {
      const probe = await this.probeHome(this.hostHome);
      return {
        connected: true,
        activeMethod: "api_key",
        installed: probe.installed,
        version: probe.version,
        email: probe.email,
        subscription: probe.subscription,
        needsLogin: false,
        lastError: null
      };
    }

    const stored = await this.readSecret(DEVIN_AUTH_SECRET_NAME);
    if (stored) {
      const home = join(this.authHomeRoot, "connected");
      await materializeDevinAuthBundle(home, stored);
      const probe = await this.probeHome(home);
      // `devin acp` ignores credentials.toml; worker turns authenticate with the
      // api_key stored inside it. Warn early when the bundle cannot provide one.
      const keyWarning =
        probe.authenticated && !devinBundleApiKey(stored)
          ? "Connected, but the stored credentials contain no api_key. Reconnect Devin or save an API key so ACP worker turns can authenticate."
          : null;
      return {
        ...probe,
        connected: probe.authenticated,
        activeMethod: probe.authenticated ? "subscription" : null,
        needsLogin: !probe.authenticated,
        lastError: probe.authenticated ? keyWarning : probe.message
      };
    }

    const probe = await this.probeHome(this.hostHome);
    return {
      connected: false,
      activeMethod: null,
      installed: probe.installed,
      version: probe.version,
      email: null,
      subscription: null,
      needsLogin: true,
      lastError: probe.authenticated
        ? "Host Devin credentials were found. Import them to persist for worker homes."
        : probe.message
    };
  }

  async saveApiKey(apiKey: string): Promise<DevinAuthStatusResponse> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error("Devin API key is required");
    await this.upsertSecret(
      DEVIN_API_KEY_SECRET_NAME,
      trimmed,
      "Devin API key passed to the Devin ACP harness as WINDSURF_API_KEY"
    );
    return this.getStatus();
  }

  async importHostAuth(): Promise<DevinAuthStatusResponse> {
    // The API container cannot see host home directories. Operators can run
    // `HOME=<harness-auth>/devin-auth/host-import devin auth login` on the
    // host so the bind-mounted harness-auth dir exposes the credentials here.
    const candidates = [this.hostHome, join(this.authHomeRoot, "host-import")];
    for (const home of candidates) {
      const bundle = await captureDevinAuthBundle(home);
      if (devinBundleApiKey(bundle)) {
        await this.upsertSecret(
          DEVIN_AUTH_SECRET_NAME,
          bundle,
          "Internal Devin CLI authentication used by the runner"
        );
        return this.getStatus();
      }
    }
    throw new Error(
      "No Devin CLI credentials found. Run `devin auth login` on the host with HOME set to the harness-auth host-import directory, or save an API key."
    );
  }

  async startLogin(requestedBy: string): Promise<DevinLogin> {
    this.pruneExpiredLogins();
    await this.dispose();
    const loginId = randomUUID();
    const home = join(this.authHomeRoot, loginId);
    await mkdir(home, { recursive: true });
    const child = spawn(this.devinBinary, ["auth", "login", "--force-manual-token-flow"], {
      cwd: home,
      env: devinHomeEnv(home),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const state: LoginState = {
      requestedBy,
      verificationUrl: null,
      codeSubmitted: false,
      home,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      child,
      closed
    };
    child.on("error", (error) => { state.launchError = error; });
    collectCliOutput(child, (text) => {
      state.verificationUrl = parseDevinLoginUrl(text) ?? state.verificationUrl;
    });
    this.logins.set(loginId, state);
    state.expiryTimer = setTimeout(() => {
      void this.disposeLogin(loginId).catch((error) => console.warn("Devin login cleanup failed", error));
    }, LOGIN_TTL_MS);
    state.expiryTimer.unref();
    await waitForLoginHint(state, 10_000);
    if (state.launchError) {
      await this.disposeLogin(loginId);
      throw new Error(`Unable to start Devin login: ${state.launchError.message}`);
    }
    return {
      loginId,
      verificationUrl: state.verificationUrl,
      awaitingCode: true,
      expiresAt: state.expiresAt
    };
  }

  async submitLoginCode(loginId: string, requestedBy: string, code: string): Promise<DevinLogin> {
    const login = this.logins.get(loginId);
    if (!login || login.requestedBy !== requestedBy) {
      throw new Error("That Devin login request is no longer available");
    }
    if (login.expiresAt <= Date.now()) {
      await this.disposeLogin(loginId);
      throw new Error("The Devin login request expired");
    }
    const trimmed = code.trim();
    if (!trimmed) throw new Error("Paste the code shown after signing in");
    login.child.stdin.write(`${trimmed}\n`);
    login.codeSubmitted = true;
    return {
      loginId,
      verificationUrl: login.verificationUrl,
      awaitingCode: false,
      expiresAt: login.expiresAt
    };
  }

  async pollLogin(
    loginId: string,
    requestedBy: string
  ): Promise<{ status: "pending" | "connected"; auth: DevinAuthStatusResponse }> {
    const login = this.logins.get(loginId);
    if (!login || login.requestedBy !== requestedBy) {
      throw new Error("That Devin login request is no longer available");
    }
    if (login.expiresAt <= Date.now()) {
      await this.disposeLogin(loginId);
      throw new Error("The Devin login request expired");
    }
    const credentials = (
      await Promise.all(
        devinCredentialsPaths(login.home).map((path) => readFile(path, "utf8").catch(() => null))
      )
    ).find(Boolean);
    if (!credentials) {
      return { status: "pending", auth: await this.getStatus() };
    }
    const bundle = await captureDevinAuthBundle(login.home);
    if (!devinBundleApiKey(bundle)) {
      return { status: "pending", auth: await this.getStatus() };
    }
    await this.upsertSecret(
      DEVIN_AUTH_SECRET_NAME,
      bundle,
      "Internal Devin CLI authentication used by the runner"
    );
    await this.disposeLogin(loginId);
    return { status: "connected", auth: await this.getStatus() };
  }

  async disconnect(): Promise<DevinAuthStatusResponse> {
    await this.dispose();
    await this.pool.query("DELETE FROM secrets WHERE name = ANY($1::text[])", [
      [DEVIN_API_KEY_SECRET_NAME, DEVIN_AUTH_SECRET_NAME]
    ]);
    await rm(this.authHomeRoot, { recursive: true, force: true });
    return this.getStatus();
  }

  private async probeHome(home: string): Promise<{
    installed: boolean;
    authenticated: boolean;
    version: string | null;
    email: string | null;
    subscription: string | null;
    message: string | null;
  }> {
    try {
      const env = devinHomeEnv(home);
      const [versionResult, statusResult] = await Promise.all([
        runHarnessCommand(this.devinBinary, ["--version"], { env, timeoutMs: 12_000 }),
        runHarnessCommand(this.devinBinary, ["auth", "status"], { env, timeoutMs: 12_000 })
      ]);
      const parsed = parseDevinAuthStatus(
        statusResult.stdout,
        `${versionResult.stderr}\n${statusResult.stderr}`,
        statusResult.exitCode ?? versionResult.exitCode
      );
      const installed = parsed.installed || versionResult.exitCode === 0;
      return {
        installed,
        authenticated: parsed.authenticated,
        version: parseDevinVersion(versionResult.stdout || versionResult.stderr),
        email: parsed.email,
        subscription: parsed.subscription,
        message: installed ? parsed.message : "Devin CLI (`devin`) is not installed or not on PATH."
      };
    } catch (error) {
      return {
        installed: false,
        authenticated: false,
        version: null,
        email: null,
        subscription: null,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.logins.keys()].map((id) => this.disposeLogin(id)));
  }

  private async disposeLogin(id: string): Promise<void> {
    const login = this.logins.get(id);
    if (!login) return;
    this.logins.delete(id);
    clearTimeout(login.expiryTimer);
    login.child.kill("SIGTERM");
    const killTimer = setTimeout(() => login.child.kill("SIGKILL"), 2_000);
    killTimer.unref();
    try {
      await login.closed;
      await rm(login.home, { recursive: true, force: true });
    } finally {
      clearTimeout(killTimer);
    }
  }

  private pruneExpiredLogins(): void {
    const now = Date.now();
    for (const [id, login] of this.logins) {
      if (login.expiresAt <= now) {
        void this.disposeLogin(id).catch((error) => console.warn("Devin login cleanup failed", error));
      }
    }
  }

  private async readSecret(name: string): Promise<string | undefined> {
    const result = await this.pool.query<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM secrets WHERE name = $1",
      [name]
    );
    const row = result.rows[0];
    return row ? decryptSecret(row.encrypted_value, this.secretKey) : undefined;
  }

  private async upsertSecret(name: string, value: string, description: string): Promise<void> {
    const encrypted = encryptSecret(value, this.secretKey);
    await this.pool.query(
      `INSERT INTO secrets (name, description, encrypted_value, agent_accessible)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (name) DO UPDATE
       SET description = excluded.description, encrypted_value = excluded.encrypted_value, updated_at = now()`,
      [name, description, encrypted]
    );
  }
}

export function devinHomeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    NO_OPEN_BROWSER: "1",
    DEVIN_NO_OPEN_BROWSER: "1"
  };
}

async function waitForLoginHint(state: LoginState, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !state.verificationUrl && !state.launchError) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function captureDevinAuthBundle(home: string): Promise<string> {
  const files: Record<string, string> = {};
  await collectHomeFiles(join(home, ".local", "share", "devin"), home, files);
  await collectHomeFiles(join(home, ".config", "devin"), home, files);
  return JSON.stringify({ homeFiles: files });
}

async function collectHomeFiles(dir: string, home: string, files: Record<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(home, fullPath);
    if (/cache|cli[\/\\]logs|compile-cache|statsig/i.test(relativePath)) continue;
    if (entry.isDirectory()) {
      await collectHomeFiles(fullPath, home, files);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(fullPath);
      if (info.size > 256 * 1024) continue;
      files[relativePath] = await readFile(fullPath, "utf8");
    } catch {
      // skip unreadable or non-text files
    }
  }
}

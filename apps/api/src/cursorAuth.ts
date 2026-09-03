import {
  CURSOR_API_KEY_SECRET_NAME,
  CURSOR_AUTH_SECRET_NAME,
  decryptSecret,
  encryptSecret,
  isCursorHostAuthBundle,
  materializeCursorAuthBundle,
  parseCursorAboutOutput,
  parseCursorLoginUrl,
  parseCursorStatusOutput,
  type DbPool
} from "@aisevak/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { collectCliOutput, runHarnessCommand } from "./harnessCommand.js";

const LOGIN_TTL_MS = 15 * 60 * 1000;
const PORTABLE_AUTH_ERROR =
  "Cursor did not write portable CLI credentials. On a VM host, save a CURSOR_API_KEY so worker homes can authenticate without the host keychain.";

interface LoginState {
  requestedBy: string;
  verificationUrl: string | null;
  userCode: string | null;
  home: string;
  expiresAt: number;
  child: ChildProcessWithoutNullStreams;
}

export interface CursorAuthStatus {
  connected: boolean;
  activeMethod: "subscription" | "api_key" | null;
  installed: boolean;
  version: string | null;
  email: string | null;
  subscription: string | null;
  needsLogin: boolean;
  lastError: string | null;
}

export interface CursorDeviceLogin {
  loginId: string;
  verificationUrl: string | null;
  userCode: string | null;
  intervalSeconds: number;
  expiresAt: number;
}

export class CursorAuthManager {
  private readonly logins = new Map<string, LoginState>();

  constructor(
    private readonly pool: DbPool,
    private readonly secretKey: string,
    private readonly cursorBinary: string,
    private readonly authHomeRoot: string
  ) {}

  async getStatus(): Promise<CursorAuthStatus> {
    const apiKey = await this.readSecret(CURSOR_API_KEY_SECRET_NAME);
    if (apiKey) {
      const probe = await this.probeHome(homedir());
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

    const stored = await this.readSecret(CURSOR_AUTH_SECRET_NAME);
    if (!stored || isCursorHostAuthBundle(stored)) {
      const probe = await this.probeHome(homedir());
      return {
        ...probe,
        connected: false,
        activeMethod: null,
        needsLogin: true,
        lastError: probe.lastError ?? PORTABLE_AUTH_ERROR
      };
    }

    const home = join(this.authHomeRoot, "connected");
    await materializeCursorAuthBundle(home, stored);
    const probe = await this.probeHome(home);
    return {
      ...probe,
      connected: probe.connected,
      activeMethod: probe.connected ? "subscription" : null,
      needsLogin: !probe.connected,
      lastError: probe.connected ? null : probe.lastError
    };
  }

  async saveApiKey(apiKey: string): Promise<CursorAuthStatus> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error("Cursor API key is required");
    await this.upsertSecret(CURSOR_API_KEY_SECRET_NAME, trimmed, "Cursor API key used by the Cursor harness");
    return this.getStatus();
  }

  async importHostAuth(): Promise<CursorAuthStatus> {
    const home = homedir();
    const probe = await this.probeHome(home);
    const bundle = await captureCursorAuthBundle(home);
    if (!probe.connected || !bundleHasFiles(bundle)) {
      throw new Error(PORTABLE_AUTH_ERROR);
    }
    await this.upsertSecret(CURSOR_AUTH_SECRET_NAME, bundle, "Internal Cursor CLI authentication used by the runner");
    return this.getStatus();
  }

  async startLogin(requestedBy: string): Promise<CursorDeviceLogin> {
    this.pruneExpiredLogins();
    for (const [id, login] of this.logins) {
      login.child.kill("SIGTERM");
      this.logins.delete(id);
    }
    const loginId = randomUUID();
    const home = join(this.authHomeRoot, loginId);
    await mkdir(home, { recursive: true });
    const child = spawn(this.cursorBinary, ["login"], {
      cwd: home,
      env: cursorLoginEnv(home),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const state: LoginState = {
      requestedBy,
      verificationUrl: null,
      userCode: null,
      home,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      child
    };
    collectCliOutput(child, (text) => {
      state.verificationUrl = parseCursorLoginUrl(text) ?? state.verificationUrl;
      const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
      if (code) state.userCode = code;
    });
    this.logins.set(loginId, state);
    await waitForLoginHint(state, 8_000);
    return {
      loginId,
      verificationUrl: state.verificationUrl,
      userCode: state.userCode,
      intervalSeconds: 2,
      expiresAt: state.expiresAt
    };
  }

  async pollLogin(loginId: string, requestedBy: string): Promise<{ status: "pending" | "connected"; auth: CursorAuthStatus }> {
    const login = this.logins.get(loginId);
    if (!login || login.requestedBy !== requestedBy) {
      throw new Error("That Cursor login request is no longer available");
    }
    if (login.expiresAt <= Date.now()) {
      login.child.kill("SIGTERM");
      this.logins.delete(loginId);
      throw new Error("The Cursor login request expired");
    }
    const probe = await this.probeHome(login.home);
    const bundle = await captureCursorAuthBundle(login.home);
    if (!probe.connected || !bundleHasFiles(bundle)) {
      return { status: "pending", auth: await this.getStatus() };
    }
    await this.upsertSecret(CURSOR_AUTH_SECRET_NAME, bundle, "Internal Cursor CLI authentication used by the runner");
    login.child.kill("SIGTERM");
    this.logins.delete(loginId);
    return { status: "connected", auth: await this.getStatus() };
  }

  async disconnect(): Promise<CursorAuthStatus> {
    await this.pool.query("DELETE FROM secrets WHERE name = ANY($1::text[])", [
      [CURSOR_API_KEY_SECRET_NAME, CURSOR_AUTH_SECRET_NAME]
    ]);
    await rm(this.authHomeRoot, { recursive: true, force: true });
    return this.getStatus();
  }

  private async probeHome(home: string): Promise<CursorAuthStatus> {
    try {
      const env = cursorLoginEnv(home);
      const [statusResult, aboutResult] = await Promise.all([
        runHarnessCommand(this.cursorBinary, ["status", "--format", "json"], {
          env,
          timeoutMs: 12_000
        }),
        runHarnessCommand(this.cursorBinary, ["about", "--format", "json"], {
          env,
          timeoutMs: 12_000
        })
      ]);
      const parsedStatus = parseCursorStatusOutput(statusResult.stdout || statusResult.stderr);
      const parsedAbout = parseCursorAboutOutput(aboutResult.stdout, aboutResult.stderr, aboutResult.exitCode);
      const authenticated = parsedStatus.authenticated || parsedAbout.authenticated;
      return {
        connected: authenticated,
        activeMethod: authenticated ? "subscription" : null,
        installed: parsedAbout.installed,
        version: parsedAbout.version,
        email: parsedAbout.email ?? parsedStatus.email,
        subscription: parsedAbout.subscription,
        needsLogin: !authenticated,
        lastError: authenticated ? null : parsedAbout.message ?? parsedStatus.message
      };
    } catch (error) {
      return {
        connected: false,
        activeMethod: null,
        installed: false,
        version: null,
        email: null,
        subscription: null,
        needsLogin: true,
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private pruneExpiredLogins(): void {
    const now = Date.now();
    for (const [id, login] of this.logins) {
      if (login.expiresAt <= now) {
        login.child.kill("SIGTERM");
        this.logins.delete(id);
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

function cursorLoginEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    NO_OPEN_BROWSER: "1"
  };
}

async function waitForLoginHint(state: LoginState, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !state.verificationUrl) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function bundleHasFiles(bundle: string): boolean {
  try {
    const parsed = JSON.parse(bundle) as { homeFiles?: Record<string, string> };
    return Object.keys(parsed.homeFiles ?? {}).length > 0;
  } catch {
    return false;
  }
}

async function captureCursorAuthBundle(home: string): Promise<string> {
  const files: Record<string, string> = {};
  for (const root of [".cursor", ".config/cursor", ".config/cursor-agent", ".local/share/cursor-agent"]) {
    await collectHomeFiles(join(home, root), home, files);
  }
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
    if (/cache|compile-cache|statsig/i.test(relativePath)) continue;
    if (entry.isDirectory()) {
      await collectHomeFiles(fullPath, home, files);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      files[relativePath] = await readFile(fullPath, "utf8");
    } catch {
      // skip unreadable binaries
    }
  }
}

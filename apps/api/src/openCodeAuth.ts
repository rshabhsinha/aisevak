import {
  OPENCODE_AUTH_SECRET_NAME,
  decryptSecret,
  encryptSecret,
  defaultOpenCodeAuthPath,
  openCodeAuthProviderIds,
  parseOpenCodeAuthFile,
  parseOpenCodeLoginUrl,
  type DbPool
} from "@aisevak/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { collectCliOutput, runHarnessCommand } from "./harnessCommand.js";

const LOGIN_TTL_MS = 15 * 60 * 1000;

interface LoginState {
  requestedBy: string;
  verificationUrl: string | null;
  home: string;
  expiresAt: number;
  child: ChildProcessWithoutNullStreams;
}

export interface OpenCodeAuthStatus {
  connected: boolean;
  installed: boolean;
  providerIds: string[];
  needsLogin: boolean;
  lastError: string | null;
}

export interface OpenCodeDeviceLogin {
  loginId: string;
  verificationUrl: string | null;
  intervalSeconds: number;
  expiresAt: number;
}

export class OpenCodeAuthManager {
  private readonly logins = new Map<string, LoginState>();

  constructor(
    private readonly pool: DbPool,
    private readonly secretKey: string,
    private readonly openCodeBinary: string,
    private readonly authHomeRoot: string,
    private readonly hostAuthPath = defaultOpenCodeAuthPath()
  ) {}

  async getStatus(): Promise<OpenCodeAuthStatus> {
    const stored = await this.readSecret(OPENCODE_AUTH_SECRET_NAME);
    if (stored) {
      try {
        const providerIds = openCodeAuthProviderIds(parseOpenCodeAuthFile(stored));
        return {
          connected: providerIds.length > 0,
          installed: true,
          providerIds,
          needsLogin: providerIds.length === 0,
          lastError: null
        };
      } catch (error) {
        return {
          connected: false,
          installed: true,
          providerIds: [],
          needsLogin: true,
          lastError: error instanceof Error ? error.message : String(error)
        };
      }
    }

    try {
      const host = await readFile(this.hostAuthPath, "utf8");
      const providerIds = openCodeAuthProviderIds(parseOpenCodeAuthFile(host));
      // Read-only: never persist host credentials from a status check.
      // Use importHostAuth() to store them explicitly.
      return {
        connected: providerIds.length > 0,
        installed: true,
        providerIds,
        needsLogin: providerIds.length === 0,
        lastError:
          providerIds.length > 0
            ? "Using host OpenCode credentials. Import them to persist in the database."
            : "OpenCode has no stored provider credentials."
      };
    } catch {
      // The API container has no writable HOME; give the probe a scratch one.
      const probe = await runHarnessCommand(this.openCodeBinary, ["--version"], {
        env: scratchHomeEnv(),
        timeoutMs: 8_000
      });
      return {
        connected: false,
        installed: probe.exitCode === 0,
        providerIds: [],
        needsLogin: true,
        lastError: probe.exitCode === 0 ? "OpenCode is not authenticated." : "OpenCode CLI is not installed or not on PATH."
      };
    }
  }

  async importHostAuth(): Promise<OpenCodeAuthStatus> {
    const host = await readFile(this.hostAuthPath, "utf8");
    parseOpenCodeAuthFile(host);
    await this.upsertSecret(host);
    return this.getStatus();
  }

  async startLogin(requestedBy: string): Promise<OpenCodeDeviceLogin> {
    this.pruneExpiredLogins();
    for (const [id, login] of this.logins) {
      login.child.kill("SIGTERM");
      this.logins.delete(id);
    }
    const loginId = randomUUID();
    const home = join(this.authHomeRoot, loginId);
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
    const child = spawn(this.openCodeBinary, ["auth", "login", "-p", "opencode"], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CONFIG_HOME: join(home, ".config")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const state: LoginState = {
      requestedBy,
      verificationUrl: null,
      home,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      child
    };
    collectCliOutput(child, (text) => {
      state.verificationUrl = parseOpenCodeLoginUrl(text) ?? state.verificationUrl;
    });
    this.logins.set(loginId, state);
    const started = Date.now();
    while (Date.now() - started < 8_000 && !state.verificationUrl) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      loginId,
      verificationUrl: state.verificationUrl,
      intervalSeconds: 2,
      expiresAt: state.expiresAt
    };
  }

  async pollLogin(loginId: string, requestedBy: string): Promise<{ status: "pending" | "connected"; auth: OpenCodeAuthStatus }> {
    const login = this.logins.get(loginId);
    if (!login || login.requestedBy !== requestedBy) {
      throw new Error("That OpenCode login request is no longer available");
    }
    if (login.expiresAt <= Date.now()) {
      login.child.kill("SIGTERM");
      this.logins.delete(loginId);
      throw new Error("The OpenCode login request expired");
    }
    try {
      const authPath = join(login.home, ".local", "share", "opencode", "auth.json");
      const value = await readFile(authPath, "utf8");
      const providerIds = openCodeAuthProviderIds(parseOpenCodeAuthFile(value));
      if (providerIds.length === 0) {
        return { status: "pending", auth: await this.getStatus() };
      }
      await this.upsertSecret(value);
      login.child.kill("SIGTERM");
      this.logins.delete(loginId);
      return { status: "connected", auth: await this.getStatus() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("OpenCode login poll failed unexpectedly", error);
      }
      return { status: "pending", auth: await this.getStatus() };
    }
  }

  async disconnect(): Promise<OpenCodeAuthStatus> {
    await this.pool.query("DELETE FROM secrets WHERE name = $1", [OPENCODE_AUTH_SECRET_NAME]);
    await rm(this.authHomeRoot, { recursive: true, force: true });
    return this.getStatus();
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

  private async readSecret(name: string): Promise<string | undefined> {    const result = await this.pool.query<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM secrets WHERE name = $1",
      [name]
    );
    const row = result.rows[0];
    return row ? decryptSecret(row.encrypted_value, this.secretKey) : undefined;
  }

  private async upsertSecret(value: string): Promise<void> {
    const encrypted = encryptSecret(value, this.secretKey);
    await this.pool.query(
      `INSERT INTO secrets (name, description, encrypted_value, agent_accessible)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (name) DO UPDATE
       SET description = excluded.description, encrypted_value = excluded.encrypted_value, updated_at = now()`,
      [OPENCODE_AUTH_SECRET_NAME, "Internal OpenCode authentication used by the runner", encrypted]
    );
  }
}

export function scratchHomeEnv(base: string = "/tmp/aisevak-harness-probe"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: base,
    XDG_DATA_HOME: join(base, ".local", "share"),
    XDG_CONFIG_HOME: join(base, ".config"),
    XDG_CACHE_HOME: join(base, ".cache")
  };
}

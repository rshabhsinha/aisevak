import {
  buildClaudeAcpEnv,
  buildCursorAcpArgs,
  CLAUDE_CODE_TOKEN_SECRET_NAME,
  claudeConnectionTag,
  classifyClaudeCredential,
  isClaudeModelId,
  buildDevinAcpArgs,
  buildOpenCodeAcpArgs,
  CURSOR_API_KEY_SECRET_NAME,
  CURSOR_AUTH_SECRET_NAME,
  decryptSecret,
  defaultOpenCodeAuthPath,
  DEVIN_ACP_AUTH_METHOD_ID,
  DEVIN_API_KEY_SECRET_NAME,
  DEVIN_AUTH_SECRET_NAME,
  devinBundleApiKey,
  isCursorHostAuthBundle,
  materializeCursorAuthBundle,
  materializeDevinAuthBundle,
  materializeOpenCodeAuthFile,
  normalizeAcpEvent,
  normalizeCodexEvent,
  OPENCODE_AUTH_SECRET_NAME,
  parseCodexJsonLine,
  parseOpenCodeAuthFile,
  type DbPool,
  type ProviderDriver
} from "@aisevak/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCodexAppServerTurn, type AppServerTurnOptions, type AppServerTurnResult } from "./appServerClient.js";
import { runAcpTurn } from "./acpClient.js";

export interface HarnessLaunchEnv {
  driver: ProviderDriver;
  env: NodeJS.ProcessEnv;
  secrets: string[];
  // ACP `authenticate` credential for drivers that reject CLI credential files
  // in ACP mode (Devin). Sent as _meta.api_key on the authenticate request.
  acpApiKey?: string;
  // Identity of the credential and model baked into the harness environment,
  // so the runner restarts a cached ACP process when either changes.
  connectionTag?: string;
}

export async function materializeHarnessAuth(
  pool: DbPool,
  driver: ProviderDriver,
  runtimeHome: string,
  secretKey: string,
  baseEnv: NodeJS.ProcessEnv,
  model?: string | null
): Promise<HarnessLaunchEnv> {
  if (driver === "claude") {
    if (model && !isClaudeModelId(model)) {
      throw new Error(`Claude Code cannot run ${model}. Give this agent a Claude model such as claude-opus-5-5.`);
    }
    const credential = (await readInternalSecret(pool, CLAUDE_CODE_TOKEN_SECRET_NAME, secretKey))?.trim();
    if (!credential) {
      throw new Error("Claude Code is not authenticated. An admin must connect Claude Code from Settings > Claude Code.");
    }
    classifyClaudeCredential(credential);
    await mkdir(join(runtimeHome, ".claude"), { recursive: true });
    return {
      driver,
      env: buildClaudeAcpEnv({ baseEnv, runtimeHome, credential, model }),
      secrets: [credential],
      connectionTag: claudeConnectionTag(credential, model)
    };
  }

  if (driver === "cursor") {
    const apiKey = await readSecret(pool, CURSOR_API_KEY_SECRET_NAME, secretKey);
    const bundle = await readSecret(pool, CURSOR_AUTH_SECRET_NAME, secretKey);
    if (isCursorHostAuthBundle(bundle) && !apiKey) {
      throw new Error(
        "Cursor subscription tokens are not portable into VM worker homes. Save a CURSOR_API_KEY in Settings > Cursor."
      );
    }
    if (bundle && !isCursorHostAuthBundle(bundle)) {
      await materializeCursorAuthBundle(runtimeHome, bundle);
    }
    if (!apiKey && !bundle) {
      throw new Error("Cursor is not authenticated. An admin must connect Cursor from Settings > Cursor.");
    }
    return {
      driver,
      env: {
        ...baseEnv,
        HOME: runtimeHome,
        XDG_CONFIG_HOME: join(runtimeHome, ".config"),
        XDG_DATA_HOME: join(runtimeHome, ".local", "share"),
        XDG_CACHE_HOME: join(runtimeHome, ".cache"),
        ...(apiKey ? { CURSOR_API_KEY: apiKey } : {})
      },
      secrets: apiKey ? [apiKey] : []
    };
  }

  if (driver === "opencode") {
    const stored = await readSecret(pool, OPENCODE_AUTH_SECRET_NAME, secretKey);
    const auth = stored ?? (await readHostOpenCodeAuth());
    if (!auth) {
      throw new Error("OpenCode is not authenticated. An admin must connect OpenCode from Settings > OpenCode.");
    }
    await materializeOpenCodeAuthFile(runtimeHome, auth);
    return {
      driver,
      env: {
        ...baseEnv,
        HOME: runtimeHome,
        XDG_DATA_HOME: join(runtimeHome, ".local", "share"),
        XDG_CONFIG_HOME: join(runtimeHome, ".config")
      },
      secrets: []
    };
  }

  if (driver === "devin") {
    const apiKey = await readSecret(pool, DEVIN_API_KEY_SECRET_NAME, secretKey);
    const bundle = await readSecret(pool, DEVIN_AUTH_SECRET_NAME, secretKey);
    if (bundle) {
      await materializeDevinAuthBundle(runtimeHome, bundle);
    }
    const acpApiKey = apiKey ?? devinBundleApiKey(bundle);
    if (!apiKey && !bundle) {
      throw new Error("Devin is not authenticated. An admin must connect Devin from Settings > Devin.");
    }
    if (!acpApiKey) {
      throw new Error(
        "Devin credentials were found but contain no api_key for ACP authentication. Reconnect Devin from Settings > Devin."
      );
    }
    return {
      driver,
      env: {
        ...baseEnv,
        HOME: runtimeHome,
        XDG_CONFIG_HOME: join(runtimeHome, ".config"),
        XDG_DATA_HOME: join(runtimeHome, ".local", "share"),
        XDG_CACHE_HOME: join(runtimeHome, ".cache"),
        WINDSURF_API_KEY: acpApiKey
      },
      secrets: [acpApiKey],
      acpApiKey
    };
  }

  return { driver: "codex", env: baseEnv, secrets: [] };
}

export async function runHarnessTurn(input: {
  driver: ProviderDriver;
  cursorBinary: string;
  openCodeBinary: string;
  devinBinary: string;
  claudeBinary: string;
  options: AppServerTurnOptions;
  acpEnv?: NodeJS.ProcessEnv;
  acpApiKey?: string | null;
  connectionTag?: string | null;
}): Promise<AppServerTurnResult> {
  if (input.driver === "claude") {
    return runAcpTurn({
      ...input.options,
      binary: input.claudeBinary,
      args: [],
      runtimeHome: input.options.codexHome,
      env: input.acpEnv ?? input.options.env,
      // Claude Code reads its credential from the environment; the adapter's
      // auth methods are interactive terminal logins, so skip `authenticate`.
      authMethodId: null,
      skipAuthenticate: true,
      connectionTag: input.connectionTag
    });
  }
  if (input.driver === "devin") {
    return runAcpTurn({
      ...input.options,
      binary: input.devinBinary,
      args: buildDevinAcpArgs(input.options.model),
      runtimeHome: input.options.codexHome,
      env: input.acpEnv ?? input.options.env,
      authMethodId: DEVIN_ACP_AUTH_METHOD_ID,
      apiKey: input.acpApiKey
    });
  }
  if (input.driver === "cursor") {
    return runAcpTurn({
      ...input.options,
      binary: input.cursorBinary,
      args: buildCursorAcpArgs(),
      runtimeHome: input.options.codexHome,
      env: input.acpEnv ?? input.options.env,
      authMethodId: "cursor_login"
    });
  }
  if (input.driver === "opencode") {
    return runAcpTurn({
      ...input.options,
      binary: input.openCodeBinary,
      args: buildOpenCodeAcpArgs(),
      runtimeHome: input.options.codexHome,
      env: input.acpEnv ?? input.options.env,
      authMethodId: null
    });
  }
  return runCodexAppServerTurn(input.options);
}

export function normalizeHarnessLine(driver: ProviderDriver, line: string, sessionId?: string | null) {
  const raw = parseCodexJsonLine(line);
  if (!raw) return null;
  return driver === "codex" ? normalizeCodexEvent(raw) : normalizeAcpEvent(raw, sessionId);
}

export async function writePlaceholderConfig(runtimeHome: string, model: string): Promise<void> {
  await mkdir(runtimeHome, { recursive: true });
  await writeFile(join(runtimeHome, "config.toml"), `model = ${JSON.stringify(model)}\n`, "utf8");
}

async function readHostOpenCodeAuth(): Promise<string | undefined> {
  try {
    const host = await readFile(defaultOpenCodeAuthPath(), "utf8");
    parseOpenCodeAuthFile(host);
    return host;
  } catch {
    return undefined;
  }
}

async function readInternalSecret(pool: DbPool, name: string, secretKey: string): Promise<string | undefined> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1 AND agent_accessible = false",
    [name]
  );
  const row = result.rows[0];
  return row ? decryptSecret(row.encrypted_value, secretKey) : undefined;
}

async function readSecret(pool: DbPool, name: string, secretKey: string): Promise<string | undefined> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1",
    [name]
  );
  const row = result.rows[0];
  return row ? decryptSecret(row.encrypted_value, secretKey) : undefined;
}

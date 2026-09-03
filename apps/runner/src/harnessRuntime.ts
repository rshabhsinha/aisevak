import {
  buildCursorAcpArgs,
  buildOpenCodeAcpArgs,
  CURSOR_API_KEY_SECRET_NAME,
  CURSOR_AUTH_SECRET_NAME,
  decryptSecret,
  defaultOpenCodeAuthPath,
  isCursorHostAuthBundle,
  materializeCursorAuthBundle,
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
}

export async function materializeHarnessAuth(
  pool: DbPool,
  driver: ProviderDriver,
  runtimeHome: string,
  secretKey: string,
  baseEnv: NodeJS.ProcessEnv
): Promise<HarnessLaunchEnv> {
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

  return { driver: "codex", env: baseEnv, secrets: [] };
}

export async function runHarnessTurn(input: {
  driver: ProviderDriver;
  cursorBinary: string;
  openCodeBinary: string;
  options: AppServerTurnOptions;
  acpEnv?: NodeJS.ProcessEnv;
}): Promise<AppServerTurnResult> {
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

async function readSecret(pool: DbPool, name: string, secretKey: string): Promise<string | undefined> {
  const result = await pool.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE name = $1",
    [name]
  );
  const row = result.rows[0];
  return row ? decryptSecret(row.encrypted_value, secretKey) : undefined;
}

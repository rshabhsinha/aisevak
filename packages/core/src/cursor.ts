import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { CodexHarnessModel } from "./models.js";
import { applyCodexModelDefaults } from "./models.js";

export const CURSOR_API_KEY_SECRET_NAME = "cursor_api_key";
export const CURSOR_AUTH_SECRET_NAME = "cursor_cli_auth";
export const CURSOR_HOST_AUTH_KIND = "host_keychain";
export const DEFAULT_CURSOR_MODEL = "auto";

// Fallback catalog used only when `cursor-agent --list-models` discovery fails
// (it requires an API key). IDs below are real model IDs evidenced from
// `--list-models` outputs and Cursor docs; `auto` is always safe.
export const CURSOR_HARNESS_MODELS: CodexHarnessModel[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Cursor picks a model for the turn.",
    badge: "Default"
  },
  {
    id: "composer-2",
    label: "Composer 2",
    description: "Cursor's agentic coding model."
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "OpenAI GPT-5.5 through Cursor."
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    description: "Anthropic Opus through Cursor."
  }
];

export function applyCursorModelDefaults(
  models: CodexHarnessModel[],
  preferredModel = DEFAULT_CURSOR_MODEL
): { defaultModel: string; models: CodexHarnessModel[] } {
  return applyCodexModelDefaults(models.length > 0 ? models : CURSOR_HARNESS_MODELS, preferredModel);
}

export interface CursorAboutStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  email: string | null;
  subscription: string | null;
  message: string | null;
}

export function parseCursorAboutOutput(stdout: string, stderr = "", exitCode: number | null = 0): CursorAboutStatus {
  const combined = `${stdout}\n${stderr}`;
  const json = parseJsonObject(stdout);
  if (json) {
    const email = stringValue(json.userEmail) ?? stringValue(json.email);
    const version = stringValue(json.cliVersion) ?? stringValue(json.version);
    const subscription = stringValue(json.subscriptionTier) ?? stringValue(json.subscription);
    const loggedOut = !email || /not logged in|login required|authentication required/i.test(email);
    return {
      installed: true,
      authenticated: !loggedOut,
      version,
      email: loggedOut ? null : email,
      subscription,
      message: loggedOut ? "Cursor Agent is not authenticated. Sign in from Settings > Cursor." : null
    };
  }

  const version = extractAboutField(combined, "CLI Version");
  const email = extractAboutField(combined, "User Email");
  const loggedOut =
    !email || /not logged in|login required|authentication required/i.test(email);
  const missing =
    /unknown command|not found|enoent/i.test(combined) && exitCode !== 0 && !version;
  return {
    installed: !missing,
    authenticated: Boolean(email) && !loggedOut,
    version,
    email: loggedOut ? null : email,
    subscription: extractAboutField(combined, "Subscription"),
    message: missing
      ? "Cursor CLI (`cursor-agent`) is not installed or not on PATH."
      : loggedOut
        ? "Cursor Agent is not authenticated. Sign in from Settings > Cursor."
        : null
  };
}

export function parseCursorStatusOutput(stdout: string): {
  authenticated: boolean;
  email: string | null;
  message: string | null;
} {
  const json = parseJsonObject(stdout);
  if (json) {
    const email = stringValue(json.email) ?? stringValue(json.userEmail);
    const authenticated =
      json.isAuthenticated === true ||
      json.status === "authenticated" ||
      (typeof email === "string" && email.length > 0 && !/not logged in/i.test(email));
    return {
      authenticated,
      email: authenticated ? email : null,
      message: stringValue(json.message)
    };
  }
  return { authenticated: false, email: null, message: stdout.trim() || null };
}

export function parseCursorLoginUrl(output: string): string | null {
  const match = output.match(/https?:\/\/[^\s]+/i);
  return match?.[0]?.replace(/[.,)]+$/, "") ?? null;
}

export function parseCursorModelList(output: string): CodexHarnessModel[] {
  const models: CodexHarnessModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available") || trimmed.startsWith("Model")) continue;
    if (/error|authentication required|not authenticated|login required/i.test(trimmed)) continue;
    const id = trimmed.split(/\s{2,}|\s-\s/)[0]?.trim();
    if (!id || seen.has(id) || id.startsWith("-")) continue;
    // Model ids never contain path separators; skip table headers and prompts.
    if (/[/\\:]/.test(id)) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,80}$/.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: titleCaseSlug(id),
      description: "Available through the Cursor harness."
    });
  }
  return models;
}

export function cursorHostAuthBundle(): string {
  return JSON.stringify({ kind: CURSOR_HOST_AUTH_KIND });
}

export function isCursorHostAuthBundle(bundle: string | undefined | null): boolean {
  if (!bundle) return false;
  try {
    const parsed = JSON.parse(bundle) as { kind?: unknown };
    return parsed.kind === CURSOR_HOST_AUTH_KIND;
  } catch {
    return false;
  }
}

export async function materializeCursorAuthBundle(home: string, bundle: string): Promise<void> {
  if (isCursorHostAuthBundle(bundle)) return;
  let parsed: { homeFiles?: Record<string, string> };
  try {
    parsed = JSON.parse(bundle) as { homeFiles?: Record<string, string> };
  } catch {
    return;
  }
  await mkdir(home, { recursive: true });
  const root = resolve(home);
  for (const [relativePath, content] of Object.entries(parsed.homeFiles ?? {})) {
    const target = resolve(home, relativePath);
    if (relative(root, target).startsWith("..")) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  }
}

function extractAboutField(plain: string, key: string): string | null {
  const stripped = plain.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
  const match = new RegExp(`^${key}\\s{2,}(.+)$`, "mi").exec(stripped);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

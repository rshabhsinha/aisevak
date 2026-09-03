import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexHarnessModel } from "./models.js";
import { applyCodexModelDefaults } from "./models.js";

export const OPENCODE_AUTH_SECRET_NAME = "opencode_auth";
export const OPENCODE_SERVER_PASSWORD_SECRET_NAME = "opencode_server_password";
export const DEFAULT_OPENCODE_MODEL = "opencode/gpt-5.4-nano";
export const MINIMUM_OPENCODE_VERSION = "1.14.19";

export const OPENCODE_HARNESS_MODELS: CodexHarnessModel[] = [
  {
    id: "opencode/gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    description: "OpenCode Go subscription model.",
    badge: "Default"
  },
  {
    id: "opencode/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    description: "Anthropic Sonnet through OpenCode."
  },
  {
    id: "opencode/gpt-5.4",
    label: "GPT-5.4",
    description: "OpenAI GPT-5.4 through OpenCode."
  }
];

export function applyOpenCodeModelDefaults(
  models: CodexHarnessModel[],
  preferredModel = DEFAULT_OPENCODE_MODEL
): { defaultModel: string; models: CodexHarnessModel[] } {
  return applyCodexModelDefaults(models.length > 0 ? models : OPENCODE_HARNESS_MODELS, preferredModel);
}

export function defaultOpenCodeAuthPath(home = homedir()): string {
  return join(home, ".local", "share", "opencode", "auth.json");
}

export async function materializeOpenCodeAuthFile(home: string, authJson: string): Promise<string> {
  parseOpenCodeAuthFile(authJson);
  const authPath = join(home, ".local", "share", "opencode", "auth.json");
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, authJson, { encoding: "utf8", mode: 0o600 });
  return authPath;
}

export function parseOpenCodeAuthFile(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored OpenCode authentication is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored OpenCode authentication has an unsupported format");
  }
  return parsed as Record<string, unknown>;
}

export function openCodeAuthProviderIds(auth: Record<string, unknown>): string[] {
  return Object.keys(auth).filter((key) => key.trim().length > 0 && key !== "version");
}

export function parseOpenCodeModelList(output: string): CodexHarnessModel[] {
  const models: CodexHarnessModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = stripAnsi(line).trim();
    if (!trimmed) continue;
    const idMatch = trimmed.match(/^([a-z0-9._-]+\/[a-z0-9._-]+)/i) ?? trimmed.match(/^([a-z0-9._-]+)/i);
    const id = idMatch?.[1];
    if (!id || seen.has(id) || /^(provider|model|id)$/i.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: titleCaseSlug(id.includes("/") ? id.slice(id.indexOf("/") + 1) : id),
      description: id.includes("/")
        ? `${titleCaseSlug(id.slice(0, id.indexOf("/")))} model through OpenCode.`
        : "Available through the OpenCode harness."
    });
  }
  return models;
}

export function parseOpenCodeLoginUrl(output: string): string | null {
  const match = output.match(/https?:\/\/[^\s]+/i);
  return match?.[0]?.replace(/[.,)]+$/, "") ?? null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

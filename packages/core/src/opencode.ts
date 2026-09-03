import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexHarnessModel } from "./models.js";
import { applyCodexModelDefaults } from "./models.js";

export const OPENCODE_AUTH_SECRET_NAME = "opencode_auth";
export const OPENCODE_SERVER_PASSWORD_SECRET_NAME = "opencode_server_password";
export const DEFAULT_OPENCODE_MODEL = "opencode-go/gpt-5.6-luna";
export const MINIMUM_OPENCODE_VERSION = "1.14.19";

// Fallback catalog used only when `opencode models` discovery fails. These IDs
// were observed from real `opencode models` output.
export const OPENCODE_HARNESS_MODELS: CodexHarnessModel[] = [
  {
    id: "opencode-go/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "OpenAI GPT-5.6 through OpenCode.",
    badge: "Default"
  },
  {
    id: "opencode/muse-spark-1.3-contributor-free",
    label: "Muse Spark 1.3",
    description: "Muse Spark through OpenCode."
  },
  {
    id: "opencode-go/glm-5.3",
    label: "GLM 5.3",
    description: "Zhipu GLM through OpenCode."
  }
];

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export type OpenCodeRoute = "zen" | "zen-free" | "go" | "custom";

// Free-tier Zen models that don't carry a `-free` suffix (per opencode.ai/docs/zen).
const ZEN_FREE_IDS = new Set(["big-pickle"]);

export function openCodeRouteOf(modelId: string): OpenCodeRoute {
  if (modelId.startsWith("opencode-go/")) return "go";
  if (!modelId.startsWith("opencode/")) return "custom";
  const slug = modelId.slice("opencode/".length);
  return slug.endsWith("-free") || ZEN_FREE_IDS.has(slug) ? "zen-free" : "zen";
}

export function openCodeRouteBadge(route: OpenCodeRoute): string | undefined {
  switch (route) {
    case "go":
      return "Go";
    case "zen-free":
      return "Zen Free";
    case "zen":
      return "Zen";
    default:
      return undefined;
  }
}

export function openCodeRouteDescription(route: OpenCodeRoute): string | undefined {
  switch (route) {
    case "go":
      return "Via OpenCode Go ($10/mo subscription).";
    case "zen-free":
      return "Via OpenCode Zen · free tier.";
    case "zen":
      return "Via OpenCode Zen (pay-as-you-go).";
    default:
      return undefined;
  }
}

export function applyOpenCodeModelDefaults(
  models: CodexHarnessModel[],
  preferredModel = DEFAULT_OPENCODE_MODEL
): { defaultModel: string; models: CodexHarnessModel[] } {
  const configured = applyCodexModelDefaults(
    models.length > 0 ? models : OPENCODE_HARNESS_MODELS,
    preferredModel
  );
  // Re-tag the billing route after defaults: the shared applier only knows
  // the "Default" badge, but OpenCode models bill through Zen or Go.
  return {
    defaultModel: configured.defaultModel,
    models: configured.models.map((model) => {
      const route = openCodeRouteOf(model.id);
      const routeBadge = openCodeRouteBadge(route);
      const routeDescription = openCodeRouteDescription(route);
      const isDefault = model.id === configured.defaultModel;
      return {
        ...model,
        badge: isDefault ? "Default" : (routeBadge ?? model.badge),
        description: routeDescription ?? model.description
      };
    })
  };
}

export interface ZenModelsFetchOptions {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchZenModelCatalog(
  options: ZenModelsFetchOptions = {}
): Promise<CodexHarnessModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.url ?? OPENCODE_ZEN_MODELS_URL, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000)
  });
  if (!response.ok) {
    throw new Error(`Zen model catalog request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown }>;
  };
  const seen = new Set<string>();
  const models: CodexHarnessModel[] = [];
  for (const entry of payload.data ?? []) {
    const rawId = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    const id = `opencode/${rawId}`;
    const slug = rawId.includes("/") ? rawId.slice(rawId.indexOf("/") + 1) : rawId;
    models.push({ id, label: titleCaseSlug(slug), description: "" });
  }
  return models;
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
    // Never treat CLI/process errors as models (e.g. "spawn opencode ENOENT").
    // Bare ids contain no spaces, so only filter spaced lines plus ENOENT.
    if (/enoent/i.test(trimmed)) continue;
    if (/\s/.test(trimmed) && /not found|command not found|authentication required|not authenticated|login required|^error\b/i.test(trimmed)) continue;
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

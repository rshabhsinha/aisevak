import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { CodexHarnessModel } from "./models.js";
import { applyCodexModelDefaults } from "./models.js";

export const DEVIN_AUTH_SECRET_NAME = "devin_auth";
export const DEVIN_API_KEY_SECRET_NAME = "devin_api_key";
export const DEVIN_ACP_AUTH_METHOD_ID = "devin-browser";
export const DEFAULT_DEVIN_MODEL = "swe";

// Fallback catalog used only when `devin models list --format json` discovery
// fails (it requires authentication). Short family names (swe, opus, sonnet,
// gpt, gemini) always resolve to the latest model in that family per Devin docs;
// `swe` currently resolves to the SWE-2 family.
export const DEVIN_HARNESS_MODELS: CodexHarnessModel[] = [
  {
    id: "swe",
    label: "SWE",
    description: "Cognition's SWE coding model family (latest, currently SWE-2).",
    badge: "Default"
  },
  {
    id: "adaptive",
    label: "Adaptive",
    description: "Devin's router picks the best model for each prompt."
  },
  {
    id: "swe-1-7-lightning",
    label: "SWE-1.7 Lightning",
    description: "Fast SWE model for quick edits and questions."
  },
  {
    id: "opus",
    label: "Claude Opus",
    description: "Latest Anthropic Opus through Devin."
  },
  {
    id: "sonnet",
    label: "Claude Sonnet",
    description: "Latest Anthropic Sonnet through Devin."
  },
  {
    id: "gpt",
    label: "GPT",
    description: "Latest OpenAI GPT through Devin."
  },
  {
    id: "gemini",
    label: "Gemini",
    description: "Latest Google Gemini through Devin."
  }
];

export function applyDevinModelDefaults(
  models: CodexHarnessModel[],
  preferredModel = DEFAULT_DEVIN_MODEL
): { defaultModel: string; models: CodexHarnessModel[] } {
  return applyCodexModelDefaults(models.length > 0 ? models : DEVIN_HARNESS_MODELS, preferredModel);
}

export function buildDevinAcpArgs(model?: string | null): string[] {
  const explicit = model?.trim();
  return [
    "acp",
    ...(explicit && !["auto", "default"].includes(explicit.toLowerCase())
      ? ["--model", explicit]
      : [])
  ];
}

export interface DevinAuthStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  email: string | null;
  subscription: string | null;
  message: string | null;
}

// `devin auth status` exits 0 whether or not credentials exist, so the parser
// keys off the text: "Not logged in." vs an identity line when authenticated.
export function parseDevinAuthStatus(stdout: string, stderr = "", exitCode: number | null = 0): DevinAuthStatus {
  const combined = `${stdout}\n${stderr}`;
  const loggedOut = /not logged in|not authenticated|login required|no credentials/i.test(combined);
  const missing = /command not found|enoent|no such file/i.test(combined) && exitCode !== 0;
  const email = combined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const authenticated = !loggedOut && !missing && (Boolean(email) || /logged in|authenticated/i.test(combined));
  return {
    installed: !missing,
    authenticated,
    version: null,
    email: authenticated ? email : null,
    subscription: extractStatusField(combined, /plan|subscription|tier/i),
    message: missing
      ? "Devin CLI (`devin`) is not installed or not on PATH."
      : loggedOut
        ? "Devin CLI is not authenticated. Connect Devin from Settings > Devin."
        : null
  };
}

export function parseDevinVersion(output: string): string | null {
  const match = output.match(/devin\s+([0-9][0-9a-zA-Z.:-]*)/i);
  return match?.[1] ?? null;
}

export function parseDevinLoginUrl(output: string): string | null {
  const match = output.match(/https?:\/\/[^\s]+/i);
  return match?.[0]?.replace(/[.,)\]]+$/, "") ?? null;
}

// `devin models list --format json` emits ClientModelConfig-shaped entries
// (model_or_alias / model_uid / model_family_metadata). The exact envelope has
// varied across builds, so this walks the payload and collects anything that
// looks like a model entry, then falls back to line parsing for text output.
export function parseDevinModelList(output: string): CodexHarnessModel[] {
  const trimmed = output.trim();
  const json = parseJsonValue(trimmed) ?? parseJsonValue(trimmed.slice(trimmed.search(/[[{]/)));
  const fromJson = json !== undefined ? collectJsonModels(json) : [];
  if (fromJson.length > 0) return fromJson;
  return parseTextModelList(output);
}

function collectJsonModels(root: unknown): CodexHarnessModel[] {
  const models: CodexHarnessModel[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = objectValue(value);
    if (!record) return;
    const id =
      stringValue(record.model_or_alias) ??
      stringValue(record.modelOrAlias) ??
      stringValue(record.model_uid) ??
      stringValue(record.modelUid) ??
      stringValue(record.id);
    const looksLikeModel =
      id !== undefined &&
      (record.model_or_alias !== undefined ||
        record.model_uid !== undefined ||
        record.modelOrAlias !== undefined ||
        record.modelUid !== undefined ||
        record.model_family_metadata !== undefined ||
        record.model_info !== undefined);
    if (looksLikeModel && id && !seen.has(id)) {
      seen.add(id);
      const family = objectValue(record.model_family_metadata) ?? objectValue(record.modelFamilyMetadata);
      const info = objectValue(record.model_info) ?? objectValue(record.modelInfo);
      const label =
        stringValue(record.label) ??
        stringValue(record.display_name) ??
        stringValue(record.displayName) ??
        stringValue(family?.model_family_label) ??
        stringValue(info?.model_name) ??
        titleCaseSlug(id);
      const provider = stringValue(record.api_provider) ?? stringValue(record.apiProvider);
      models.push({
        id,
        label,
        description: provider
          ? `${titleCaseSlug(provider)} model through Devin.`
          : "Available through the Devin harness.",
        ...(record.is_recommended === true || record.isRecommended === true
          ? { badge: "Recommended" }
          : {})
      });
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(root);
  return models;
}

function parseTextModelList(output: string): CodexHarnessModel[] {
  const models: CodexHarnessModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = stripAnsi(line).trim();
    if (!trimmed) continue;
    if (/enoent/i.test(trimmed)) continue;
    if (/not logged in|not authenticated|login required|^error\b|command not found/i.test(trimmed)) continue;
    const idMatch = trimmed.match(/^([a-z0-9][a-z0-9._-]{0,80})/i);
    const id = idMatch?.[1];
    if (!id || seen.has(id) || /^(model|family|id|name|available)$/i.test(id)) continue;
    // Family headers ("SWE", "Claude") are bare Title-Case words; model
    // aliases are lowercase slugs or carry digits/separators.
    if (/^[A-Z][a-zA-Z ]*$/.test(trimmed) && !/[0-9._-]/.test(id)) continue;
    if (/[/\\:]/.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: titleCaseSlug(id),
      description: "Available through the Devin harness."
    });
  }
  return models;
}

export function devinCredentialsPath(home: string): string {
  return join(home, ".local", "share", "devin", "credentials.toml");
}

// `devin acp` deliberately ignores credentials.toml — ACP hosts must call the
// `authenticate` request with `_meta.api_key`. The PKCE login exchange stores
// that key in credentials.toml, so worker homes authenticate by extracting it.
export function extractDevinApiKey(credentialsToml: string): string | null {
  for (const line of credentialsToml.split(/\r?\n/)) {
    const match = line.trim().match(/^api_key\s*=\s*"([^"]+)"\s*$/) ?? line.trim().match(/^api_key\s*=\s*'([^']+)'\s*$/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function devinBundleApiKey(bundle: string | undefined | null): string | null {
  if (!bundle) return null;
  try {
    const parsed = JSON.parse(bundle) as { homeFiles?: Record<string, string> };
    const credentials =
      parsed.homeFiles?.[".local/share/devin/credentials.toml"] ??
      Object.entries(parsed.homeFiles ?? {}).find(([path]) => path.endsWith("devin/credentials.toml"))?.[1];
    return credentials ? extractDevinApiKey(credentials) : null;
  } catch {
    return null;
  }
}

export async function materializeDevinAuthBundle(home: string, bundle: string): Promise<void> {
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

function extractStatusField(text: string, keyPattern: RegExp): string | null {
  const stripped = stripAnsi(text);
  for (const line of stripped.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z ]+):\s+(.+)$/);
    const key = match?.[1];
    const value = match?.[2];
    if (key && value && keyPattern.test(key)) return value.trim();
  }
  return null;
}

function parseJsonValue(value: string): unknown {
  if (!value || !/^[[{]/.test(value.trim())) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

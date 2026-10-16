import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CodexHarnessModel } from "./models.js";
import { applyCodexModelDefaults, reasoningEffortOptions } from "./models.js";

// One encrypted secret holds whichever Claude credential the admin pasted:
// a long-lived subscription token from `claude setup-token` (sk-ant-oat…) or
// an Anthropic Console API key (sk-ant-api…). The kind is derived from the
// prefix at launch time, so switching between them is a single save.
export const CLAUDE_CODE_TOKEN_SECRET_NAME = "claude_code_token";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

// Claude Code is driven over ACP by `claude-agent-acp`. It reports its own
// model and effort options per session; this catalog is what the control room
// offers, and the adapter resolves these full model IDs onto its options.
// Effort defaults follow each model's API default (Opus 5.5 and Haiku 5.5
// default to medium; Fable 5.1 and Sonnet 5.5 to high).
export const CLAUDE_HARNESS_MODELS: CodexHarnessModel[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "Anthropic's default Opus model for agentic coding.",
    badge: "Default",
    options: reasoningEffortOptions("medium", "max")
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    description: "Anthropic's most capable model for long-horizon work.",
    options: reasoningEffortOptions("high", "max")
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    description: "Fast, capable model for everyday coding.",
    options: reasoningEffortOptions("high", "max")
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    description: "Small, fast model for simple tasks.",
    options: reasoningEffortOptions("medium", "max")
  }
];

export function applyClaudeModelDefaults(
  models: CodexHarnessModel[] = CLAUDE_HARNESS_MODELS,
  preferredModel = DEFAULT_CLAUDE_MODEL
): { defaultModel: string; models: CodexHarnessModel[] } {
  return applyCodexModelDefaults(models.length > 0 ? models : CLAUDE_HARNESS_MODELS, preferredModel);
}

export type ClaudeCredentialKind = "oauth_token" | "api_key";

export function classifyClaudeCredential(value: string): ClaudeCredentialKind {
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) {
    throw new Error("Claude credential must be a single token without spaces.");
  }
  if (trimmed.startsWith("sk-ant-oat")) return "oauth_token";
  if (trimmed.startsWith("sk-ant-api")) return "api_key";
  throw new Error(
    "Paste a token from `claude setup-token` (starts with sk-ant-oat) or an Anthropic API key (starts with sk-ant-api)."
  );
}

// Every variable Claude Code reads a credential from. The launch environment
// clears all of them before setting the stored one, because Claude Code gives
// an API key precedence over a subscription token.
const CLAUDE_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY"
] as const;

export function claudeCredentialEnv(credential: string): Record<string, string> {
  const trimmed = credential.trim();
  return classifyClaudeCredential(trimmed) === "oauth_token"
    ? { CLAUDE_CODE_OAUTH_TOKEN: trimmed }
    : { ANTHROPIC_API_KEY: trimmed };
}

export function buildClaudeAcpEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  runtimeHome: string;
  credential: string;
  model?: string | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.baseEnv };
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) delete env[key];
  const model = input.model?.trim();
  return {
    ...env,
    HOME: input.runtimeHome,
    // Per-thread config dir: Claude Code keeps session transcripts here, which
    // `session/load` needs to resume the thread's conversation.
    CLAUDE_CONFIG_DIR: join(input.runtimeHome, ".claude"),
    XDG_CONFIG_HOME: join(input.runtimeHome, ".config"),
    XDG_DATA_HOME: join(input.runtimeHome, ".local", "share"),
    XDG_CACHE_HOME: join(input.runtimeHome, ".cache"),
    DISABLE_AUTOUPDATER: "1",
    ...(model && !["auto", "default"].includes(model.toLowerCase()) ? { ANTHROPIC_MODEL: model } : {}),
    ...claudeCredentialEnv(input.credential)
  };
}

// Folded into the ACP connection key so a cached adapter process is replaced
// when the credential or model changes, without putting the secret in the key.
export function claudeConnectionTag(credential: string, model?: string | null): string {
  const digest = createHash("sha256").update(credential.trim()).digest("hex").slice(0, 16);
  return `claude:${digest}:${model?.trim() ?? ""}`;
}

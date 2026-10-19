import {
  providerInstanceSecretName,
  CLAUDE_CODE_TOKEN_SECRET_NAME,
  classifyClaudeCredential,
  decryptSecret,
  encryptSecret,
  type ClaudeCredentialKind,
  type DbPool
} from "@aisevak/core";

export interface ClaudeCodeAuthStatus {
  connected: boolean;
  activeMethod: "subscription" | "api_key" | null;
  // Last four characters only, so admins can tell which credential is stored.
  credentialHint: string | null;
  updatedAt: string | null;
  lastError: string | null;
}

export type AnthropicKeyCheck = (apiKey: string) => Promise<"valid" | "invalid" | "unknown">;

// Claude Code itself runs only on the host (via `claude-agent-acp`), so the
// API cannot probe it. Status reflects the stored credential; API keys are
// checked against the Anthropic API when saved. Subscription tokens from
// `claude setup-token` are only usable by Claude Code, so they are format-checked.
export class ClaudeCodeAuthManager {
  constructor(
    private readonly pool: DbPool,
    private readonly secretKey: string,
    private readonly checkApiKey: AnthropicKeyCheck = checkAnthropicApiKey,
    private readonly instanceId?: string
  ) {}

  private secret(baseName: string): string {
    return providerInstanceSecretName(baseName, this.instanceId);
  }

  async getStatus(): Promise<ClaudeCodeAuthStatus> {
    const stored = await this.readSecret();
    if (!stored) {
      return { connected: false, activeMethod: null, credentialHint: null, updatedAt: null, lastError: null };
    }
    let kind: ClaudeCredentialKind;
    try {
      kind = classifyClaudeCredential(stored.value);
    } catch (error) {
      return {
        connected: false,
        activeMethod: null,
        credentialHint: hint(stored.value),
        updatedAt: stored.updatedAt,
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
    return {
      connected: true,
      activeMethod: kind === "oauth_token" ? "subscription" : "api_key",
      credentialHint: hint(stored.value),
      updatedAt: stored.updatedAt,
      lastError: null
    };
  }

  async saveCredential(value: string): Promise<ClaudeCodeAuthStatus> {
    const trimmed = value.trim();
    const kind = classifyClaudeCredential(trimmed);
    if (kind === "api_key" && (await this.checkApiKey(trimmed)) === "invalid") {
      throw new Error("Anthropic rejected this API key. Check that it is active and belongs to the right organization.");
    }
    const encrypted = encryptSecret(trimmed, this.secretKey);
    await this.pool.query(
      `INSERT INTO secrets (name, description, encrypted_value, agent_accessible)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (name) DO UPDATE
       SET description = excluded.description, encrypted_value = excluded.encrypted_value,
           agent_accessible = false, updated_at = now()`,
      [
        this.secret(CLAUDE_CODE_TOKEN_SECRET_NAME),
        kind === "oauth_token"
          ? "Claude subscription token used by the Claude Code harness"
          : "Anthropic API key used by the Claude Code harness",
        encrypted
      ]
    );
    return this.getStatus();
  }

  async disconnect(): Promise<ClaudeCodeAuthStatus> {
    await this.pool.query("DELETE FROM secrets WHERE name = $1 AND agent_accessible = false", [
      this.secret(CLAUDE_CODE_TOKEN_SECRET_NAME)
    ]);
    return this.getStatus();
  }

  private async readSecret(): Promise<{ value: string; updatedAt: string | null } | undefined> {
    const result = await this.pool.query<{ encrypted_value: string; updated_at: Date | string | null }>(
      // Only the internal (never agent-visible) row counts: an agent credential
      // that happens to share the name must not become the harness credential.
      "SELECT encrypted_value, updated_at FROM secrets WHERE name = $1 AND agent_accessible = false",
      [this.secret(CLAUDE_CODE_TOKEN_SECRET_NAME)]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const updatedAt =
      row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ? String(row.updated_at) : null;
    return { value: decryptSecret(row.encrypted_value, this.secretKey), updatedAt };
  }
}

function hint(value: string): string {
  return `…${value.trim().slice(-4)}`;
}

// A one-token Messages call: unlike GET /v1/models it fails for keys whose
// organization cannot run requests. Network failures are inconclusive.
export async function checkAnthropicApiKey(apiKey: string): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 401 || response.status === 403) return "invalid";
    return response.ok ? "valid" : "unknown";
  } catch {
    return "unknown";
  }
}

import {
  buildCodexChatGptAuthFile,
  CODEX_CHATGPT_AUTH_SECRET_NAME,
  decryptSecret,
  encryptSecret,
  parseCodexChatGptAuthFile,
  serializeCodexChatGptAuthFile,
  type CodexChatGptAuthFile,
  type DbPool
} from "@aisevak/core";
import { randomUUID } from "node:crypto";

const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const LOGIN_TTL_MS = 15 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

interface DeviceLoginState {
  requestedBy: string;
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
}

export interface CodexAuthStatus {
  connected: boolean;
  activeMethod: "chatgpt" | "api_key" | null;
  chatgptConnected: boolean;
  apiKeyConfigured: boolean;
  email: string | null;
  name: string | null;
  accountIdSuffix: string | null;
  expiresAt: number | null;
  lastRefresh: string | null;
  needsLogin: boolean;
  lastError: string | null;
}

export interface CodexDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
}

export class CodexAuthManager {
  private readonly logins = new Map<string, DeviceLoginState>();
  private readonly clientId: string;
  private readonly authBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly pool: DbPool,
    private readonly secretKey: string,
    options: {
      clientId?: string;
      authBaseUrl?: string;
      fetchImpl?: typeof fetch;
    } = {}
  ) {
    this.clientId = options.clientId ?? process.env.CODEX_OAUTH_CLIENT_ID ?? DEFAULT_CODEX_CLIENT_ID;
    this.authBaseUrl = options.authBaseUrl ?? DEFAULT_CODEX_AUTH_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getStatus(): Promise<CodexAuthStatus> {
    const result = await this.pool.query<{ name: string; encrypted_value: string }>(
      "SELECT name, encrypted_value FROM secrets WHERE name = ANY($1::text[])",
      [[CODEX_CHATGPT_AUTH_SECRET_NAME, "openai_api_key"]]
    );
    const apiKeyConfigured = result.rows.some(
      (row) => row.name === "openai_api_key" && row.encrypted_value.length > 0
    );
    const stored = result.rows.find((row) => row.name === CODEX_CHATGPT_AUTH_SECRET_NAME);
    if (!stored) {
      return emptyStatus(apiKeyConfigured);
    }

    try {
      const auth = parseCodexChatGptAuthFile(decryptSecret(stored.encrypted_value, this.secretKey));
      const profile = decodeJwtPayload(auth.tokens.id_token);
      return {
        connected: true,
        activeMethod: "chatgpt",
        chatgptConnected: true,
        apiKeyConfigured,
        email: stringValue(profile?.email) ?? null,
        name: stringValue(profile?.name) ?? null,
        accountIdSuffix: auth.tokens.account_id.slice(-6),
        expiresAt: tokenExpiry(auth.tokens.access_token),
        lastRefresh: auth.last_refresh,
        needsLogin: false,
        lastError: null
      };
    } catch (error) {
      return {
        ...emptyStatus(apiKeyConfigured),
        needsLogin: !apiKeyConfigured,
        lastError: sanitizeCodexAuthError(error)
      };
    }
  }

  async startDeviceLogin(requestedBy: string): Promise<CodexDeviceLogin> {
    this.pruneExpiredLogins();
    const { response, body } = await this.fetchJson(
      `${this.authBaseUrl}/api/accounts/deviceauth/usercode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: this.clientId })
      }
    );
    if (!response.ok || !body) {
      throw new Error(`Could not start ChatGPT device authorization (${response.status})`);
    }

    const deviceAuthId = stringValue(body.device_auth_id);
    const userCode = stringValue(body.user_code) ?? stringValue(body.usercode);
    if (!deviceAuthId || !userCode) {
      throw new Error("ChatGPT device authorization returned an incomplete login challenge");
    }
    const intervalSeconds = Math.max(2, Number(body.interval) || 5);
    const expiresAt = Date.now() + LOGIN_TTL_MS;
    const loginId = randomUUID();
    this.logins.set(loginId, {
      requestedBy,
      deviceAuthId,
      userCode,
      intervalSeconds,
      expiresAt
    });

    return {
      loginId,
      verificationUrl: `${this.authBaseUrl}/codex/device`,
      userCode,
      intervalSeconds,
      expiresAt
    };
  }

  async pollDeviceLogin(
    loginId: string,
    requestedBy: string
  ): Promise<{ status: "pending" | "connected"; auth: CodexAuthStatus }> {
    const login = this.logins.get(loginId);
    if (!login || login.requestedBy !== requestedBy) {
      throw new Error("This ChatGPT login request was not found");
    }
    if (login.expiresAt <= Date.now()) {
      this.logins.delete(loginId);
      throw new Error("The ChatGPT device code expired. Start a new login");
    }

    const { response, body } = await this.fetchJson(
      `${this.authBaseUrl}/api/accounts/deviceauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          device_auth_id: login.deviceAuthId,
          user_code: login.userCode
        })
      }
    );
    if (response.status === 403 || response.status === 404) {
      return { status: "pending", auth: await this.getStatus() };
    }
    if (!response.ok || !body) {
      throw new Error(`ChatGPT device authorization failed (${response.status})`);
    }

    const auth = await this.exchangeAuthorizationCode(body);
    await this.persistAuth(auth, requestedBy);
    this.logins.delete(loginId);
    return { status: "connected", auth: await this.getStatus() };
  }

  async disconnect(): Promise<CodexAuthStatus> {
    await this.pool.query("DELETE FROM secrets WHERE name = $1", [CODEX_CHATGPT_AUTH_SECRET_NAME]);
    return this.getStatus();
  }

  private async exchangeAuthorizationCode(codePayload: JsonRecord): Promise<CodexChatGptAuthFile> {
    const authorizationCode = stringValue(codePayload.authorization_code);
    const codeVerifier = stringValue(codePayload.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error("ChatGPT device authorization returned an incomplete code exchange");
    }

    const { response, body } = await this.fetchJson(`${this.authBaseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.clientId,
        redirect_uri: `${this.authBaseUrl}/deviceauth/callback`,
        code: authorizationCode,
        code_verifier: codeVerifier
      }).toString()
    });
    if (!response.ok || !body) {
      throw new Error(`ChatGPT OAuth token exchange failed (${response.status})`);
    }

    const accessToken = stringValue(body.access_token);
    const refreshToken = stringValue(body.refresh_token);
    const idToken = stringValue(body.id_token);
    const accountId = extractAccountId(accessToken, idToken);
    if (!accessToken || !refreshToken || !idToken || !accountId) {
      throw new Error("ChatGPT OAuth did not return a complete refreshable Codex credential");
    }
    return buildCodexChatGptAuthFile({ accessToken, refreshToken, idToken, accountId });
  }

  private async persistAuth(auth: CodexChatGptAuthFile, requestedBy: string): Promise<void> {
    const encrypted = encryptSecret(serializeCodexChatGptAuthFile(auth), this.secretKey);
    await this.pool.query(
      `INSERT INTO secrets (name, description, encrypted_value, agent_accessible, created_by)
       VALUES ($1, $2, $3, false, $4)
       ON CONFLICT (name) DO UPDATE
       SET description = excluded.description,
           encrypted_value = excluded.encrypted_value,
           agent_accessible = false,
           updated_at = now()`,
      [
        CODEX_CHATGPT_AUTH_SECRET_NAME,
        "Internal ChatGPT authentication used by the Codex runner",
        encrypted,
        requestedBy
      ]
    );
  }

  private async fetchJson(
    url: string,
    init: RequestInit
  ): Promise<{ response: Response; body: JsonRecord | null }> {
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    if (!text) return { response, body: null };
    try {
      const parsed: unknown = JSON.parse(text);
      return { response, body: isRecord(parsed) ? parsed : null };
    } catch {
      return { response, body: null };
    }
  }

  private pruneExpiredLogins(): void {
    const now = Date.now();
    for (const [id, login] of this.logins) {
      if (login.expiresAt <= now) this.logins.delete(id);
    }
  }
}

export function sanitizeCodexAuthError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "Unknown ChatGPT authentication error"))
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .slice(0, 600);
}

function emptyStatus(apiKeyConfigured: boolean): CodexAuthStatus {
  return {
    connected: apiKeyConfigured,
    activeMethod: apiKeyConfigured ? "api_key" : null,
    chatgptConnected: false,
    apiKeyConfigured,
    email: null,
    name: null,
    accountIdSuffix: null,
    expiresAt: null,
    lastRefresh: null,
    needsLogin: !apiKeyConfigured,
    lastError: null
  };
}

function extractAccountId(accessToken: string | undefined, idToken: string | undefined): string | undefined {
  const claim = "https://api.openai.com/auth";
  const access = decodeJwtPayload(accessToken);
  const identity = decodeJwtPayload(idToken);
  const accessAuth = isRecord(access?.[claim]) ? access[claim] : undefined;
  const identityAuth = isRecord(identity?.[claim]) ? identity[claim] : undefined;
  return [
    stringValue(accessAuth?.chatgpt_account_id),
    stringValue(access?.chatgpt_account_id),
    stringValue(identityAuth?.chatgpt_account_id),
    stringValue(identity?.chatgpt_account_id)
  ].find(Boolean);
}

function tokenExpiry(token: string): number | null {
  const expiry = Number(decodeJwtPayload(token)?.exp);
  return Number.isFinite(expiry) && expiry > 0 ? expiry * 1000 : null;
}

function decodeJwtPayload(token: string | undefined): JsonRecord | undefined {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

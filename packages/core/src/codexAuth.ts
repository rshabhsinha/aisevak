export const CODEX_CHATGPT_AUTH_SECRET_NAME = "openai_codex_auth";

export interface CodexChatGptAuthFile {
  auth_mode: "chatgpt";
  OPENAI_API_KEY: null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh: string;
}

export interface CodexChatGptTokenSet {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

export function buildCodexChatGptAuthFile(tokens: CodexChatGptTokenSet): CodexChatGptAuthFile {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: requiredString(tokens.idToken, "id token"),
      access_token: requiredString(tokens.accessToken, "access token"),
      refresh_token: requiredString(tokens.refreshToken, "refresh token"),
      account_id: requiredString(tokens.accountId, "account id")
    },
    last_refresh: new Date().toISOString()
  };
}

export function parseCodexChatGptAuthFile(value: string): CodexChatGptAuthFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored ChatGPT authentication is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.auth_mode !== "chatgpt" || !isRecord(parsed.tokens)) {
    throw new Error("Stored ChatGPT authentication has an unsupported format");
  }
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: requiredString(parsed.tokens.id_token, "id token"),
      access_token: requiredString(parsed.tokens.access_token, "access token"),
      refresh_token: requiredString(parsed.tokens.refresh_token, "refresh token"),
      account_id: requiredString(parsed.tokens.account_id, "account id")
    },
    last_refresh:
      typeof parsed.last_refresh === "string" && parsed.last_refresh.length > 0
        ? parsed.last_refresh
        : new Date(0).toISOString()
  };
}

export function serializeCodexChatGptAuthFile(auth: CodexChatGptAuthFile): string {
  return `${JSON.stringify(auth, null, 2)}\n`;
}

export function codexChatGptAuthSecrets(auth: CodexChatGptAuthFile): string[] {
  return [auth.tokens.id_token, auth.tokens.access_token, auth.tokens.refresh_token];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ChatGPT authentication is missing its ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

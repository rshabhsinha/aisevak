import { decryptSecret, parseCodexChatGptAuthFile, type DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { CodexAuthManager } from "./codexAuth.js";

const secretKey = Buffer.alloc(32, 7).toString("base64");

describe("CodexAuthManager", () => {
  it("completes device login and stores encrypted Codex authentication", async () => {
    const stored = new Map<string, string>();
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.startsWith("SELECT name")) {
          return {
            rows: [...stored].map(([name, encrypted_value]) => ({ name, encrypted_value }))
          };
        }
        if (sql.includes("INSERT INTO secrets")) {
          stored.set(String(params[0]), String(params[2]));
          return { rows: [] };
        }
        if (sql.startsWith("DELETE FROM secrets")) {
          stored.delete(String(params[0]));
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }
    } as unknown as DbPool;

    const accessToken = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123456" }
    });
    const idToken = jwt({ email: "owner@example.com", name: "Owner" });
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({ device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: 2 });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return jsonResponse({ authorization_code: "auth-code", code_verifier: "verifier" });
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token",
          id_token: idToken
        });
      }
      return jsonResponse({}, 404);
    };
    const manager = new CodexAuthManager(pool, secretKey, {
      authBaseUrl: "https://auth.example.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    const login = await manager.startDeviceLogin("user-id");
    expect(login.userCode).toBe("ABCD-EFGH");
    expect(login.verificationUrl).toBe("https://auth.example.test/codex/device");

    const result = await manager.pollDeviceLogin(login.loginId, "user-id");
    expect(result.status).toBe("connected");
    expect(result.auth).toMatchObject({
      connected: true,
      activeMethod: "chatgpt",
      email: "owner@example.com",
      accountIdSuffix: "123456"
    });

    const encrypted = stored.get("openai_codex_auth");
    expect(encrypted).toBeTruthy();
    const auth = parseCodexChatGptAuthFile(decryptSecret(encrypted!, secretKey));
    expect(auth.tokens).toMatchObject({
      access_token: accessToken,
      refresh_token: "refresh-token",
      account_id: "account-123456"
    });
  });

  it("aborts a stalled outbound OAuth request after the configured deadline", async () => {
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetchImpl = (_input: string | URL | Request, init?: RequestInit) => {
      observed.signal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const rejectAbort = () => reject(signal.reason);
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
    };
    const manager = new CodexAuthManager({} as DbPool, secretKey, {
      authBaseUrl: "https://auth.example.test",
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 10
    });

    await expect(manager.startDeviceLogin("user-id")).rejects.toMatchObject({
      name: "TimeoutError",
      message: "ChatGPT authentication request timed out after 10ms"
    });
    expect(observed.signal?.aborted).toBe(true);
  });
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

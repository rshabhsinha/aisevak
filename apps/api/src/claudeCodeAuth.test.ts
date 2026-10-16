import { CLAUDE_CODE_TOKEN_SECRET_NAME, decryptSecret, type DbPool } from "@aisevak/core";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAuthManager } from "./claudeCodeAuth.js";

const key = Buffer.alloc(32, 9).toString("base64");
const OAUTH = "sk-ant-oat01-example-subscription-token-WXYZ";
const API_KEY = "sk-ant-api03-example-console-key-ABCD";

function setup(check: (apiKey: string) => Promise<"valid" | "invalid" | "unknown"> = async () => "valid") {
  const stored = new Map<string, string>();
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("INSERT INTO secrets")) stored.set(String(params[0]), String(params[2]));
      if (sql.startsWith("DELETE")) stored.delete(String(params[0]));
      if (sql.startsWith("SELECT") && stored.has(String(params[0]))) {
        return { rows: [{ encrypted_value: stored.get(String(params[0])), updated_at: new Date("2026-10-16T00:00:00Z") }] };
      }
      return { rows: [] };
    }
  } as unknown as DbPool;
  const checkApiKey = vi.fn(check);
  return { stored, checkApiKey, manager: new ClaudeCodeAuthManager(pool, key, checkApiKey) };
}

describe("Claude Code credential management", () => {
  it("reports a disconnected harness when nothing is stored", async () => {
    const { manager } = setup();
    expect(await manager.getStatus()).toMatchObject({ connected: false, activeMethod: null, credentialHint: null });
  });

  it("stores a subscription token encrypted without calling the API", async () => {
    const { manager, stored, checkApiKey } = setup();
    const status = await manager.saveCredential(`  ${OAUTH}\n`);
    expect(status).toMatchObject({ connected: true, activeMethod: "subscription", credentialHint: "…WXYZ" });
    expect(checkApiKey).not.toHaveBeenCalled();
    const encrypted = stored.get(CLAUDE_CODE_TOKEN_SECRET_NAME);
    expect(encrypted).toBeDefined();
    expect(encrypted).not.toContain(OAUTH);
    expect(decryptSecret(encrypted!, key)).toBe(OAUTH);
  });

  it("verifies API keys and refuses ones Anthropic rejects", async () => {
    const rejected = setup(async () => "invalid");
    await expect(rejected.manager.saveCredential(API_KEY)).rejects.toThrow(/rejected this API key/);
    expect(rejected.stored.size).toBe(0);

    const accepted = setup(async () => "unknown");
    expect(await accepted.manager.saveCredential(API_KEY)).toMatchObject({ connected: true, activeMethod: "api_key" });
    expect(accepted.checkApiKey).toHaveBeenCalledWith(API_KEY);
  });

  it("refuses credentials that are not Claude tokens", async () => {
    const { manager, stored } = setup();
    await expect(manager.saveCredential("sk-proj-not-anthropic")).rejects.toThrow(/setup-token/);
    expect(stored.size).toBe(0);
  });

  it("forces the stored credential to stay hidden from agents", async () => {
    const queries: string[] = [];
    const pool = { async query(sql: string) { queries.push(sql); return { rows: [] }; } } as unknown as DbPool;
    await new ClaudeCodeAuthManager(pool, key, async () => "valid").saveCredential(OAUTH);
    const upsert = queries.find((sql) => sql.includes("INSERT INTO secrets"));
    expect(upsert).toMatch(/agent_accessible = false/);
    expect(queries.filter((sql) => sql.startsWith("SELECT")).every((sql) => sql.includes("agent_accessible = false"))).toBe(true);
  });

  it("disconnects by deleting the stored credential", async () => {
    const { manager, stored } = setup();
    await manager.saveCredential(OAUTH);
    expect(await manager.disconnect()).toMatchObject({ connected: false });
    expect(stored.size).toBe(0);
  });
});

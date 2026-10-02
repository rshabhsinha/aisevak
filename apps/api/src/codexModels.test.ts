import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { buildCodexChatGptAuthFile, encryptSecret, decryptSecret, CODEX_CHATGPT_AUTH_SECRET_NAME, type DbPool } from "@aisevak/core";
const mocks = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock("@aisevak/core", async importOriginal => ({ ...await importOriginal<typeof import("@aisevak/core")>(), discoverCodexModels: mocks.discover }));
import { discoverAuthenticatedCodexModels } from "./codexModels.js";
let root: string;
afterEach(async () => { vi.resetAllMocks(); if (root) await rm(root, {recursive:true, force:true}); });
describe("Codex model discovery homes", () => {
  it.each([false, true])("removes isolated scratch credentials after probe failure=%s", async failure => {
    root = await mkdtemp(join(tmpdir(), "aisevak-model-test-"));
    const pool = {query: vi.fn().mockResolvedValue({rows: []})} as unknown as DbPool;
    mocks.discover.mockImplementation(async ({env}) => {
      expect(env.CODEX_HOME).toContain(root);
      expect(env.HOME).toBe(env.CODEX_HOME);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      if (failure) throw new Error("probe failed");
      return [{id:"gpt-6.1-sol"}];
    });
    const probe = discoverAuthenticatedCodexModels(pool, {root, binary:"codex",secretKey:"unused"});
    if (failure) await expect(probe).rejects.toThrow("probe failed");
    else await expect(probe).resolves.toEqual([{id:"gpt-6.1-sol"}]);
    expect(await readdir(root)).toEqual([]);
  });
  it.each([false, true])("saves rotated tokens with a reconnect-safe CAS after failure=%s", async failure => {
    root = await mkdtemp(join(tmpdir(), "aisevak-model-auth-test-"));
    const secretKey = Buffer.alloc(32, 1).toString("base64");
    const auth = buildCodexChatGptAuthFile({accessToken:"old-access", refreshToken:"old-refresh",idToken:"id",accountId:"account"});
    const encrypted = encryptSecret(JSON.stringify(auth), secretKey);
    const query = vi.fn().mockResolvedValueOnce({rows:[{name:CODEX_CHATGPT_AUTH_SECRET_NAME,encrypted_value:encrypted}]}).mockResolvedValue({rows:[],rowCount:0});
    mocks.discover.mockImplementation(async ({env}) => {
      const saved = JSON.parse(await readFile(join(env.CODEX_HOME,"auth.json"),"utf8"));
      saved.tokens.refresh_token = "rotated-refresh";
      await writeFile(join(env.CODEX_HOME,"auth.json"),JSON.stringify(saved));
      if (failure) throw new Error("model list timed out after refresh");
      return [];
    });
    const probe = discoverAuthenticatedCodexModels({query} as unknown as DbPool, {root,binary:"codex",secretKey});
    if (failure) await expect(probe).rejects.toThrow("model list timed out after refresh"); else await probe;
    expect(query.mock.calls[1]?.[0]).toContain("AND encrypted_value = $3");
    const params = query.mock.calls[1]?.[1];
    expect(params[2]).toBe(encrypted);
    expect(JSON.parse(decryptSecret(params[1],secretKey)).tokens.refresh_token).toBe("rotated-refresh");
    expect(await readdir(root)).toEqual([]);
  });

});

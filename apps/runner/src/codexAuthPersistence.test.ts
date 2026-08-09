import {
  buildCodexChatGptAuthFile,
  decryptSecret,
  encryptSecret,
  parseCodexChatGptAuthFile,
  serializeCodexChatGptAuthFile,
  type DbPool
} from "@aisevak/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistRefreshedCodexAuth } from "./index.js";

const secretKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("refreshed ChatGPT authentication persistence", () => {
  it("updates the credential only while the loaded revision is still current", async () => {
    const original = auth("account-a", "original");
    const refreshed = auth("account-a", "refreshed");
    const originalEncrypted = encryptSecret(serializeCodexChatGptAuthFile(original), secretKey);
    const store = credentialStore(originalEncrypted);
    const codexHome = await authHome(refreshed);

    await expect(
      persistRefreshedCodexAuth(store.pool, codexHome, original, originalEncrypted)
    ).resolves.toBe(true);

    const persisted = parseCodexChatGptAuthFile(decryptSecret(expectEncrypted(store.value()), secretKey));
    expect(persisted.tokens.access_token).toBe("access-refreshed");
  });

  it("does not restore a credential disconnected while the run was active", async () => {
    const original = auth("account-a", "original");
    const originalEncrypted = encryptSecret(serializeCodexChatGptAuthFile(original), secretKey);
    const store = credentialStore(null);
    const codexHome = await authHome(auth("account-a", "refreshed"));

    await expect(
      persistRefreshedCodexAuth(store.pool, codexHome, original, originalEncrypted)
    ).resolves.toBe(false);
    expect(store.value()).toBeNull();
  });

  it("does not overwrite an account connected while the run was active", async () => {
    const original = auth("account-a", "original");
    const originalEncrypted = encryptSecret(serializeCodexChatGptAuthFile(original), secretKey);
    const replacement = auth("account-b", "replacement");
    const replacementEncrypted = encryptSecret(serializeCodexChatGptAuthFile(replacement), secretKey);
    const store = credentialStore(replacementEncrypted);
    const codexHome = await authHome(auth("account-a", "refreshed"));

    await expect(
      persistRefreshedCodexAuth(store.pool, codexHome, original, originalEncrypted)
    ).resolves.toBe(false);

    const persisted = parseCodexChatGptAuthFile(decryptSecret(expectEncrypted(store.value()), secretKey));
    expect(persisted.tokens.account_id).toBe("account-b");
    expect(persisted.tokens.access_token).toBe("access-replacement");
  });
});

function auth(accountId: string, suffix: string) {
  return buildCodexChatGptAuthFile({
    idToken: `id-${suffix}`,
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    accountId
  });
}

async function authHome(value: ReturnType<typeof auth>): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "aisevak-codex-auth-"));
  temporaryDirectories.push(path);
  await writeFile(join(path, "auth.json"), serializeCodexChatGptAuthFile(value), "utf8");
  return path;
}

function credentialStore(initialValue: string | null): {
  pool: DbPool;
  value: () => string | null;
} {
  let encryptedValue = initialValue;
  const pool = {
    async query(_sql: string, params: unknown[] = []) {
      if (encryptedValue === null || params[3] !== encryptedValue) return { rows: [], rowCount: 0 };
      encryptedValue = String(params[2]);
      return { rows: [{ id: "secret-1" }], rowCount: 1 };
    }
  } as unknown as DbPool;
  return { pool, value: () => encryptedValue };
}

function expectEncrypted(value: string | null): string {
  expect(value).not.toBeNull();
  return value as string;
}

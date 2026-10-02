import { CODEX_CHATGPT_AUTH_SECRET_NAME, decryptSecret, discoverCodexModels, encryptSecret,
  parseCodexChatGptAuthFile, serializeCodexChatGptAuthFile, type DbPool } from "@aisevak/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Discovery runs in a private disposable home, never the API user's read-only
// home or a chat's live runtime. Keep refreshed credentials with a CAS so a
// concurrent reconnect cannot be overwritten by this short-lived probe.
export async function discoverAuthenticatedCodexModels(pool: DbPool, options: {
  root: string; binary: string; secretKey: string;
}) {
  await mkdir(options.root, { recursive: true });
  const home = await mkdtemp(join(options.root, "codex-models-"));
  let retainHome = false;
  try {
    const stored = await pool.query<{ name: string; encrypted_value: string }>(
      "SELECT name, encrypted_value FROM secrets WHERE name IN ($1, 'openai_api_key')",
      [CODEX_CHATGPT_AUTH_SECRET_NAME]
    );
    const chat = stored.rows.find(row => row.name === CODEX_CHATGPT_AUTH_SECRET_NAME);
    const api = stored.rows.find(row => row.name === "openai_api_key");
    const auth = chat ? parseCodexChatGptAuthFile(decryptSecret(chat.encrypted_value, options.secretKey)) : null;
    if (auth) await writeFile(join(home, "auth.json"), serializeCodexChatGptAuthFile(auth), { mode: 0o600 });
    let probeFailed = false;
    try {
      return await discoverCodexModels({ codexBinary: options.binary, env: {
      ...process.env, HOME: home, CODEX_HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      OPENAI_API_KEY: !auth && api ? decryptSecret(api.encrypted_value, options.secretKey) : undefined
    } });
    } catch (error) { probeFailed = true; throw error; }
    finally {
      try {
    if (auth && chat) {
      const refreshed = parseCodexChatGptAuthFile(await readFile(join(home, "auth.json"), "utf8"));
      if (refreshed.tokens.account_id !== auth.tokens.account_id) throw new Error("Model probe changed ChatGPT accounts");
      if (serializeCodexChatGptAuthFile(refreshed) !== serializeCodexChatGptAuthFile(auth)) {
        await pool.query("UPDATE secrets SET encrypted_value = $2, updated_at = now() WHERE name = $1 AND encrypted_value = $3", [
          CODEX_CHATGPT_AUTH_SECRET_NAME, encryptSecret(serializeCodexChatGptAuthFile(refreshed), options.secretKey), chat.encrypted_value
        ]);
      }
    }
      } catch (error) {
        // Keep the private recovery copy if its rotated token cannot be saved.
        // A model-list failure remains the primary error; neither error logs
        // credential contents.
        retainHome = true;
        console.warn("Codex model probe could not save refreshed authentication; retained private recovery home");
        if (!probeFailed) throw error;
      }
    }
  } finally { if (!retainHome) await rm(home, { recursive: true, force: true }); }
}

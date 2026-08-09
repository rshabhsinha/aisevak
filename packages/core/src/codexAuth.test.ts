import { describe, expect, it } from "vitest";
import {
  buildCodexChatGptAuthFile,
  codexChatGptAuthSecrets,
  parseCodexChatGptAuthFile,
  serializeCodexChatGptAuthFile
} from "./codexAuth.js";

describe("Codex ChatGPT authentication", () => {
  it("builds the auth.json shape expected by Codex", () => {
    const auth = buildCodexChatGptAuthFile({
      idToken: "id-token",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accountId: "account-id"
    });

    expect(parseCodexChatGptAuthFile(serializeCodexChatGptAuthFile(auth))).toEqual(auth);
    expect(codexChatGptAuthSecrets(auth)).toEqual(["id-token", "access-token", "refresh-token"]);
  });

  it("rejects incomplete stored authentication", () => {
    expect(() =>
      parseCodexChatGptAuthFile(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }))
    ).toThrow("missing its id token");
  });
});

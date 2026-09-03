import { describe, expect, it } from "vitest";
import {
  openCodeAuthProviderIds,
  parseOpenCodeAuthFile,
  parseOpenCodeLoginUrl,
  parseOpenCodeModelList
} from "./opencode.js";

describe("OpenCode helpers", () => {
  it("reads provider ids from auth.json", () => {
    const auth = parseOpenCodeAuthFile(JSON.stringify({ opencode: { type: "api" }, anthropic: { type: "api" } }));
    expect(openCodeAuthProviderIds(auth).sort()).toEqual(["anthropic", "opencode"]);
  });

  it("parses model ids from CLI output", () => {
    const models = parseOpenCodeModelList("opencode/gpt-5.4-nano\nanthropic/claude-sonnet-4-6");
    expect(models.map((model) => model.id)).toEqual([
      "opencode/gpt-5.4-nano",
      "anthropic/claude-sonnet-4-6"
    ]);
  });

  it("extracts a login URL", () => {
    expect(parseOpenCodeLoginUrl("Visit https://opencode.ai/auth?code=1")).toBe(
      "https://opencode.ai/auth?code=1"
    );
  });
});

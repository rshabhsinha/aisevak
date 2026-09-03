import { describe, expect, it } from "vitest";
import {
  applyOpenCodeModelDefaults,
  fetchZenModelCatalog,
  openCodeAuthProviderIds,
  openCodeRouteOf,
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

  it("ignores CLI error output instead of inventing models", () => {
    expect(parseOpenCodeModelList("spawn opencode ENOENT")).toEqual([]);
    expect(parseOpenCodeModelList("opencode: command not found")).toEqual([]);
    expect(parseOpenCodeModelList("Error: Authentication required")).toEqual([]);
  });

  it("classifies billing routes from model ids", () => {
    expect(openCodeRouteOf("opencode/gpt-5.5")).toBe("zen");
    expect(openCodeRouteOf("opencode/big-pickle")).toBe("zen-free");
    expect(openCodeRouteOf("opencode-go/gpt-5.6-luna")).toBe("go");
    expect(openCodeRouteOf("anthropic/claude-opus-4-6")).toBe("custom");
  });

  it("tags zen and go badges while keeping the default", () => {
    const catalog = applyOpenCodeModelDefaults(
      [
        { id: "opencode/gpt-5.5", label: "GPT 5.5", description: "" },
        { id: "opencode/big-pickle", label: "Big Pickle", description: "" },
        { id: "opencode-go/gpt-5.6-luna", label: "GPT 5.6 Luna", description: "" }
      ],
      "opencode-go/gpt-5.6-luna"
    );
    expect(catalog.models.map((model) => [model.id, model.badge])).toEqual([
      ["opencode/gpt-5.5", "Zen"],
      ["opencode/big-pickle", "Zen Free"],
      ["opencode-go/gpt-5.6-luna", "Default"]
    ]);
    expect(catalog.models[0]?.description).toContain("Zen");
    expect(catalog.models[2]?.description).toContain("Go");
  });

  it("fetches zen ids with the opencode prefix", async () => {
    const models = await fetchZenModelCatalog({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-5.5" }, { id: "big-pickle" }] }), {
          status: 200
        })) as typeof fetch
    });
    expect(models.map((model) => model.id)).toEqual(["opencode/gpt-5.5", "opencode/big-pickle"]);
  });

  it("rejects failed zen catalog responses", async () => {
    await expect(
      fetchZenModelCatalog({
        fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch
      })
    ).rejects.toThrow(/status 500/);
  });
  it("extracts a login URL", () => {
    expect(parseOpenCodeLoginUrl("Visit https://opencode.ai/auth?code=1")).toBe(
      "https://opencode.ai/auth?code=1"
    );
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDevinModelDefaults,
  buildDevinAcpArgs,
  DEFAULT_DEVIN_MODEL,
  DEVIN_HARNESS_MODELS,
  devinCredentialsPath,
  materializeDevinAuthBundle,
  parseDevinAuthStatus,
  parseDevinLoginUrl,
  parseDevinModelList,
  parseDevinVersion
} from "./devin.js";

describe("Devin helpers", () => {
  it("parses logged-out auth status text", () => {
    const status = parseDevinAuthStatus(
      "Not logged in.\n  Credentials path: /home/u/.local/share/devin/credentials.toml\nRun `devin auth login` to authenticate.\n"
    );
    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.message).toMatch(/not authenticated/i);
  });

  it("parses authenticated auth status text", () => {
    const status = parseDevinAuthStatus("Logged in as user@example.com\nPlan: Core\n");
    expect(status.authenticated).toBe(true);
    expect(status.email).toBe("user@example.com");
  });

  it("detects missing binary from spawn errors", () => {
    const status = parseDevinAuthStatus("", "spawn devin ENOENT", 1);
    expect(status.installed).toBe(false);
    expect(status.authenticated).toBe(false);
  });

  it("parses the version banner", () => {
    expect(parseDevinVersion("devin 3000.6.19 (e2b252e2)\n")).toBe("3000.6.19");
  });

  it("extracts the manual login URL", () => {
    const url = parseDevinLoginUrl(
      "Visit https://app.devin.ai/auth/cli/continue?state=abc&code_challenge=xyz&code_challenge_method=S256 to sign in, then copy the code and paste it below."
    );
    expect(url).toBe(
      "https://app.devin.ai/auth/cli/continue?state=abc&code_challenge=xyz&code_challenge_method=S256"
    );
  });

  it("parses models from a JSON catalog payload", () => {
    const models = parseDevinModelList(
      JSON.stringify({
        families: [
          {
            name: "SWE",
            models: [
              { model_or_alias: "swe", model_uid: "swe-2", is_recommended: true, api_provider: "cognition" },
              { model_or_alias: "swe-1-7-lightning", api_provider: "cognition" }
            ]
          },
          { name: "Claude", models: [{ model_or_alias: "opus", api_provider: "anthropic" }] }
        ]
      })
    );
    expect(models.map((model) => model.id)).toEqual(["swe", "swe-1-7-lightning", "opus"]);
    expect(models[0]?.badge).toBe("Recommended");
  });

  it("parses models from a flat JSON array", () => {
    const models = parseDevinModelList(
      JSON.stringify([{ model_or_alias: "adaptive" }, { model_or_alias: "sonnet" }])
    );
    expect(models.map((model) => model.id)).toEqual(["adaptive", "sonnet"]);
  });

  it("falls back to line parsing for text output", () => {
    const models = parseDevinModelList("SWE\n  swe\n  swe-1-7-lightning\nClaude\n  opus\n");
    expect(models.map((model) => model.id)).toEqual(["swe", "swe-1-7-lightning", "opus"]);
  });

  it("ignores auth errors instead of inventing models", () => {
    expect(parseDevinModelList("Error: Not logged in. Run `devin auth login` to authenticate.")).toEqual([]);
    expect(parseDevinModelList("spawn devin ENOENT")).toEqual([]);
  });

  it("builds ACP args with and without a model", () => {
    expect(buildDevinAcpArgs()).toEqual(["acp"]);
    expect(buildDevinAcpArgs("auto")).toEqual(["acp"]);
    expect(buildDevinAcpArgs("swe")).toEqual(["acp", "--model", "swe"]);
  });

  it("applies the swe default to the fallback catalog", () => {
    const { defaultModel, models } = applyDevinModelDefaults([]);
    expect(defaultModel).toBe(DEFAULT_DEVIN_MODEL);
    expect(models.find((model) => model.id === "swe")?.badge).toBe("Default");
    expect(models).toHaveLength(DEVIN_HARNESS_MODELS.length);
  });
});

describe("materializeDevinAuthBundle", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "devin-auth-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes bundled home files", async () => {
    await materializeDevinAuthBundle(
      home,
      JSON.stringify({
        homeFiles: { ".local/share/devin/credentials.toml": "api_key = \"abc\"\n" }
      })
    );
    await expect(readFile(devinCredentialsPath(home), "utf8")).resolves.toBe('api_key = "abc"\n');
  });

  it("refuses paths that escape the home", async () => {
    await materializeDevinAuthBundle(
      home,
      JSON.stringify({ homeFiles: { "../outside.txt": "nope" } })
    );
    await expect(readFile(join(home, "..", "outside.txt"), "utf8")).rejects.toThrow();
  });
});

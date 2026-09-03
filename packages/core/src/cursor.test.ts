import { describe, expect, it } from "vitest";
import {
  cursorHostAuthBundle,
  isCursorHostAuthBundle,
  parseCursorAboutOutput,
  parseCursorLoginUrl,
  parseCursorModelList,
  parseCursorStatusOutput
} from "./cursor.js";

describe("Cursor helpers", () => {
  it("parses unauthenticated JSON about output", () => {
    const status = parseCursorAboutOutput(
      JSON.stringify({
        cliVersion: "2026.08.25",
        userEmail: null,
        subscriptionTier: "pro"
      })
    );
    expect(status.authenticated).toBe(false);
    expect(status.version).toBe("2026.08.25");
  });

  it("parses a login URL from CLI output", () => {
    expect(parseCursorLoginUrl("Open https://cursor.com/loginAbc to continue.")).toBe(
      "https://cursor.com/loginAbc"
    );
  });

  it("parses status JSON", () => {
    expect(
      parseCursorStatusOutput(
        JSON.stringify({ status: "unauthenticated", isAuthenticated: false, message: "Not logged in" })
      )
    ).toEqual({ authenticated: false, email: null, message: "Not logged in" });
  });

  it("recognizes host keychain auth bundles", () => {
    expect(isCursorHostAuthBundle(cursorHostAuthBundle())).toBe(true);
    expect(isCursorHostAuthBundle(JSON.stringify({ homeFiles: {} }))).toBe(false);
  });

  it("ignores authentication errors in model list output", () => {
    expect(parseCursorModelList("Error: Authentication required. Run 'agent login'\nauto\ncomposer-2")).toEqual([
      expect.objectContaining({ id: "auto" }),
      expect.objectContaining({ id: "composer-2" })
    ]);
  });

  it("parses model list lines", () => {
    const models = parseCursorModelList("auto\ncomposer-2  Composer 2\n");
    expect(models.map((model) => model.id)).toEqual(["auto", "composer-2"]);
  });
});

import { describe, expect, it } from "vitest";
import { contentPage, decodePageCursor, encodeCursor, pageLimit } from "./resources.js";

describe("resource pagination", () => {
  it("round-trips opaque list cursors", () => {
    const cursor = encodeCursor({ at: "2026-08-09T10:00:00.000Z", id: "abc" });
    expect(decodePageCursor(cursor)).toEqual({ at: "2026-08-09T10:00:00.000Z", id: "abc" });
  });

  it("pages UTF-8 content without splitting a character", () => {
    const markdown = `${"x".repeat(255)}🙂${"y".repeat(300)}`;
    const first = contentPage(markdown, { maxBytes: 256, revision: "7" });
    const second = contentPage(markdown, { cursor: first.nextCursor!, maxBytes: 256, revision: "7" });
    const third = contentPage(markdown, { cursor: second.nextCursor!, maxBytes: 256, revision: "7" });
    expect(first.content + second.content + third.content).toBe(markdown);
    expect(first.content).not.toContain("�");
  });

  it("rejects stale content cursors and clamps list limits", () => {
    const first = contentPage("x".repeat(500), { maxBytes: 256, revision: "1" });
    expect(() => contentPage("changed", { cursor: first.nextCursor!, revision: "2" })).toThrow(/stale/);
    expect(pageLimit("1000")).toBe(100);
  });
});

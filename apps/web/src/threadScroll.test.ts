import { describe, expect, it } from "vitest";
import { isThreadScrollNearBottom } from "./threadScroll.js";

describe("thread scroll position", () => {
  it("treats the last few pixels as pinned to the newest message", () => {
    expect(isThreadScrollNearBottom({ scrollHeight: 1_000, scrollTop: 430, clientHeight: 500 })).toBe(true);
  });

  it("detects when the reader has scrolled up", () => {
    expect(isThreadScrollNearBottom({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 500 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { appPath, parseAppRoute } from "./appRouting.js";

describe("app routing", () => {
  it.each([
    ["/tasks", "tasks"],
    ["/activity", "activity"],
    ["/incidents/", "incidents"],
    ["/settings/chatgpt", "codex"],
    ["/settings/api", "api"]
  ])("restores %s as the %s view", (path, view) => {
    expect(parseAppRoute(path)).toMatchObject({ view, threadId: null });
  });

  it("preserves a selected thread in the URL", () => {
    expect(parseAppRoute("/threads/thread%20id")).toEqual({
      view: "runs",
      threadId: "thread id",
      path: "/threads/thread%20id"
    });
  });

  it("normalizes the root and unknown paths to threads", () => {
    expect(parseAppRoute("/")).toEqual({ view: "runs", threadId: null, path: "/threads" });
    expect(parseAppRoute("/missing")).toEqual({ view: "runs", threadId: null, path: "/threads" });
  });

  it("builds stable paths for navigation", () => {
    expect(appPath("credentials")).toBe("/settings/credentials");
    expect(appPath("runs", "thread/1")).toBe("/threads/thread%2F1");
  });
});

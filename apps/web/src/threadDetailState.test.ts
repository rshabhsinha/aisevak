import { describe, expect, it } from "vitest";
import {
  threadDetailFailed,
  threadDetailIdle,
  threadDetailLoading,
  threadDetailReady
} from "./threadDetailState";

describe("thread detail state", () => {
  it("represents loading and ready states explicitly", () => {
    expect(threadDetailIdle()).toEqual({ status: "idle", error: null });
    expect(threadDetailLoading()).toEqual({ status: "loading", error: null });
    expect(threadDetailReady()).toEqual({ status: "ready", error: null });
  });

  it("keeps a request failure visible for retry instead of treating it as empty data", () => {
    expect(threadDetailFailed(new Error("temporary API failure"))).toEqual({
      status: "error",
      error: "temporary API failure"
    });
    expect(threadDetailFailed("unexpected failure")).toEqual({
      status: "error",
      error: "Failed to load this thread."
    });
  });
});

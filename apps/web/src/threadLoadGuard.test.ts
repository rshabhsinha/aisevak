import { describe, expect, it } from "vitest";
import { createThreadLoadGuard } from "./threadLoadGuard";

describe("thread load guard", () => {
  it("rejects a response from the previously selected thread", () => {
    const guard = createThreadLoadGuard();
    guard.select("thread-a");
    const applyThreadA = guard.begin("thread-a");

    guard.select("thread-b");
    const applyThreadB = guard.begin("thread-b");

    expect(applyThreadA()).toBe(false);
    expect(applyThreadB()).toBe(true);
  });

  it("only accepts the newest request for the current thread", () => {
    const guard = createThreadLoadGuard();
    guard.select("thread-a");
    const applyOlderRequest = guard.begin("thread-a");
    const applyNewerRequest = guard.begin("thread-a");

    expect(applyOlderRequest()).toBe(false);
    expect(applyNewerRequest()).toBe(true);
  });

  it("accepts the first request for an initially selected deep-link thread", () => {
    const guard = createThreadLoadGuard("thread-from-route");
    const applyInitialRequest = guard.begin("thread-from-route");

    expect(applyInitialRequest()).toBe(true);
  });

  it("does not let a stale selection begin invalidate the current request", () => {
    const guard = createThreadLoadGuard("thread-a");
    const applyCurrentRequest = guard.begin("thread-a");
    guard.select("thread-b");
    const applyStaleRequest = guard.begin("thread-a");
    const applyNewRequest = guard.begin("thread-b");

    expect(applyStaleRequest()).toBe(false);
    expect(applyCurrentRequest()).toBe(false);
    expect(applyNewRequest()).toBe(true);
  });
});

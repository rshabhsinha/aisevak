import { describe, expect, it } from "vitest";
import { parseUsageLimit, usageLimitRetryAt, withUsageLimitPreamble, USAGE_LIMIT_PREAMBLE } from "./providerLimits.js";

const now = new Date("2026-10-29T07:50:00Z");

describe("parseUsageLimit", () => {
  it("reads a Claude Code session limit reset in UTC, after ACP diagnostics", () => {
    const error = "[session/load] sessionId=7f05 phase=replay durationMs=695 totalMs=924 Internal error: You've hit your session limit · resets 8:50am (UTC)";
    expect(parseUsageLimit(error, now)).toEqual({ resetAt: new Date("2026-10-29T08:50:00Z") });
  });

  it("rolls a time well past today over to tomorrow", () => {
    expect(parseUsageLimit("You've hit your weekly limit · resets 3am (UTC)", now)?.resetAt).toEqual(new Date("2026-10-30T03:00:00Z"));
  });

  it("treats a reset that just passed as over, not as tomorrow's", () => {
    const late = new Date("2026-10-29T08:50:20Z");
    expect(parseUsageLimit("You've hit your session limit · resets 8:50am (UTC)", late)?.resetAt).toEqual(late);
  });

  it("reads the last limit message when earlier output holds an older one", () => {
    const error = "You've hit your session limit · resets 8:50am (UTC)\n...\nYou've hit your weekly limit · resets Nov 2, 4pm (UTC)";
    expect(parseUsageLimit(error, now)?.resetAt).toEqual(new Date("2026-11-02T16:00:00Z"));
  });

  it("recognises unqualified and hour-window limits", () => {
    expect(parseUsageLimit("You've hit your limit · resets 3pm (UTC)", now)?.resetAt).toEqual(new Date("2026-10-29T15:00:00Z"));
    expect(parseUsageLimit("5-hour limit reached ∙ resets 3pm (UTC)", now)?.resetAt).toEqual(new Date("2026-10-29T15:00:00Z"));
  });

  it("reads relative and epoch resets", () => {
    expect(parseUsageLimit("You've hit your usage limit. try again in 4 days 3 hours 12 minutes.", now)?.resetAt)
      .toEqual(new Date(now.getTime() + ((4 * 24 + 3) * 60 + 12) * 60_000));
    expect(parseUsageLimit("You've hit your usage limit, try again in 2h 5m", now)?.resetAt).toEqual(new Date(now.getTime() + 125 * 60_000));
    expect(parseUsageLimit("Claude AI usage limit reached|1793266200", now)?.resetAt).toEqual(new Date(1793266200 * 1000));
  });

  it("reads a dated Claude reset", () => {
    expect(parseUsageLimit("You’ve hit your weekly limit · resets Nov 2, 4pm (UTC)", now)?.resetAt).toEqual(new Date("2026-11-02T16:00:00Z"));
  });

  it("recognises a limit in another zone without guessing its reset", () => {
    expect(parseUsageLimit("You've hit your session limit · resets 8:50am (America/New_York)", now)).toEqual({ resetAt: null });
  });

  it("reads Codex usage limits in the host's local time", () => {
    const dated = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 30th, 2026 4:12 PM.";
    expect(parseUsageLimit(dated, now)?.resetAt).toEqual(new Date(2026, 9, 30, 16, 12));
    const local = new Date(2026, 9, 29, 7, 50);
    expect(parseUsageLimit("You've hit your usage limit. ... try again at 9:05 AM.", local)?.resetAt).toEqual(new Date(2026, 9, 29, 9, 5));
  });

  it("does not trust a reset in the past or more than eight days ahead", () => {
    expect(parseUsageLimit("You've hit your usage limit. try again at Sep 26th, 2026 4:12 PM.", now)).toEqual({ resetAt: null });
    expect(parseUsageLimit("You've hit your usage limit. try again at Dec 26th, 2026 4:12 PM.", now)).toEqual({ resetAt: null });
  });

  it("ignores ordinary failures and rate-limit noise", () => {
    expect(parseUsageLimit("app-server exited before turn completed with code 0", now)).toBeNull();
    expect(parseUsageLimit("429 Too Many Requests: rate limit, retry in 5s", now)).toBeNull();
    expect(parseUsageLimit("", now)).toBeNull();
  });
});

describe("usageLimitRetryAt", () => {
  it("wakes a little after the reset, spread by jitter", () => {
    const resetAt = new Date("2026-10-29T08:50:00Z");
    expect(usageLimitRetryAt({ resetAt }, 0, now, 0)).toEqual(new Date("2026-10-29T08:52:00Z"));
    expect(usageLimitRetryAt({ resetAt }, 0, now, 0.5)).toEqual(new Date("2026-10-29T08:53:30Z"));
  });

  it("backs off 15, 30, 60, 120, 240 then 360 minutes without a reset time", () => {
    const minutes = [0, 1, 2, 3, 4, 5, 9].map((waits) => (usageLimitRetryAt({ resetAt: null }, waits, now, 0).getTime() - now.getTime()) / 60000);
    expect(minutes).toEqual([15, 30, 60, 120, 240, 360, 360]);
  });
});

it("adds the usage-limit note once", () => {
  const once = withUsageLimitPreamble("review it");
  expect(once.startsWith(USAGE_LIMIT_PREAMBLE)).toBe(true);
  expect(withUsageLimitPreamble(once)).toBe(once);
});

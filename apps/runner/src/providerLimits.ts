// Recognises a provider usage-limit failure (Claude Code session/weekly
// limits, Codex usage limits) in a failed turn's error text and reads the
// reset time the provider printed, so the delivery can wait for the reset
// instead of being marked failed.

export interface UsageLimit {
  /** When the provider says the limit resets, or null when it gave none we can read. */
  resetAt: Date | null;
}

const LIMIT_PATTERNS = [
  /you(?:'|’)ve hit your (?:[\w-]+ )?limit/gi,
  /\b(?:usage|session|weekly|daily|\d+-hour) limit reached\b/gi,
  /\busageLimitExceeded\b/g
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// A printed reset further away than this is not trusted (a parse error, or a
// limit we should not silently wait out); the caller falls back to backoff.
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
// An undated printed time up to this far in the past is today's reset that has
// just passed, not tomorrow's.
const RECENT_PAST_MS = 60 * 60 * 1000;

export function parseUsageLimit(error: string, now: Date = new Date()): UsageLimit | null {
  if (!error) return null;
  // Read the reset from the last limit message: earlier text may be an older
  // limit that has since reset.
  let last = -1;
  for (const pattern of LIMIT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of error.matchAll(pattern)) last = Math.max(last, match.index ?? -1);
  }
  if (last < 0) return null;
  const tail = error.slice(last);
  const resetAt = parseEpochReset(tail, now) ?? parseClaudeReset(tail, now) ?? parseCodexReset(tail, now) ?? parseRelativeReset(tail, now);
  if (!resetAt) return { resetAt: null };
  const ahead = resetAt.getTime() - now.getTime();
  if (ahead > MAX_RESET_AHEAD_MS || ahead < -RECENT_PAST_MS) return { resetAt: null };
  // A reset that has just passed (rounded to the minute, or read late) means
  // the limit is over: retry shortly rather than a day later.
  return { resetAt: ahead > 0 ? resetAt : now };
}

// Older Claude Code: "Claude AI usage limit reached|1761728400" (epoch seconds).
function parseEpochReset(error: string, now: Date): Date | null {
  const match = /usage limit reached\|(\d{10})\b/i.exec(error);
  if (!match) return null;
  const resetAt = new Date(Number(match[1]) * 1000);
  return resetAt.getTime() > now.getTime() - RECENT_PAST_MS ? resetAt : null;
}

// Codex: "try again in 4 days 3 hours 12 minutes" / "try again in 2h 5m".
function parseRelativeReset(error: string, now: Date): Date | null {
  const match = /try again in\s+((?:\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)[\s,]*(?:and\s+)?)+)/i.exec(error);
  if (!match) return null;
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  let ms = 0;
  for (const part of match[1]!.matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(part[1]) * units[part[2]!.toLowerCase()]!;
  return ms > 0 ? new Date(now.getTime() + ms) : null;
}

function hour24(hour: number, meridiem: string): number {
  const pm = meridiem.toLowerCase() === "pm";
  return (hour % 12) + (pm ? 12 : 0);
}

// Today's printed time, unless it is well in the past, in which case it means
// the same time tomorrow.
function nextOccurrence(today: Date, now: Date): Date {
  return today.getTime() > now.getTime() - RECENT_PAST_MS ? today : new Date(today.getTime() + 24 * 60 * 60 * 1000);
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

// Claude Code: "You've hit your session limit · resets 8:50am (UTC)",
// "resets 3pm (UTC)", "resets Nov 7, 3pm (UTC)". Only UTC is read; another
// zone name returns null so the caller backs off instead of guessing.
function parseClaudeReset(error: string, now: Date): Date | null {
  const match = /resets\s+(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(error);
  if (!match) return null;
  const [, monthName, day, hour, minute, meridiem, zone] = match;
  if (zone && !/^(utc|gmt|etc\/utc)$/i.test(zone.trim())) return null;
  const h = hour24(Number(hour), meridiem!);
  const m = Number(minute ?? 0);
  if (monthName && day) {
    const month = monthIndex(monthName);
    if (month < 0) return null;
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), month, Number(day), h, m));
    if (candidate.getTime() > now.getTime() - RECENT_PAST_MS) return candidate;
    return new Date(Date.UTC(now.getUTCFullYear() + 1, month, Number(day), h, m));
  }
  return nextOccurrence(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m)), now);
}

// Codex: "try again at Sep 26th, 2026 4:12 PM." or "try again at 3:34 AM."
// Codex prints the runner host's local time, which is this process's zone.
function parseCodexReset(error: string, now: Date): Date | null {
  const match = /try again at\s+(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(error);
  if (!match) return null;
  const [, monthName, day, year, hour, minute, meridiem] = match;
  const h = hour24(Number(hour), meridiem!);
  const m = Number(minute);
  if (monthName && day && year) {
    const month = monthIndex(monthName);
    if (month < 0) return null;
    return new Date(Number(year), month, Number(day), h, m);
  }
  return nextOccurrence(new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m), now);
}

// After a limit, give the provider a moment past its reset, spread wakeups so
// every waiting delivery does not hit the provider in the same second, and
// back off (15, 30, 60, 120, 240, then 360 min) when no reset time was printed.
export function usageLimitRetryAt(limit: UsageLimit, waits: number, now: Date = new Date(), jitter = Math.random()): Date {
  const spreadMs = Math.floor(jitter * 3 * 60 * 1000);
  if (limit.resetAt) return new Date(limit.resetAt.getTime() + 2 * 60 * 1000 + spreadMs);
  const backoffMinutes = Math.min(360, 15 * 2 ** Math.max(0, waits));
  return new Date(now.getTime() + backoffMinutes * 60 * 1000 + spreadMs);
}

/**
 * Waits past this count fall back to the ordinary failure path. With the
 * backoff above that is about five days without a printed reset, enough for a
 * weekly limit; a printed reset is always waited for within MAX_RESET_AHEAD_MS.
 */
export const MAX_USAGE_LIMIT_WAITS = 24;

export const USAGE_LIMIT_PREAMBLE =
  "Aisevak note: your previous turn on this message stopped because the model provider's usage limit was reached. " +
  "This is the same message, delivered again after the limit reset. Check what you already did before you continue, and do not repeat completed side effects.";

export function withUsageLimitPreamble(message: string): string {
  return message.startsWith(USAGE_LIMIT_PREAMBLE) ? message : `${USAGE_LIMIT_PREAMBLE}\n\n${message}`;
}

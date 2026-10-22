import { clipText, displayText } from "@aisevak/core";

/** Tool output sent per event in a timeline; the rest loads on demand. */
export const MAX_TIMELINE_OUTPUT_CHARS = 16 * 1024;
/** Upper bound for the on-demand full output of one event. */
export const MAX_FULL_OUTPUT_CHARS = 1024 * 1024;
// Tool inputs (a Write's whole file, an Edit's texts) are not rendered by the
// timeline; small ones stay for debugging, large ones are dropped.
const MAX_TIMELINE_INPUT_CHARS = 4 * 1024;

type JsonRecord = Record<string, unknown>;

interface TimelineEventLike {
  text?: string | null;
  payload: unknown;
}

/**
 * Shape a stored event for the timeline: drop the raw provider message, which
 * repeats the normalized fields, and clip tool output. Stored rows can hold
 * megabytes per event (inline images, full command output).
 */
export function slimTimelineEvent<T extends TimelineEventLike>(event: T): T {
  const text = typeof event.text === "string" && event.text.length > MAX_TIMELINE_OUTPUT_CHARS
    ? clipText(event.text, MAX_TIMELINE_OUTPUT_CHARS).text
    : event.text;
  return { ...event, text, payload: slimTimelinePayload(event.payload) };
}

export function slimTimelinePayload(payload: unknown): unknown {
  const record = recordValue(payload);
  if (!record || record.v !== 2) return payload;
  const { raw: _raw, ...rest } = record;
  const item = recordValue(rest.item);
  if (!item) return rest;
  const slimItem: JsonRecord = { ...item };
  if (typeof item.output === "string") {
    const clipped = clipText(readableOutput(item.output), MAX_TIMELINE_OUTPUT_CHARS);
    slimItem.output = clipped.text;
    const omitted = numberValue(item.outputOmittedChars) + clipped.omittedChars;
    if (omitted > 0) slimItem.outputOmittedChars = omitted;
  }
  if (item.input !== undefined && jsonChars(item.input) > MAX_TIMELINE_INPUT_CHARS) delete slimItem.input;
  return { ...rest, item: slimItem };
}

/** The stored tool output of one event, readable and bounded, for "load full output". */
export function fullTimelineOutput(payload: unknown): { output: string; omittedChars: number } | null {
  const item = recordValue(recordValue(payload)?.item);
  if (typeof item?.output !== "string") return null;
  const clipped = clipText(readableOutput(item.output), MAX_FULL_OUTPUT_CHARS);
  return { output: clipped.text, omittedChars: numberValue(item.outputOmittedChars) + clipped.omittedChars };
}

/**
 * Rows stored before image blocks were summarized hold tool results as
 * pretty-printed JSON with inline base64; render those like new rows.
 */
function readableOutput(output: string): string {
  if (output.length <= MAX_TIMELINE_OUTPUT_CHARS || !/^\s*[[{]/.test(output)) return output;
  try {
    return displayText(JSON.parse(output)) ?? output;
  } catch {
    return output;
  }
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

import type { RuntimeEvent } from "./events.js";

/** Largest tool output persisted per event; longer output keeps its head and tail. */
export const MAX_STORED_OUTPUT_CHARS = 256 * 1024;
/** Largest provider message kept under `raw`; the normalized fields already carry its content. */
export const MAX_STORED_RAW_CHARS = 16 * 1024;

/**
 * Keep the head and tail of `text` within `maxChars`. Command output tends to
 * put context first and errors last, so both ends survive.
 */
export function clipText(text: string, maxChars: number): { text: string; omittedChars: number } {
  if (text.length <= maxChars) return { text, omittedChars: 0 };
  const tailChars = Math.floor(maxChars / 4);
  const headChars = maxChars - tailChars;
  const omittedChars = text.length - headChars - tailChars;
  return {
    text: `${text.slice(0, headChars)}\n\n… ${omittedChars.toLocaleString("en-US")} characters omitted …\n\n${text.slice(text.length - tailChars)}`,
    omittedChars
  };
}

/** Clip a runtime event's tool output and raw provider message to the storage limits. */
export function boundRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  let bounded = event;
  const output = event.item?.output;
  if (output && output.length > MAX_STORED_OUTPUT_CHARS) {
    const clipped = clipText(output, MAX_STORED_OUTPUT_CHARS);
    bounded = {
      ...bounded,
      item: {
        ...event.item!,
        output: clipped.text,
        outputOmittedChars: (event.item!.outputOmittedChars ?? 0) + clipped.omittedChars
      }
    };
  }
  if (!keepsRawPayload(event)) {
    // The normalized fields already carry this message's content; a second
    // copy of every tool result was most of the event table.
    if (event.raw.payload !== undefined) bounded = { ...bounded, raw: compactRaw(event.raw) };
    return bounded;
  }
  const rawChars = rawPayloadChars(event.raw.payload);
  if (rawChars > MAX_STORED_RAW_CHARS) {
    bounded = { ...bounded, raw: { ...event.raw, payload: { omitted: true, chars: rawChars } } };
  }
  return bounded;
}

/**
 * Events whose raw provider message is still read after it is stored: usage
 * analytics (usage.updated, turn.completed), rate-limit lookups (Codex
 * account/rateLimits/updated arrives as provider.event), and events the
 * adapter could not normalize, whose raw message is their only content.
 */
export function keepsRawPayload(event: Pick<RuntimeEvent, "type">): boolean {
  return RAW_PAYLOAD_EVENT_TYPES.has(event.type);
}

const RAW_PAYLOAD_EVENT_TYPES = new Set<RuntimeEvent["type"]>([
  "usage.updated",
  "turn.completed",
  "provider.event",
  "parse.error",
  "runtime.error"
]);

function compactRaw(raw: RuntimeEvent["raw"]): RuntimeEvent["raw"] {
  return raw.method === undefined ? { source: raw.source } : { source: raw.source, method: raw.method };
}

function rawPayloadChars(payload: unknown): number {
  if (typeof payload === "string") return payload.length;
  try {
    return JSON.stringify(payload)?.length ?? 0;
  } catch {
    return 0;
  }
}

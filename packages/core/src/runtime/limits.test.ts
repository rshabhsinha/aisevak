import { describe, expect, it } from "vitest";
import { boundRuntimeEvent, clipText, MAX_STORED_OUTPUT_CHARS, MAX_STORED_RAW_CHARS } from "./limits.js";
import { createRuntimeNormalizer } from "./normalizer.js";
import { displayText } from "./util.js";

const PNG_BASE64 = "iVBORw0KGgo".padEnd(400_000, "A");

function imageReadLine(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_read",
        status: "completed",
        rawOutput: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } }]
      }
    }
  });
}

describe("tool output images", () => {
  it("renders content blocks as text with image placeholders", () => {
    expect(
      displayText([
        { type: "text", text: "Rendered board" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        { type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" }
      ])
    ).toBe("Rendered board\n[image: image/png, 293 KB]\n[image: image/jpeg, 6 B]");
  });

  it("replaces long base64 strings inside other JSON results", () => {
    const text = displayText({ file: { name: "a.png", bytes: PNG_BASE64 } })!;
    expect(text).toContain('"bytes": "[base64 data, 293 KB]"');
    expect(text.length).toBeLessThan(200);
  });

  it("stores an ACP image read as a placeholder instead of base64", () => {
    const event = createRuntimeNormalizer("claude").normalize(imageReadLine())!;
    expect(event.item?.output).toBe("[image: image/png, 293 KB]");
    expect(JSON.stringify(event).length).toBeLessThan(MAX_STORED_RAW_CHARS);
    expect(event.raw.payload).toEqual({ omitted: true, chars: expect.any(Number) });
    expect(event.raw.method).toBe("session/update");
  });
});

describe("boundRuntimeEvent", () => {
  it("keeps the head and tail of oversized output and counts what it cut", () => {
    const output = `${"a".repeat(MAX_STORED_OUTPUT_CHARS)}${"z".repeat(1000)}`;
    const bounded = boundRuntimeEvent({
      v: 2,
      type: "item.completed",
      provider: "codex",
      item: { itemType: "command_execution", status: "completed", output },
      raw: { source: "codex.app-server", payload: { small: true } }
    });
    expect(bounded.item?.output?.startsWith("aaa")).toBe(true);
    expect(bounded.item?.output?.endsWith("zzz")).toBe(true);
    expect(bounded.item?.outputOmittedChars).toBe(output.length - MAX_STORED_OUTPUT_CHARS);
    expect(bounded.raw.payload).toEqual({ small: true });
  });

  it("leaves small events untouched", () => {
    const event = {
      v: 2 as const,
      type: "usage.updated" as const,
      provider: "codex" as const,
      raw: { source: "codex.app-server" as const, payload: { method: "thread/tokenUsage/updated" } }
    };
    expect(boundRuntimeEvent(event)).toBe(event);
  });

  it("clips text without exceeding the limit by more than the marker", () => {
    const clipped = clipText("x".repeat(10_000), 1000);
    expect(clipped.omittedChars).toBe(9000);
    expect(clipped.text.length).toBeLessThan(1100);
  });
});

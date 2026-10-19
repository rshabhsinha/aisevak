import { describe, expect, it } from "vitest";
import { appendAttachmentBlock, findMessageAttachments, isImageAttachment, splitAttachmentBlock } from "./messageAttachments.js";

const shot = { id: "a1", name: "shot.png", mimeType: "image/png", size: 12, path: "/srv/aisevak/attachments/a1/shot.png" };
const notes = { id: "b2", name: "notes.txt", mimeType: "text/plain", size: 5, path: "/srv/aisevak/attachments/b2/notes.txt" };

describe("message attachments", () => {
  it("round-trips the trailing block", () => {
    const text = appendAttachmentBlock("hello", [shot, notes]);
    expect(splitAttachmentBlock(text)).toEqual({ text: "hello", attachments: [shot, notes] });
    expect(appendAttachmentBlock("hello", [])).toBe("hello");
  });

  it("finds blocks wrapped in a larger prompt and de-duplicates paths", () => {
    const prompt = [
      "# Envelope",
      appendAttachmentBlock("first", [shot]),
      "more instructions",
      appendAttachmentBlock("second", [shot, notes]),
      "trailer"
    ].join("\n");
    expect(splitAttachmentBlock(prompt).attachments).toEqual([]);
    expect(findMessageAttachments(prompt)).toEqual([shot, notes]);
    expect(findMessageAttachments("no attachments here")).toEqual([]);
  });

  it("recognizes image mime types", () => {
    expect(isImageAttachment(shot)).toBe(true);
    expect(isImageAttachment({ mimeType: "IMAGE/JPEG" })).toBe(true);
    expect(isImageAttachment(notes)).toBe(false);
    expect(isImageAttachment({ mimeType: "image/svg+xml" })).toBe(false);
  });
});

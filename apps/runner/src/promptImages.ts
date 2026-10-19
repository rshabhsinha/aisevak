import { findMessageAttachments, isImageAttachment } from "@aisevak/core";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize } from "node:path";

// Image attachments referenced in a prompt's <attachments> block, handed to
// harnesses as native image input alongside the text (which keeps the paths,
// so agents can still open the files themselves).

export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PromptImage {
  path: string;
  mimeType: string;
  size: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only files the attachments API stored (<root>/attachments/<id>/<name>) are
// eligible, so a hand-typed block cannot turn an arbitrary file into model input.
function isStoredAttachmentPath(path: string, id: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  const directory = dirname(path);
  return UUID.test(id) && basename(directory) === id && basename(dirname(directory)) === "attachments";
}

/** Detect the real image type from magic bytes; the block's mime type is only a hint. */
export function sniffImageMimeType(head: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function promptImages(text: string, maxBytes = MAX_PROMPT_IMAGE_BYTES): Promise<PromptImage[]> {
  const candidates = findMessageAttachments(text).filter(
    (file) => isImageAttachment(file) && isStoredAttachmentPath(file.path, file.id)
  );
  const images: PromptImage[] = [];
  for (const file of candidates) {
    const handle = await open(file.path, "r").catch(() => null);
    if (!handle) continue; // Deleted since the message was sent.
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) continue;
      const head = new Uint8Array(16);
      await handle.read(head, 0, head.length, 0);
      const mimeType = sniffImageMimeType(head);
      if (mimeType) images.push({ path: file.path, mimeType, size: stats.size });
    } finally {
      await handle.close();
    }
  }
  return images;
}

/** Codex app-server v2 `UserInput` items for a prompt. */
export async function codexUserInput(text: string): Promise<Array<Record<string, unknown>>> {
  const images = await promptImages(text);
  return [
    { type: "text", text, text_elements: [] },
    ...images.map((image) => ({ type: "localImage", path: image.path }))
  ];
}

/** ACP `ContentBlock`s for a prompt; images only when the agent advertised support. */
export async function acpPromptContent(
  text: string,
  supportsImages: boolean
): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (!supportsImages) return blocks;
  for (const image of await promptImages(text)) {
    const data = await readFile(image.path).catch(() => null);
    if (data) blocks.push({ type: "image", mimeType: image.mimeType, data: data.toString("base64") });
  }
  return blocks;
}

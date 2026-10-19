import { findMessageAttachments, isImageAttachment } from "@aisevak/core";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// Image attachments referenced in a prompt's <attachments> block, handed to
// harnesses as native image input alongside the text (which keeps the paths,
// so agents can still open the files themselves).

export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 8;
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

export interface PromptImage {
  path: string;
  mimeType: string;
  size: number;
  /** File bytes, read from the same handle that was checked (only when requested). */
  data?: Buffer;
}

export interface PromptImageOptions {
  /** MANAGED_ROOT; images must live in <root>/attachments/<id>/. Defaults to the runner's. */
  managedRoot?: string;
  maxBytes?: number;
  maxImages?: number;
  maxTotalBytes?: number;
  withData?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultManagedRoot(): string {
  return resolve(process.env.MANAGED_ROOT ?? "/srv/aisevak");
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

/**
 * The stored images a prompt references. Only regular files the attachments
 * API wrote (<root>/attachments/<id>/<name>, no symlinks anywhere on the path)
 * qualify, so a hand-typed block cannot turn an arbitrary file into model
 * input. Never throws: an unreadable image is skipped and the text still goes.
 */
export async function promptImages(text: string, options: PromptImageOptions = {}): Promise<PromptImage[]> {
  const maxBytes = options.maxBytes ?? MAX_PROMPT_IMAGE_BYTES;
  const maxImages = options.maxImages ?? MAX_PROMPT_IMAGES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_PROMPT_IMAGE_TOTAL_BYTES;
  // The API writes paths under resolve(MANAGED_ROOT), which may itself sit
  // behind a symlink (/srv → /data/srv, macOS /var → /private/var). Allow
  // symlinks above the attachments root, never below it.
  const literalRoot = join(resolve(options.managedRoot ?? defaultManagedRoot()), "attachments");
  let realRoot: string;
  try {
    realRoot = await realpath(literalRoot);
  } catch {
    return [];
  }

  const images: PromptImage[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const file of findMessageAttachments(text)) {
    if (images.length >= maxImages) break;
    if (!isImageAttachment(file) || !UUID.test(file.id) || seen.has(file.path)) continue;
    seen.add(file.path);
    try {
      if (resolve(file.path) !== file.path || dirname(file.path) !== join(literalRoot, file.id)) continue;
      // Resolving must not leave <root>/attachments/<id>/<name>: no symlinked
      // id folder or file.
      const real = await realpath(file.path);
      if (real !== join(realRoot, file.id, basename(file.path))) continue;
      const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) continue;
        if (totalBytes + stats.size > maxTotalBytes) continue;
        const head = new Uint8Array(16);
        await handle.read(head, 0, head.length, 0);
        const mimeType = sniffImageMimeType(head);
        if (!mimeType) continue;
        const data = options.withData ? await handle.readFile() : undefined;
        if (data && data.length !== stats.size) continue;
        totalBytes += stats.size;
        images.push({ path: real, mimeType, size: stats.size, ...(data ? { data } : {}) });
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      // Deleted, unreadable, or a symlink: send the text without it.
    }
  }
  return images;
}

/** Codex app-server v2 `UserInput` items for a prompt. */
export async function codexUserInput(text: string, options: PromptImageOptions = {}): Promise<Array<Record<string, unknown>>> {
  const images = await promptImages(text, options);
  return [
    { type: "text", text, text_elements: [] },
    ...images.map((image) => ({ type: "localImage", path: image.path }))
  ];
}

/** ACP `ContentBlock`s for a prompt; images only when the agent advertised support. */
export async function acpPromptContent(
  text: string,
  supportsImages: boolean,
  options: PromptImageOptions = {}
): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (!supportsImages) return blocks;
  for (const image of await promptImages(text, { ...options, withData: true })) {
    if (image.data) blocks.push({ type: "image", mimeType: image.mimeType, data: image.data.toString("base64") });
  }
  return blocks;
}

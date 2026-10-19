import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAttachmentBlock } from "@aisevak/core";
import { afterEach, expect, it } from "vitest";
import { acpPromptContent, codexUserInput, promptImages, sniffImageMimeType } from "./promptImages.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function stored(root: string, name: string, bytes: Buffer, mimeType: string) {
  const id = randomUUID();
  const path = join(root, "attachments", id, name);
  await mkdir(join(root, "attachments", id), { recursive: true });
  await writeFile(path, bytes);
  return { id, name, path, mimeType, size: bytes.length };
}

it("keeps only stored, existing, size-capped files whose bytes are really images", async () => {
  const root = await mkdtemp(join(tmpdir(), "aisevak-prompt-images-"));
  roots.push(root);
  const png = await stored(root, "shot.png", PNG, "image/png");
  // Declared as PNG but actually JPEG: the sniffed type wins.
  const jpeg = await stored(root, "photo.png", JPEG, "image/png");
  const fake = await stored(root, "fake.png", Buffer.from("not an image"), "image/png");
  const large = await stored(root, "large.png", Buffer.concat([PNG, Buffer.alloc(64)]), "image/png");
  const text = await stored(root, "notes.txt", Buffer.from("hi"), "text/plain");
  const missingId = randomUUID();
  const missing = { ...png, id: missingId, path: join(root, "attachments", missingId, "gone.png") };
  const outside = join(root, "secret.png");
  await writeFile(outside, PNG);
  const handTyped = { ...png, id: randomUUID(), path: outside };
  const mismatchedId = { ...png, id: randomUUID() };

  const prompt = appendAttachmentBlock("look", [png, jpeg, fake, large, text, missing, handTyped, mismatchedId]);
  expect(await promptImages(prompt, PNG.length + 10)).toEqual([
    { path: png.path, mimeType: "image/png", size: PNG.length },
    { path: jpeg.path, mimeType: "image/jpeg", size: JPEG.length }
  ]);
});

it("builds text-first inputs for both adapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "aisevak-prompt-images-"));
  roots.push(root);
  const png = await stored(root, "shot.png", PNG, "image/png");
  const prompt = appendAttachmentBlock("look", [png]);
  expect(await codexUserInput("plain")).toEqual([{ type: "text", text: "plain", text_elements: [] }]);
  expect(await codexUserInput(prompt)).toEqual([
    { type: "text", text: prompt, text_elements: [] },
    { type: "localImage", path: png.path }
  ]);
  expect(await acpPromptContent(prompt, false)).toEqual([{ type: "text", text: prompt }]);
  expect(await acpPromptContent(prompt, true)).toEqual([
    { type: "text", text: prompt },
    { type: "image", mimeType: "image/png", data: PNG.toString("base64") }
  ]);
});

it("skips directories and symlinked directories that are not regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "aisevak-prompt-images-"));
  roots.push(root);
  const id = randomUUID();
  const path = join(root, "attachments", id, "dir.png");
  await mkdir(path, { recursive: true });
  const linkId = randomUUID();
  await mkdir(join(root, "attachments", linkId), { recursive: true });
  const link = join(root, "attachments", linkId, "link.png");
  await symlink(path, link);
  const prompt = appendAttachmentBlock("x", [
    { id, name: "dir.png", path, mimeType: "image/png", size: 1 },
    { id: linkId, name: "link.png", path: link, mimeType: "image/png", size: 1 }
  ]);
  expect(await promptImages(prompt)).toEqual([]);
});

it("sniffs common image signatures", () => {
  expect(sniffImageMimeType(PNG)).toBe("image/png");
  expect(sniffImageMimeType(JPEG)).toBe("image/jpeg");
  expect(sniffImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
  expect(sniffImageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(sniffImageMimeType(Buffer.from("plain text here!"))).toBeNull();
});

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "aisevak-prompt-images-")));
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
  expect(await promptImages(prompt, { managedRoot: root, maxBytes: PNG.length + 10 })).toEqual([
    { path: png.path, mimeType: "image/png", size: PNG.length },
    { path: jpeg.path, mimeType: "image/jpeg", size: JPEG.length }
  ]);
});

it("builds text-first inputs for both adapters", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aisevak-prompt-images-")));
  roots.push(root);
  const png = await stored(root, "shot.png", PNG, "image/png");
  const prompt = appendAttachmentBlock("look", [png]);
  expect(await codexUserInput("plain", { managedRoot: root })).toEqual([{ type: "text", text: "plain", text_elements: [] }]);
  expect(await codexUserInput(prompt, { managedRoot: root })).toEqual([
    { type: "text", text: prompt, text_elements: [] },
    { type: "localImage", path: png.path }
  ]);
  expect(await acpPromptContent(prompt, false, { managedRoot: root })).toEqual([{ type: "text", text: prompt }]);
  expect(await acpPromptContent(prompt, true, { managedRoot: root })).toEqual([
    { type: "text", text: prompt },
    { type: "image", mimeType: "image/png", data: PNG.toString("base64") }
  ]);
});

it("skips directories and symlinked directories that are not regular files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aisevak-prompt-images-")));
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
  expect(await promptImages(prompt, { managedRoot: root })).toEqual([]);
});

it("sniffs common image signatures", () => {
  expect(sniffImageMimeType(PNG)).toBe("image/png");
  expect(sniffImageMimeType(JPEG)).toBe("image/jpeg");
  expect(sniffImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
  expect(sniffImageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(sniffImageMimeType(Buffer.from("plain text here!"))).toBeNull();
});

it("rejects files outside the managed root and symlinked files, and caps count and total size", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aisevak-prompt-images-")));
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "aisevak-elsewhere-")));
  roots.push(root, elsewhere);
  // Same shape (…/attachments/<uuid>/name) but under a different root.
  const foreign = await stored(elsewhere, "shot.png", PNG, "image/png");
  // A symlink inside the real root pointing at an image elsewhere.
  const linkId = randomUUID();
  await mkdir(join(root, "attachments", linkId), { recursive: true });
  const link = join(root, "attachments", linkId, "link.png");
  await symlink(foreign.path, link);
  const prompt = appendAttachmentBlock("x", [foreign, { id: linkId, name: "link.png", path: link, mimeType: "image/png", size: PNG.length }]);
  expect(await promptImages(prompt, { managedRoot: root })).toEqual([]);

  const images = await Promise.all([1, 2, 3].map((n) => stored(root, `${n}.png`, PNG, "image/png")));
  const many = appendAttachmentBlock("y", images);
  expect(await promptImages(many, { managedRoot: root, maxImages: 2 })).toHaveLength(2);
  expect(await promptImages(many, { managedRoot: root, maxTotalBytes: PNG.length * 2 + 1 })).toHaveLength(2);
});

it("never throws when the attachments root is missing", async () => {
  const prompt = appendAttachmentBlock("z", [{ id: randomUUID(), name: "a.png", path: "/nope/attachments/x/a.png", mimeType: "image/png", size: 1 }]);
  await expect(promptImages(prompt, { managedRoot: "/definitely/not/here" })).resolves.toEqual([]);
  await expect(codexUserInput(prompt, { managedRoot: "/definitely/not/here" })).resolves.toEqual([{ type: "text", text: prompt, text_elements: [] }]);
});

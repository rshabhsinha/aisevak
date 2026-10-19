import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMimeType, readAttachment, safeAttachmentName, storeAttachment } from "./attachments.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("chat attachments", () => {
  it("stores a file under the managed root and reads its metadata back", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-attachments-"));
    roots.push(root);
    const stored = await storeAttachment(root, { name: "../../etc/passwd", mimeType: "text/plain", bytes: Buffer.from("hi") });
    expect(stored.path).toBe(join(root, "attachments", stored.id, "passwd"));
    expect(await readFile(stored.path, "utf8")).toBe("hi");
    expect(await readAttachment(root, stored.id)).toEqual(stored);
    expect(await readAttachment(root, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("keeps names to one safe path segment", () => {
    expect(safeAttachmentName("C:\\Users\\me\\Screen Shot.png")).toBe("Screen Shot.png");
    expect(safeAttachmentName("..hidden")).toBe("hidden");
    expect(safeAttachmentName("///")).toBe("file");
  });

  it("falls back to the extension when the browser sends no type", () => {
    expect(normalizeMimeType("", "report.PDF")).toBe("application/pdf");
    expect(normalizeMimeType("application/octet-stream", "shot.png")).toBe("image/png");
    expect(normalizeMimeType("text/x-log", "a.log")).toBe("text/x-log");
  });
});

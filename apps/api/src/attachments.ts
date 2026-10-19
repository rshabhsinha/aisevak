import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

// Files people attach to chat messages. They are written under
// <MANAGED_ROOT>/attachments/<id>/ so the runner, which shares that root, can
// hand agents absolute paths they open with their own tools.

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface StoredAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
}

const uploadSchema = z.object({
  // Long names are shortened on disk (safeAttachmentName), never rejected.
  name: z.string().trim().min(1).transform((name) => name.slice(0, 500)),
  mimeType: z.string().trim().max(120).default("application/octet-stream"),
  data: z.string().min(1)
});

const fileParams = z.object({ id: z.string().uuid(), name: z.string().min(1) });

const ATTACHMENT_BLOCK = /\n*<attachments>\n([\s\S]*?)\n<\/attachments>\s*$/;

/** The message without its trailing attachment block, plus the attached file names. */
export function stripAttachmentBlock(message: string): { text: string; fileNames: string[] } {
  const match = ATTACHMENT_BLOCK.exec(message);
  if (!match) return { text: message, fileNames: [] };
  const fileNames = match[1]!
    .split("\n")
    .map((line) => /^- (.+?) \(/.exec(line.trim())?.[1]?.split("/").pop())
    .filter((name): name is string => Boolean(name));
  return { text: message.slice(0, match.index), fileNames };
}

export function attachmentsRoot(managedRoot: string): string {
  return resolve(managedRoot, "attachments");
}

/** Keep names readable for agents but safe as a single path segment. */
export function safeAttachmentName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

export function normalizeMimeType(mimeType: string, name: string): string {
  if (/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) && mimeType !== "application/octet-stream") return mimeType.toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const byExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv"
  };
  return (extension && byExtension[extension]) || "application/octet-stream";
}

export async function storeAttachment(
  managedRoot: string,
  input: { name: string; mimeType: string; bytes: Buffer }
): Promise<StoredAttachment> {
  const id = randomUUID();
  const name = safeAttachmentName(input.name);
  const directory = join(attachmentsRoot(managedRoot), id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, input.bytes);
  const attachment: StoredAttachment = {
    id,
    name,
    mimeType: normalizeMimeType(input.mimeType, name),
    size: input.bytes.length,
    path
  };
  await writeFile(join(directory, ".meta.json"), JSON.stringify(attachment));
  return attachment;
}

export async function readAttachment(managedRoot: string, id: string): Promise<StoredAttachment | null> {
  try {
    const meta = JSON.parse(await readFile(join(attachmentsRoot(managedRoot), id, ".meta.json"), "utf8")) as StoredAttachment;
    await stat(meta.path);
    return meta;
  } catch {
    return null;
  }
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  options: {
    managedRoot: string;
    requireUser: (request: FastifyRequest) => unknown;
    /** Resolves the signed-in user straight from the request (cookie or API key). */
    authenticate: (request: FastifyRequest) => Promise<unknown>;
  }
): void {
  // Base64 inflates the body by a third, plus JSON framing.
  const bodyLimit = Math.ceil(MAX_ATTACHMENT_BYTES * 1.4) + 4096;

  // The global preHandler that sets request.user runs after the body is parsed,
  // so reject anonymous uploads before reading up to ~28 MB of JSON.
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await options.authenticate(request))) return reply.unauthorized();
  };

  app.post("/api/attachments", { bodyLimit, onRequest }, async (request, reply) => {
    options.requireUser(request);
    const body = uploadSchema.parse(request.body);
    const bytes = Buffer.from(body.data.replace(/^data:[^,]*,/, ""), "base64");
    if (bytes.length === 0) return reply.badRequest("The file is empty.");
    if (bytes.length > MAX_ATTACHMENT_BYTES) return reply.payloadTooLarge("Files can be up to 20 MB.");
    return { attachment: await storeAttachment(options.managedRoot, { name: body.name, mimeType: body.mimeType, bytes }) };
  });

  app.get("/api/attachments/:id/:name", async (request, reply) => {
    options.requireUser(request);
    const { id } = fileParams.parse(request.params);
    const attachment = await readAttachment(options.managedRoot, id);
    if (!attachment) return reply.notFound();
    const inline = /^image\/(png|jpe?g|gif|webp|avif)$/.test(attachment.mimeType) || attachment.mimeType === "application/pdf";
    return reply
      .header("Content-Type", attachment.mimeType)
      .header("Content-Length", attachment.size)
      .header("Cache-Control", "private, max-age=86400, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
      .send(createReadStream(attachment.path));
  });
}

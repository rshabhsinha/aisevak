// Attachments travel inside the message text as a trailing block of absolute
// paths, so every harness can open them with its own file tools and every
// persistence path (runs, steering inputs, task messages) keeps them without a
// schema change. The UI strips the block and renders chips instead.

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
}

const BLOCK = /\n*<attachments>\n([\s\S]*?)\n<\/attachments>\s*$/;
const LINE = /^- (.+) \(([^,()]+), (\d+) bytes(?:, id ([\w-]+))?\)$/;

export function appendAttachmentBlock(text: string, attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((file) => `- ${file.path} (${file.mimeType}, ${file.size} bytes, id ${file.id})`);
  const intro = text.trim() ? `${text.trimEnd()}\n\n` : "";
  return `${intro}<attachments>\n${lines.join("\n")}\n</attachments>`;
}

export function splitAttachmentBlock(text: string): { text: string; attachments: MessageAttachment[] } {
  const match = BLOCK.exec(text);
  if (!match) return { text, attachments: [] };
  const attachments = match[1]!.split("\n").flatMap((line): MessageAttachment[] => {
    const parsed = LINE.exec(line.trim());
    if (!parsed) return [];
    const path = parsed[1]!;
    return [{ path, name: path.split("/").pop() ?? path, mimeType: parsed[2]!, size: Number(parsed[3]), id: parsed[4] ?? "" }];
  });
  return { text: text.slice(0, match.index).trimEnd(), attachments };
}

export function isImageAttachment(file: Pick<MessageAttachment, "mimeType">): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif)$/i.test(file.mimeType);
}

export function attachmentUrl(file: Pick<MessageAttachment, "id" | "name">): string {
  return `/api/attachments/${encodeURIComponent(file.id)}/${encodeURIComponent(file.name)}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileExtensionLabel(name: string): string {
  const extension = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1];
  return extension ? extension.toUpperCase() : "FILE";
}

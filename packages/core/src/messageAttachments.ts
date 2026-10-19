// Attachments travel inside the message text as a trailing block of absolute
// paths, so every harness can open them with its own file tools and every
// persistence path (runs, steering inputs, task messages) keeps them without a
// schema change:
//
//   <attachments>
//   - /srv/aisevak/attachments/<id>/<name> (<mime>, <bytes> bytes, id <id>)
//   </attachments>
//
// The web UI strips the block and renders chips; the runner additionally
// hands image attachments to harnesses that accept native image input.

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
}

const TRAILING_BLOCK = /\n*<attachments>\n([\s\S]*?)\n<\/attachments>\s*$/;
const ANY_BLOCK = /<attachments>\n([\s\S]*?)\n<\/attachments>/g;
const LINE = /^- (.+) \(([^,()]+), (\d+) bytes(?:, id ([\w-]+))?\)$/;

export function appendAttachmentBlock(text: string, attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((file) => `- ${file.path} (${file.mimeType}, ${file.size} bytes, id ${file.id})`);
  const intro = text.trim() ? `${text.trimEnd()}\n\n` : "";
  return `${intro}<attachments>\n${lines.join("\n")}\n</attachments>`;
}

function parseAttachmentLines(body: string): MessageAttachment[] {
  return body.split("\n").flatMap((line): MessageAttachment[] => {
    const parsed = LINE.exec(line.trim());
    if (!parsed) return [];
    const path = parsed[1]!;
    return [{ path, name: path.split("/").pop() ?? path, mimeType: parsed[2]!, size: Number(parsed[3]), id: parsed[4] ?? "" }];
  });
}

/** Split the trailing attachment block off a single message. */
export function splitAttachmentBlock(text: string): { text: string; attachments: MessageAttachment[] } {
  const match = TRAILING_BLOCK.exec(text);
  if (!match) return { text, attachments: [] };
  return { text: text.slice(0, match.index).trimEnd(), attachments: parseAttachmentLines(match[1]!) };
}

/**
 * Every attachment referenced anywhere in a prompt. Runner prompts can wrap a
 * message in envelopes and instructions, so the block is not always trailing.
 * Duplicates (the same path in several blocks) are returned once.
 */
export function findMessageAttachments(text: string): MessageAttachment[] {
  const seen = new Set<string>();
  const found: MessageAttachment[] = [];
  for (const match of text.matchAll(ANY_BLOCK)) {
    for (const attachment of parseAttachmentLines(match[1]!)) {
      if (seen.has(attachment.path)) continue;
      seen.add(attachment.path);
      found.push(attachment);
    }
  }
  return found;
}

export function isImageAttachment(file: Pick<MessageAttachment, "mimeType">): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif)$/i.test(file.mimeType);
}

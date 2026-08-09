export interface PageCursor {
  at: string;
  id: string;
}

export interface ContentCursor {
  offset: number;
  revision: string;
}

export interface ContentPage {
  content: string;
  truncated: boolean;
  totalBytes: number;
  nextCursor: string | null;
  offset: number;
  revision: string;
}

export function encodeCursor(value: PageCursor | ContentCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodePageCursor(value: string | undefined): PageCursor | null {
  if (!value) return null;
  const parsed = decodeCursor(value);
  if (
    !parsed ||
    typeof parsed.at !== "string" ||
    typeof parsed.id !== "string" ||
    !parsed.at ||
    !parsed.id
  ) {
    throw new Error("Invalid page cursor");
  }
  return { at: parsed.at, id: parsed.id };
}

export function contentPage(
  content: string,
  options: { cursor?: string; maxBytes?: number; revision?: string } = {}
): ContentPage {
  const bytes = Buffer.from(content, "utf8");
  const revision = options.revision ?? "1";
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? 4096, 64 * 1024));
  let offset = 0;
  if (options.cursor) {
    const parsed = decodeCursor(options.cursor);
    if (
      !parsed ||
      typeof parsed.offset !== "number" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      parsed.revision !== revision
    ) {
      throw new Error("Invalid or stale content cursor");
    }
    offset = Math.min(parsed.offset, bytes.length);
  }

  const end = Math.min(offset + maxBytes, bytes.length);
  let safeEnd = end;
  while (safeEnd > offset && safeEnd < bytes.length && (bytes[safeEnd]! & 0b1100_0000) === 0b1000_0000) {
    safeEnd -= 1;
  }
  if (safeEnd === offset && end > offset) safeEnd = end;
  const truncated = safeEnd < bytes.length;
  return {
    content: bytes.subarray(offset, safeEnd).toString("utf8"),
    truncated,
    totalBytes: bytes.length,
    nextCursor: truncated ? encodeCursor({ offset: safeEnd, revision }) : null,
    offset,
    revision
  };
}

export function pageLimit(value: unknown, defaultValue = 20, maximum = 100): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(1, Math.min(Math.trunc(parsed), maximum));
}

function decodeCursor(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

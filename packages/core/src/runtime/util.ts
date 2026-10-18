export type JsonRecord = Record<string, unknown>;

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Drop undefined fields so persisted payloads stay compact and fixture-comparable. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Stringify a structured tool result for display; strings pass through. */
export function displayText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Text of an MCP-style `content: [{type: "text", text}]` result, else its JSON. */
export function contentItemsText(value: unknown): string | undefined {
  const items = Array.isArray(value) ? value : arrayValue(objectValue(value)?.content);
  const texts = items.flatMap((item) => {
    const text = stringValue(objectValue(item)?.text);
    return text ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : displayText(value);
}

const MAX_DIFF_CELLS = 4_000_000;
// Above this many lines on either side the diff is skipped entirely: the
// stored payload already carries the full texts, and a giant listing helps
// nobody in the timeline.
export const MAX_DIFF_LINES = 20_000;
const CONTEXT_LINES = 3;

/**
 * Build a unified diff for one file from its before/after text. ACP harnesses
 * report edits as {oldText, newText}; the UI renders unified diffs.
 */
export function unifiedDiff(path: string, oldText: string | null | undefined, newText: string): string | undefined {
  const before = oldText ? splitLines(oldText) : [];
  const after = splitLines(newText);
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) return undefined;
  const relative = path.replace(/^\/+/, "");
  const header = [`--- ${oldText == null ? "/dev/null" : `a/${relative}`}`, `+++ b/${relative}`];
  const ops = diffLines(before, after);
  const hunks: string[] = [];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index]!.kind === " ") index += 1;
    if (index >= ops.length) break;
    const start = Math.max(0, index - CONTEXT_LINES);
    let end = index;
    // Extend the hunk while changes are within 2*context of each other.
    let lastChange = index;
    while (end < ops.length) {
      if (ops[end]!.kind !== " ") lastChange = end;
      else if (end - lastChange > CONTEXT_LINES * 2) break;
      end += 1;
    }
    end = Math.min(ops.length, lastChange + CONTEXT_LINES + 1);
    const slice = ops.slice(start, end);
    const oldStart = slice[0]!.oldLine;
    const newStart = slice[0]!.newLine;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    // Push line by line: spreading a large slice into push() overflows the stack.
    hunks.push(`@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@`);
    for (const op of slice) hunks.push(`${op.kind}${op.text}`);
    index = end;
  }
  return header.concat(hunks).join("\n");
}

interface DiffOp {
  kind: " " | "-" | "+";
  text: string;
  oldLine: number;
  newLine: number;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffLines(before: string[], after: string[]): DiffOp[] {
  // Trim the common prefix and suffix, then LCS the middle.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const ops: DiffOp[] = [];
  let oldLine = 0;
  let newLine = 0;
  const keep = (text: string) => ops.push({ kind: " ", text, oldLine: oldLine++, newLine: newLine++ });
  const remove = (text: string) => ops.push({ kind: "-", text, oldLine: oldLine++, newLine });
  const add = (text: string) => ops.push({ kind: "+", text, oldLine, newLine: newLine++ });

  for (let i = 0; i < prefix; i += 1) keep(before[i]!);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    a.forEach(remove);
    b.forEach(add);
  } else {
    const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        keep(a[i]!);
        i += 1;
        j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        remove(a[i]!);
        i += 1;
      } else {
        add(b[j]!);
        j += 1;
      }
    }
    while (i < a.length) remove(a[i++]!);
    while (j < b.length) add(b[j++]!);
  }
  for (let i = before.length - suffix; i < before.length; i += 1) keep(before[i]!);
  return ops;
}

export type PromptReferenceKind = "skill" | "agent" | "task";

export interface SlashTrigger {
  start: number;
  end: number;
  command: PromptReferenceKind | null;
  query: string;
  mode: "command" | "reference";
}

const COMMANDS: PromptReferenceKind[] = ["skill", "agent", "task"];

export function findSlashTrigger(text: string, cursor: number): SlashTrigger | null {
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf("\n", boundedCursor - 1) + 1;
  const line = text.slice(lineStart, boundedCursor);
  const slashInLine = line.lastIndexOf("/");
  if (slashInLine < 0) return null;
  const beforeSlash = line.slice(0, slashInLine);
  if (beforeSlash && !/\s$/.test(beforeSlash)) return null;

  const commandText = line.slice(slashInLine + 1);
  const match = commandText.match(/^([a-z]*)(?:\s+(.*))?$/i);
  if (!match) return null;
  const commandQuery = (match[1] ?? "").toLowerCase();
  const command = COMMANDS.find((entry) => entry === commandQuery) ?? null;
  const hasReferenceQuery = match[2] !== undefined;
  return {
    start: lineStart + slashInLine,
    end: boundedCursor,
    command,
    query: hasReferenceQuery ? match[2] ?? "" : commandQuery,
    mode: command && hasReferenceQuery ? "reference" : "command"
  };
}

export function replaceSlashTrigger(
  text: string,
  trigger: SlashTrigger,
  replacement: string
): { value: string; cursor: number } {
  const value = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { value, cursor: trigger.start + replacement.length };
}

export function promptReferenceToken(kind: PromptReferenceKind, key: string): string {
  return `@${kind}(${key.trim()})`;
}

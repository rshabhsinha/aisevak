// Deterministic checks that keep agent-written reports and incidents readable.
// They check readability limits only, never a particular layout; the report-writing
// and incident-writing platform skills describe the same limits.

export type WritingSeverity = "error" | "warning";

export interface WritingFinding {
  rule: string;
  severity: WritingSeverity;
  message: string;
}

export interface WritingCheck {
  passed: boolean;
  errors: WritingFinding[];
  warnings: WritingFinding[];
}

export type WritingLintMode = "warn" | "off";

export interface ReportWritingInput {
  title?: string | null;
  description?: string | null;
  markdown: string;
}

export type IncidentWritingStage = "declare" | "update" | "resolve";

export interface IncidentWritingInput {
  title?: string | null;
  description?: string | null;
  markdown: string;
  stage: IncidentWritingStage;
}

const limits = {
  titleChars: 80,
  descriptionChars: 200,
  reportWordsWarn: 250,
  reportWordsError: 400,
  incidentWordsWarn: 120,
  incidentWordsError: 250,
  tableRows: 25,
  uuidsError: 3,
  isoTimestampsWarn: 2,
  blockWordsWarn: 60
} as const;

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const isoTimestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const packedCountsPattern = /\b\d+(?:\/\d+){2,}\b/g;

export function writingLintMode(value = process.env.AISEVAK_WRITING_LINT): WritingLintMode {
  return value === "off" ? "off" : "warn";
}

export function lintReport(input: ReportWritingInput): WritingCheck {
  const findings: WritingFinding[] = [
    ...titleFindings(input.title),
    ...descriptionFindings(input.title, input.description)
  ];
  const firstHeading = input.markdown.split(/\r?\n/).map((line) => line.trim()).find((line) => /^#{1,6}\s/.test(line));
  if (firstHeading && input.title && normalize(firstHeading.replace(/^#+\s*/, "")) === normalize(input.title)) {
    findings.push(warning("repeated-title", "Remove the heading that repeats the title; the app already shows it."));
  }
  findings.push(
    ...lengthFindings(input.markdown, limits.reportWordsWarn, limits.reportWordsError),
    ...tableFindings(input.markdown),
    ...bodyStyleFindings(input.markdown)
  );
  return summarize(findings);
}

export function lintIncident(input: IncidentWritingInput): WritingCheck {
  const findings: WritingFinding[] = [];
  if (input.stage === "declare") {
    findings.push(...titleFindings(input.title), ...descriptionFindings(input.title, input.description));
  }
  findings.push(
    ...lengthFindings(input.markdown, limits.incidentWordsWarn, limits.incidentWordsError),
    ...tableFindings(input.markdown),
    ...bodyStyleFindings(input.markdown)
  );
  return summarize(findings);
}

// Findings are advice returned with the write; they never block it. "off" silences them.
export function adviseWritingCheck(check: WritingCheck, mode = writingLintMode()): WritingCheck {
  return mode === "off" ? { passed: true, errors: [], warnings: [] } : check;
}

function titleFindings(title?: string | null): WritingFinding[] {
  if (!title) return [];
  const findings: WritingFinding[] = [];
  if (title.length > limits.titleChars) {
    findings.push(error("title-length", `Shorten the title to ${limits.titleChars} characters or fewer (now ${title.length}); say what a person would say out loud.`));
  }
  if (countMatches(title, isoTimestampPattern) > 0 || countMatches(title, uuidPattern) > 0) {
    findings.push(error("title-identifiers", "Remove timestamps and IDs from the title; put the time window in the description."));
  }
  return findings;
}

function descriptionFindings(title?: string | null, description?: string | null): WritingFinding[] {
  if (!description) return [];
  const findings: WritingFinding[] = [];
  if (description.length > limits.descriptionChars) {
    findings.push(error("description-length", `Shorten the description to ${limits.descriptionChars} characters or fewer (now ${description.length}); one line of scope.`));
  }
  if (title && normalize(description) === normalize(title)) {
    findings.push(warning("description-repeats-title", "Make the description add scope instead of repeating the title."));
  }
  return findings;
}

function lengthFindings(markdown: string, warnAt: number, errorAt: number): WritingFinding[] {
  const words = bodyWords(markdown);
  if (words > errorAt) {
    return [error("length", `Cut the body to ${errorAt} words or fewer (now ${words}); keep audit detail in the thread, not here.`)];
  }
  if (words > warnAt) {
    return [warning("length", `Aim for ${warnAt} words or fewer (now ${words}).`)];
  }
  return [];
}

function tableFindings(markdown: string): WritingFinding[] {
  const rows = markdownParts(markdown).tableRows;
  if (rows > limits.tableRows) {
    return [error("table-rows", `Show at most ${limits.tableRows} table rows (now ${rows}): active, blocked, and recently changed items. Link the full ledger instead.`)];
  }
  return [];
}

function bodyStyleFindings(markdown: string): WritingFinding[] {
  const findings: WritingFinding[] = [];
  const uuids = countMatches(markdown, uuidPattern);
  if (uuids > limits.uuidsError) {
    findings.push(error("raw-ids", `Replace the ${uuids} raw UUIDs with stable references such as \`TASK-12\` or with names.`));
  } else if (uuids > 0) {
    findings.push(warning("raw-ids", "Replace raw UUIDs with stable references such as `TASK-12` or with names."));
  }
  const timestamps = countMatches(markdown, isoTimestampPattern);
  if (timestamps > limits.isoTimestampsWarn) {
    findings.push(warning("timestamps", `Use short times such as "02:11 UTC" instead of ${timestamps} full ISO timestamps.`));
  }
  if ((markdown.match(packedCountsPattern) ?? []).some((match) => !isSlashDate(match))) {
    findings.push(warning("packed-counts", "Write counts as sentences (\"errors rose from 0 to 5\") instead of slash-packed numbers like 33/5/9/0."));
  }
  const longest = Math.max(0, ...proseBlocks(markdown).map(wordCount));
  if (longest > limits.blockWordsWarn) {
    findings.push(warning("long-block", `Split the ${longest}-word paragraph or bullet; keep each to one fact.`));
  }
  return findings;
}

function summarize(findings: WritingFinding[]): WritingCheck {
  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return { passed: errors.length === 0, errors, warnings };
}

// Splits prose from tables and fenced code. A table is a header line followed by a
// separator line; its body rows are the following lines that contain a pipe.
function markdownParts(markdown: string): { prose: string[]; code: string[]; tableRows: number } {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  // A fence that never closes is not code; Markdown renders the rest as text.
  const fences = lines.filter((line) => /^(```|~~~)/.test(line)).length;
  const lastFence = fences % 2 === 1 ? lines.map((line) => /^(```|~~~)/.test(line)).lastIndexOf(true) : -1;
  const prose: string[] = [];
  const code: string[] = [];
  let tableRows = 0;
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index !== lastFence && /^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { code.push(line); continue; }
    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      index += 2;
      while (index < lines.length && lines[index]!.includes("|")) { tableRows += 1; index += 1; }
      index -= 1;
      continue;
    }
    prose.push(line);
  }
  return { prose, code, tableRows };
}

function isTableSeparator(line: string): boolean {
  return line.includes("-") && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line);
}

// Code blocks count toward length so pasted logs cannot hide inside a fence.
function bodyWords(markdown: string): number {
  const parts = markdownParts(markdown);
  return wordCount([...parts.prose, ...parts.code].join(" "));
}


function proseBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => { if (current.length) blocks.push(current.join(" ")); current = []; };
  for (const line of markdownParts(markdown).prose) {
    if (!line || /^#{1,6}\s/.test(line)) { flush(); continue; }
    if (/^([-*+]|\d+[.)])\s/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function wordCount(text: string): number {
  const stripped = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_>#|]/g, " ");
  return stripped.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

// 10/20/2026 or 2026/10/20 is a date, not packed counts.
function isSlashDate(text: string): boolean {
  const parts = text.split("/");
  return parts.length === 3 && (parts[0]!.length === 4 || parts[2]!.length === 4);
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function error(rule: string, message: string): WritingFinding {
  return { rule, severity: "error", message };
}

function warning(rule: string, message: string): WritingFinding {
  return { rule, severity: "warning", message };
}

// Deterministic checks that keep agent-written reports and incidents readable.
// The rules mirror the report-writing and incident-writing platform skills.

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

export type WritingLintMode = "enforce" | "warn" | "off";

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
  return value === "warn" || value === "off" ? value : "enforce";
}

export function lintReport(input: ReportWritingInput): WritingCheck {
  const findings: WritingFinding[] = [
    ...titleFindings(input.title),
    ...descriptionFindings(input.title, input.description)
  ];
  const lines = contentLines(input.markdown);
  const firstHeading = input.markdown.split(/\r?\n/).map((line) => line.trim()).find((line) => /^#{1,6}\s/.test(line));
  if (firstHeading && input.title && normalize(firstHeading.replace(/^#+\s*/, "")) === normalize(input.title)) {
    findings.push(warning("repeated-title", "Remove the heading that repeats the title; the app already shows it."));
  }
  if (!leadsWith(lines, "bottom line")) {
    findings.push(error("bottom-line", "Start the body with `**Bottom line:**` and one or two plain sentences on what is healthy, broken, or unknown."));
  }
  if (!hasLabel(input.markdown, "next")) {
    findings.push(error("next", "Add a `**Next:**` line with one action and its owner, or \"No action needed.\""));
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
  const lines = contentLines(input.markdown);
  if (!leadsWith(lines, "status")) {
    findings.push(error("status", "Start the update with `**Status:**` (Open, Contained, Monitoring, or Resolved) and one sentence on where it stands."));
  } else if (input.stage === "resolve" && !/resolved/i.test(lines[0] ?? "")) {
    findings.push(error("status", "A resolution note starts with `**Status:** Resolved.` and says what was verified."));
  }
  if (input.stage !== "resolve" && !hasLabel(input.markdown, "next")) {
    findings.push(error("next", "Add a `**Next:**` line with one action, its owner, and the check that closes the incident."));
  }
  if (input.stage !== "resolve" && !hasLabel(input.markdown, "impact")) {
    findings.push(warning("impact", "Add an `**Impact:**` line; write \"Unconfirmed.\" when customer impact is unknown."));
  }
  findings.push(
    ...lengthFindings(input.markdown, limits.incidentWordsWarn, limits.incidentWordsError),
    ...tableFindings(input.markdown),
    ...bodyStyleFindings(input.markdown)
  );
  return summarize(findings);
}

// Throws a 422 listing every error when the mode enforces the lint; otherwise returns the check for the response.
export function assertWritingCheck(check: WritingCheck, label: string, mode = writingLintMode()): WritingCheck {
  if (mode === "off") return { passed: true, errors: [], warnings: [] };
  if (mode === "enforce" && !check.passed) {
    const problems = [...check.errors, ...check.warnings].map((finding) => `- [${finding.severity}] ${finding.message}`);
    const message = [
      `${label} was rejected because it breaks the writing rules. Nothing was saved or published. Fix these and retry:`,
      ...problems,
      "See the report-writing and incident-writing skills for the expected shape."
    ].join("\n");
    throw Object.assign(new Error(message), { statusCode: 422, code: "WRITING_LINT" });
  }
  return check;
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
  const words = proseWords(markdown);
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
  if (countMatches(markdown, packedCountsPattern) > 0) {
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

// Non-blank lines that are not headings, so a leading `# Title` does not hide the lead line.
function contentLines(markdown: string): string[] {
  return markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^#{1,6}\s/.test(line));
}

function leadsWith(lines: string[], label: string): boolean {
  return labelPattern(label).test(lines[0] ?? "");
}

function hasLabel(markdown: string, label: string): boolean {
  const heading = new RegExp(`^#{1,6}\\s*${label}\\b`, "i");
  return markdown.split(/\r?\n/).some((line) => {
    const trimmed = line.trim().replace(/^[-*]\s+/, "");
    return labelPattern(label).test(trimmed) || heading.test(trimmed);
  });
}

// Matches `**Label:**`, `**Label**:`, `__Label:__`, or a bare `Label:` at the start of a line.
function labelPattern(label: string): RegExp {
  return new RegExp(`^(?:\\*\\*|__)?\\s*${label.replace(/ /g, "\\s+")}\\s*(?::\\s*(?:\\*\\*|__)|(?:\\*\\*|__)\\s*:|:)`, "i");
}

function markdownParts(markdown: string): { prose: string[]; tableRows: number } {
  const prose: string[] = [];
  let tableRows = 0;
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.startsWith("|")) {
      if (!/^\|?[\s:|-]+\|?$/.test(line)) tableRows += 1;
      continue;
    }
    prose.push(line);
  }
  // The header row is not content.
  return { prose, tableRows: Math.max(0, tableRows - countTables(markdown)) };
}

function countTables(markdown: string): number {
  return markdown.split(/\r?\n/).filter((line) => /^\s*\|?[\s:]*-{3,}[\s:|-]*\|?\s*$/.test(line) && line.includes("|")).length;
}

function proseWords(markdown: string): number {
  return wordCount(markdownParts(markdown).prose.join(" "));
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

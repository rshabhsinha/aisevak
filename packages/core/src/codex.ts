import type { CodexCommandOptions, CodexPromptOptions, NormalizedCodexEvent } from "./types.js";

export function buildCodexArgs(options: CodexCommandOptions = {}): string[] {
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check"
  ];

  if (isExplicitModel(options.model)) {
    args.push("--model", options.model);
  }

  if (options.resumeThreadId) {
    args.push("resume", options.resumeThreadId, "-");
  } else {
    args.push("-");
  }

  return args;
}

export function buildCodexConfigToml(model?: string | null): string {
  return [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    isExplicitModel(model) ? `model = ${JSON.stringify(model)}` : undefined,
    "",
    "[history]",
    'persistence = "save-all"',
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function isExplicitModel(model: string | null | undefined): model is string {
  return Boolean(model && !["default", "auto", "codex-default"].includes(model.trim().toLowerCase()));
}

export function buildCodexPrompt(options: CodexPromptOptions): string {
  const lines = [
    "# Agent Instructions",
    `You are running as agent: ${options.agentName}.`,
    "Treat the following instructions as the controlling system prompt for this task.",
    options.agentInstructions.trim(),
    "",
    "# Execution Context",
    `Project path: ${options.projectPath}`,
    options.branch ? `Git branch: ${options.branch}` : undefined,
    options.previousContext ? `Previous context: ${options.previousContext}` : undefined,
    "",
    "# Task",
    `Title: ${options.taskTitle}`,
    options.taskBody?.trim() ? options.taskBody.trim() : "No additional body was provided.",
    "",
    "Work autonomously. Make the required code changes, run appropriate checks, and summarize what changed."
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export function parseCodexJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {
      type: "parse.error",
      rawLine: line
    };
  }
}

export function normalizeCodexEvent(raw: unknown): NormalizedCodexEvent {
  if (!raw || typeof raw !== "object") {
    return { type: "unknown", raw };
  }

  const record = raw as Record<string, unknown>;
  const method = stringValue(record.method) ?? stringValue(record.type);
  if (method) {
    const params = objectValue(record.params);
    const item = objectValue(params?.item);
    const delta = objectValue(params?.delta);
    const threadId = stringValue(params?.thread_id) ?? stringValue(record.thread_id);
    const text =
      stringValue(item?.text) ??
      stringValue(item?.content) ??
      stringValue(delta?.text) ??
      stringValue(params?.text);
    return {
      type: method,
      text,
      threadId,
      itemId: stringValue(item?.id) ?? stringValue(params?.item_id),
      status: stringValue(params?.status),
      usage: objectValue(params?.usage),
      raw
    };
  }

  const message = objectValue(record.msg);
  if (message) {
    const type = stringValue(message.type) ?? "legacy";
    return {
      type,
      text:
        stringValue(message.text) ??
        stringValue(message.content) ??
        stringValue(message.message) ??
        extractLegacyAgentMessage(message),
      threadId: stringValue(message.thread_id) ?? stringValue(record.thread_id),
      itemId: stringValue(record.id) ?? stringValue(message.item_id),
      usage: objectValue(message.usage),
      raw
    };
  }

  return { type: "unknown", raw };
}

export function extractThreadId(event: NormalizedCodexEvent): string | undefined {
  if (event.threadId) return event.threadId;
  const raw = event.raw as Record<string, unknown>;
  return stringValue(raw?.thread_id) ?? stringValue(objectValue(raw?.params)?.thread_id);
}

export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractLegacyAgentMessage(message: Record<string, unknown>): string | undefined {
  const item = objectValue(message.item);
  if (!item) return undefined;
  return stringValue(item.text) ?? stringValue(item.content);
}

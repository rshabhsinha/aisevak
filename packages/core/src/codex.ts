import type { CodexPromptOptions, DispatcherPromptOptions } from "./types.js";

export function buildCodexAppServerArgs(): string[] {
  return ["app-server", "--listen", "stdio://"];
}

export function buildCodexConfigToml(model?: string | null): string {
  return [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'cli_auth_credentials_store = "file"',
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
    ...skillPromptSection(options.skills),
    "",
    "# Execution Context",
    `Project path: ${options.projectPath}`,
    options.branch ? `Git branch: ${options.branch}` : undefined,
    options.previousContext ? `Previous context: ${options.previousContext}` : undefined,
    "",
    "# Available Aisevak Tools",
    "Use the `aisevak` CLI that is already on PATH.",
    "- `aisevak credential list` lists admin-provided credentials available to this run.",
    "- `aisevak credential get <name>` fetches one credential only when it is needed.",
    "- `aisevak credential add <name> --value-stdin` stores a newly obtained credential for future runs.",
    "",
    "# Task",
    `Title: ${options.taskTitle}`,
    options.taskBody?.trim() ? options.taskBody.trim() : "No additional body was provided.",
    "",
    "Work autonomously. Make the required code changes, run appropriate checks, and summarize what changed."
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export function buildDispatcherPrompt(options: DispatcherPromptOptions): string {
  const lines = [
    "# Dispatcher Instructions",
    "You are Aisevak's Dispatcher agent. Your job is to turn task-board state into the next useful worker runs.",
    "Treat the following instructions as the controlling system prompt for this dispatcher session.",
    options.dispatcherInstructions.trim(),
    ...skillPromptSection(options.skills),
    "",
    "# Available Board Tools",
    "Use the `aisevak` CLI that is already on PATH. Do not write directly to the database.",
    "- `aisevak context` prints the current task, project, and agent state.",
    "- `aisevak task assign TASK-123 --agent \"Builder\" --run` assigns a worker and queues that worker run.",
    "- `aisevak task attention TASK-123 \"reason\"` moves a task to Needs attention with a comment.",
    "- `aisevak task comment TASK-123 \"note\"` leaves a task comment.",
    "- `aisevak task complete TASK-123 --summary \"summary\"` marks a task completed with a comment.",
    "- `aisevak task create --title \"...\" --body \"...\" --status needs_attention` creates follow-up work.",
    "- `aisevak credential list` lists admin-provided credentials available to this run.",
    "- `aisevak credential get <name>` fetches one credential only when it is needed.",
    "- `aisevak credential add <name> --value-stdin` stores a newly obtained credential for future runs.",
    "",
    "# Routing Rules",
    "Only route tasks to enabled worker agents. Do not route tasks to Dispatcher.",
    "Prefer one clear worker run per task. If a task is ambiguous, move it to Needs attention with a precise reason.",
    "If you can fully answer a task without a worker run, comment with the answer and complete it.",
    "If a task already has an active worker run, leave it alone.",
    options.targetTaskNumber
      ? `This is a user-requested single-task dispatch. Focus on TASK-${options.targetTaskNumber}.`
      : "This is a heartbeat dispatch. Review Todo and Needs attention tasks.",
    "",
    "# Current Tasks JSON",
    options.tasksJson,
    "",
    "# Available Agents JSON",
    options.agentsJson,
    "",
    "# Projects JSON",
    options.projectsJson,
    "",
    "Inspect the repository only when that helps routing. Finish by summarizing which task-board actions you took."
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function skillPromptSection(skills: CodexPromptOptions["skills"]): string[] {
  const activeSkills = (skills ?? []).filter((skill) => skill.name.trim() && skill.description.trim());
  if (activeSkills.length === 0) return [];
  return [
    "",
    "# Available Skills",
    "The following skills are installed for this session. Invoke a skill explicitly with `$skill-name` when it is directly useful, or use it implicitly when its description matches the work.",
    ...activeSkills.map((skill) => `- $${skill.name}: ${skill.description}`)
  ];
}

export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

// Canonical provider runtime events (v2). Every harness adapter maps its raw
// stdout lines onto this union; the runner persists it as the event payload and
// the web UI reads nothing else. Keep this module free of Node imports: the web
// bundle imports it directly.

export const RUNTIME_EVENT_VERSION = 2;

export type RuntimeProvider = "codex" | "cursor" | "opencode" | "devin" | "claude";

export type RuntimeEventType =
  | "session.configured"
  | "thread.started"
  | "turn.started"
  | "turn.completed"
  | "item.started"
  | "item.updated"
  | "item.completed"
  | "content.delta"
  | "turn.plan.updated"
  | "turn.diff.updated"
  | "usage.updated"
  | "request.opened"
  | "runtime.warning"
  | "runtime.error"
  | "user.message"
  | "parse.error"
  | "provider.event";

export type RuntimeItemType =
  | "assistant_message"
  | "reasoning"
  | "plan"
  | "command_execution"
  | "file_change"
  | "file_read"
  | "search"
  | "web_fetch"
  | "web_search"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "subagent"
  | "image_view"
  | "context_compaction"
  | "other";

export type RuntimeItemStatus = "in_progress" | "completed" | "failed" | "declined";

export interface RuntimeFileChange {
  path: string;
  kind: "add" | "delete" | "update" | "move";
  movePath?: string;
  diff?: string;
}

export interface RuntimeItem {
  itemType: RuntimeItemType;
  status: RuntimeItemStatus;
  title?: string;
  text?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  output?: string;
  changes?: RuntimeFileChange[];
  toolName?: string;
  input?: unknown;
  locations?: string[];
}

export type RuntimeDeltaStream =
  | "assistant"
  | "reasoning"
  | "reasoning_summary"
  | "command_output"
  | "file_change_output"
  | "plan";

export interface RuntimeDelta {
  stream: RuntimeDeltaStream;
  text: string;
}

export type RuntimeTurnState = "in_progress" | "completed" | "failed" | "interrupted" | "cancelled";

export interface RuntimeTurn {
  state: RuntimeTurnState;
  stopReason?: string;
  errorMessage?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface RuntimePlanEntry {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface RuntimePlan {
  explanation?: string;
  entries: RuntimePlanEntry[];
}

export interface RuntimeUsage {
  /** `context` is a live context-window gauge; `turn` is one turn's accounting. */
  scope: "context" | "turn";
  usedTokens?: number;
  maxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: { amount: number; currency: string };
}

export interface RuntimeError {
  message: string;
  code?: string;
  detail?: string;
}

export interface RuntimeNotice {
  level: "info" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface RuntimeRaw {
  source: "codex.app-server" | "acp.jsonrpc" | "aisevak";
  method?: string;
  payload: unknown;
}

export interface RuntimeEvent {
  v: typeof RUNTIME_EVENT_VERSION;
  type: RuntimeEventType;
  provider: RuntimeProvider;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  /** Emitted while a harness replays a reloaded session's history. */
  replay?: true;
  /** Human-readable text, also stored in the `text` column. */
  text?: string;
  item?: RuntimeItem;
  delta?: RuntimeDelta;
  turn?: RuntimeTurn;
  plan?: RuntimePlan;
  diff?: { unifiedDiff: string };
  usage?: RuntimeUsage;
  error?: RuntimeError;
  notice?: RuntimeNotice;
  raw: RuntimeRaw;
}

export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { v?: unknown }).v === RUNTIME_EVENT_VERSION &&
      typeof (value as { type?: unknown }).type === "string"
  );
}

export function isToolItemType(itemType: RuntimeItemType): boolean {
  return !["assistant_message", "reasoning", "plan", "context_compaction"].includes(itemType);
}

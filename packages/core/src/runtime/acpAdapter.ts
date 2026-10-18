import {
  RUNTIME_EVENT_VERSION,
  type RuntimeEvent,
  type RuntimeFileChange,
  type RuntimeItem,
  type RuntimeItemStatus,
  type RuntimeItemType,
  type RuntimePlanEntry,
  type RuntimeProvider,
  type RuntimeTurnState,
  type RuntimeUsage
} from "./events.js";
import {
  arrayValue,
  compact,
  displayText,
  numberValue,
  objectValue,
  stringValue,
  unifiedDiff,
  type JsonRecord
} from "./util.js";

type EventBody = Omit<RuntimeEvent, "v" | "provider" | "raw" | "threadId" | "turnId" | "replay"> & {
  threadId?: string;
};

interface ToolState {
  item: RuntimeItem;
}

const SESSION_CONFIG_UPDATES = new Set([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update"
]);

export interface AcpAdapter {
  normalize(message: unknown): RuntimeEvent;
}

/**
 * ACP has no turn ids and (usually) no message ids, so the adapter is stateful
 * per run: it numbers turns (a `session/prompt` result closes one), numbers
 * assistant/reasoning segments within a turn (a tool call or plan between two
 * chunks starts a new message), and remembers each tool call so partial
 * `tool_call_update`s stay classified.
 */
export function createAcpAdapter(options: { provider: RuntimeProvider; sessionId?: string | null }): AcpAdapter {
  let sessionId = options.sessionId ?? undefined;
  let turn = 1;
  let segment = 0;
  let lastStream: "assistant" | "reasoning" | null = null;
  const tools = new Map<string, ToolState>();

  const turnId = (replay: boolean) => (replay ? "replay" : `turn-${turn}`);

  const textItemId = (stream: "assistant" | "reasoning", replay: boolean, messageId: string | undefined) => {
    if (lastStream !== stream) {
      segment += 1;
      lastStream = stream;
    }
    return messageId ?? `${turnId(replay)}:${stream}:${segment}`;
  };

  const breakText = () => {
    lastStream = null;
  };

  const sessionUpdate = (update: JsonRecord, replay: boolean): EventBody => {
    const kind = stringValue(update.sessionUpdate) ?? stringValue(update.session_update) ?? stringValue(update.type);
    const messageId = stringValue(update.messageId);
    switch (kind) {
      case "agent_message_chunk":
      case "agent_message_delta": {
        const text = contentText(update.content ?? update.delta) ?? "";
        return { type: "content.delta", itemId: textItemId("assistant", replay, messageId), text, delta: { stream: "assistant", text } };
      }
      case "agent_thought_chunk":
      case "agent_thought_delta": {
        const text = contentText(update.content ?? update.delta) ?? "";
        return { type: "content.delta", itemId: textItemId("reasoning", replay, messageId), text, delta: { stream: "reasoning", text } };
      }
      case "user_message_chunk":
        breakText();
        return { type: "user.message", itemId: messageId, text: contentText(update.content) };
      case "tool_call":
      case "tool_call_update":
        breakText();
        return toolCall(update, kind === "tool_call");
      case "plan":
        breakText();
        return { type: "turn.plan.updated", plan: { entries: arrayValue(update.entries).flatMap(planEntry) } };
      case "usage_update":
        return { type: "usage.updated", usage: contextUsage(update) };
      case "notice": {
        const severity = stringValue(update.severity);
        const message = stringValue(update.title) ?? "Notice";
        const detail = stringValue(update.description);
        if (severity === "error") return { type: "runtime.error", text: message, error: compact({ message, detail }) };
        return {
          type: "runtime.warning",
          text: message,
          notice: compact({ level: severity === "warning" ? ("warning" as const) : ("info" as const), message, detail })
        };
      }
      case "compaction_update": {
        breakText();
        const status = stringValue(update.status);
        return {
          type: status === "in_progress" ? "item.started" : "item.completed",
          itemId: stringValue(update.compactionId),
          item: compact({
            itemType: "context_compaction" as const,
            status: status === "in_progress" ? ("in_progress" as const) : status === "completed" ? ("completed" as const) : ("failed" as const),
            title: "Context compacted",
            text: stringValue(update.summary)
          })
        };
      }
      default:
        if (kind && SESSION_CONFIG_UPDATES.has(kind)) return { type: "session.configured" };
        return { type: "provider.event" };
    }
  };

  const toolCall = (update: JsonRecord, isStart: boolean): EventBody => {
    const itemId = stringValue(update.toolCallId);
    const previous = itemId ? tools.get(itemId)?.item : undefined;
    const item = mergeToolItem(previous, update);
    if (itemId) tools.set(itemId, { item });
    const terminal = item.status !== "in_progress";
    return {
      type: terminal ? "item.completed" : isStart || !previous ? "item.started" : "item.updated",
      itemId,
      text: item.title,
      item
    };
  };

  const response = (record: JsonRecord): EventBody => {
    const error = objectValue(record.error);
    // Requests the runner recovers from (model or option fallbacks, a failed
    // session/load that starts a fresh session) are kept raw, not shown.
    if (error && record.aisevakRecovered === true) return { type: "provider.event" };
    if (error) {
      const data = objectValue(error.data);
      const detail = stringValue(data?.message) ?? stringValue(data?.details) ?? stringValue(error.data);
      const message = detail && stringValue(error.message) === "Internal error" ? detail : stringValue(error.message) ?? "ACP request failed";
      return {
        type: "runtime.error",
        text: message,
        error: compact({ message, code: typeof error.code === "number" ? String(error.code) : undefined, detail: detail === message ? undefined : detail })
      };
    }
    const result = objectValue(record.result) ?? {};
    const stopReason = stringValue(result.stopReason);
    if (stopReason) {
      const state = stopState(stopReason);
      return compact({
        type: "turn.completed" as const,
        text: state === "completed" ? undefined : stopMessage(stopReason),
        turn: compact({ state, stopReason, errorMessage: state === "failed" ? stopMessage(stopReason) : undefined }),
        usage: turnUsage(objectValue(result.usage))
      });
    }
    const createdSession = stringValue(result.sessionId);
    if (createdSession) return { type: "thread.started", threadId: createdSession };
    return { type: "session.configured" };
  };

  return {
    normalize(message: unknown): RuntimeEvent {
      const record = objectValue(message);
      const replay = record?.aisevakReplay === true;
      const method = stringValue(record?.method);
      const params = objectValue(record?.params) ?? {};
      let body: EventBody;
      if (!record) body = { type: "provider.event" };
      else if (method === "session/update" || method === "session/update_session") {
        body = sessionUpdate(objectValue(params.update) ?? params, replay);
      } else if (method === "session/request_permission") {
        const toolCallRecord = objectValue(params.toolCall);
        body = { type: "request.opened", itemId: stringValue(toolCallRecord?.toolCallId), text: stringValue(toolCallRecord?.title) };
      } else if (method) body = { type: "provider.event" };
      else body = response(record);

      const eventTurnId = turnId(replay);
      if (body.type === "turn.completed" && !replay) {
        turn += 1;
        segment = 0;
        lastStream = null;
      }
      const threadId =
        body.threadId ?? stringValue(params.sessionId) ?? stringValue(objectValue(record?.result)?.sessionId) ?? sessionId;
      if (threadId) sessionId = threadId;
      return compact({
        v: RUNTIME_EVENT_VERSION,
        provider: options.provider,
        ...body,
        threadId,
        turnId: eventTurnId,
        replay: replay ? (true as const) : undefined,
        raw: compact({ source: "acp.jsonrpc" as const, method, payload: message })
      }) as RuntimeEvent;
    }
  };
}

function mergeToolItem(previous: RuntimeItem | undefined, update: JsonRecord): RuntimeItem {
  const meta = objectValue(update._meta);
  const claude = objectValue(meta?.claudeCode);
  const toolName = stringValue(claude?.toolName) ?? stringValue(update.name) ?? previous?.toolName;
  const itemType = toolItemType(stringValue(update.kind), toolName) ?? previous?.itemType ?? "dynamic_tool_call";
  const rawInput = objectValue(update.rawInput);
  const command = commandText(rawInput?.command) ?? previous?.command;
  const content = arrayValue(update.content);
  const changes = content.flatMap(diffChange);
  const contentOutput = content
    .flatMap((entry) => {
      const record = objectValue(entry);
      return stringValue(record?.type) === "content" ? [contentText(record?.content)].filter(Boolean) : [];
    })
    .join("\n");
  const status = toolStatus(stringValue(update.status), previous?.status);
  // A pending tool_call's text content is its description (Claude Code), not output.
  const output =
    rawOutputText(update.rawOutput) ||
    (status !== "in_progress" ? stripFence(contentOutput) : "") ||
    stringValue(objectValue(claude?.toolResponse)?.stdout) ||
    previous?.output;
  const locations = arrayValue(update.locations).flatMap((location) => {
    const path = stringValue(objectValue(location)?.path);
    return path ? [path] : [];
  });
  const title = plainTitle(stringValue(update.title)) ?? previous?.title ?? command ?? toolName;
  const displayTitle = title && title === toolName ? mcpToolLabel(title) : title;
  return compact({
    itemType,
    status,
    title: displayTitle,
    command: itemType === "command_execution" ? command : undefined,
    exitCode: numberValue(objectValue(update.rawOutput)?.exitCode) ?? numberValue(objectValue(update.rawOutput)?.exit_code) ?? previous?.exitCode,
    output,
    changes: changes.length > 0 ? changes : previous?.changes,
    toolName,
    input: update.rawInput ?? previous?.input,
    locations: locations.length > 0 ? locations : previous?.locations
  });
}

/** Claude Code fences tool output as markdown (```console ... ```). */
function stripFence(text: string): string {
  return /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text.trim())?.[1] ?? text;
}

/** `mcp__github__get_issue` → `github.get_issue`. */
function mcpToolLabel(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[1]}.${match[2]}` : name;
}

/** Claude Code titles tool calls with markdown code spans ("Edit `config.json`"). */
function plainTitle(title: string | undefined): string | undefined {
  return title?.replace(/`([^`]*)`/g, "$1").trim() || undefined;
}

function toolItemType(kind: string | undefined, toolName: string | undefined): RuntimeItemType | undefined {
  if (toolName && /^(task|agent)$/i.test(toolName)) return "subagent";
  if (toolName?.startsWith("mcp__")) return "mcp_tool_call";
  if (toolName && /^websearch$/i.test(toolName)) return "web_search";
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "read":
      return "file_read";
    case "search":
      return "search";
    case "fetch":
      return "web_fetch";
    case "think":
    case "switch_mode":
    case "other":
      return "dynamic_tool_call";
    default:
      return undefined;
  }
}

function toolStatus(status: string | undefined, previous: RuntimeItemStatus | undefined): RuntimeItemStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
    case "inProgress":
      return "in_progress";
    default:
      return previous ?? "in_progress";
  }
}

function diffChange(entry: unknown): RuntimeFileChange[] {
  const record = objectValue(entry);
  if (stringValue(record?.type) !== "diff") return [];
  const path = stringValue(record?.path);
  const newText = typeof record?.newText === "string" ? record.newText : undefined;
  if (!path || newText === undefined) return [];
  const oldText = typeof record?.oldText === "string" ? record.oldText : null;
  return [{ path, kind: oldText === null ? "add" : "update", diff: unifiedDiff(path, oldText, newText) }];
}

function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  const parts = arrayValue(value).filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function rawOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  const record = objectValue(value);
  if (!record) return displayText(value);
  const direct =
    stringValue(record.output) ??
    stringValue(record.formatted_output) ??
    stringValue(record.aggregated_output) ??
    [stringValue(record.stdout), stringValue(record.stderr)].filter(Boolean).join("\n");
  return direct || contentText(record.content) || undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = objectValue(value);
  if (record) {
    const type = stringValue(record.type);
    if (type === "image") return "[image]";
    if (type === "resource_link") return stringValue(record.uri);
    return stringValue(record.text) ?? contentText(record.content) ?? stringValue(objectValue(record.resource)?.text);
  }
  const parts = arrayValue(value).flatMap((entry) => {
    const text = contentText(entry);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("") : undefined;
}

function planEntry(value: unknown): RuntimePlanEntry[] {
  const entry = objectValue(value);
  const step = stringValue(entry?.content) ?? stringValue(entry?.title);
  if (!step) return [];
  const status = stringValue(entry?.status);
  return [{ step, status: status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending" }];
}

function contextUsage(update: JsonRecord): RuntimeUsage {
  const cost = objectValue(update.cost);
  const amount = numberValue(cost?.amount);
  return compact({
    scope: "context" as const,
    usedTokens: numberValue(update.used),
    maxTokens: numberValue(update.size),
    cost: amount !== undefined ? { amount, currency: stringValue(cost?.currency) ?? "USD" } : undefined
  });
}

function turnUsage(usage: JsonRecord | undefined): RuntimeUsage | undefined {
  if (!usage) return undefined;
  return compact({
    scope: "turn" as const,
    inputTokens: numberValue(usage.inputTokens),
    cachedInputTokens: numberValue(usage.cachedReadTokens),
    outputTokens: numberValue(usage.outputTokens),
    reasoningTokens: numberValue(usage.thoughtTokens),
    totalTokens: numberValue(usage.totalTokens)
  });
}

function stopState(stopReason: string): RuntimeTurnState {
  switch (stopReason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

function stopMessage(stopReason: string): string {
  switch (stopReason) {
    case "max_tokens":
      return "The model hit its output token limit";
    case "max_turn_requests":
      return "The agent hit its per-turn request limit";
    case "refusal":
      return "The model refused to continue";
    case "cancelled":
      return "The turn was cancelled";
    default:
      return `The turn stopped: ${stopReason}`;
  }
}

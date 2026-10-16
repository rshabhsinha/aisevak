import {
  RUNTIME_EVENT_VERSION,
  type RuntimeEvent,
  type RuntimeFileChange,
  type RuntimeItem,
  type RuntimeItemStatus,
  type RuntimePlanEntry,
  type RuntimeTurnState
} from "./events.js";
import { arrayValue, compact, contentItemsText, numberValue, objectValue, stringValue, type JsonRecord } from "./util.js";

type EventBody = Omit<RuntimeEvent, "v" | "provider" | "raw" | "threadId" | "turnId"> & {
  threadId?: string;
  turnId?: string;
};

const DELTA_STREAMS = {
  "item/agentMessage/delta": "assistant",
  "item/reasoning/textDelta": "reasoning",
  "item/reasoning/summaryTextDelta": "reasoning_summary",
  "item/commandExecution/outputDelta": "command_output",
  "item/fileChange/outputDelta": "file_change_output",
  "item/plan/delta": "plan"
} as const;

const WARNING_METHODS = new Set(["warning", "configWarning", "deprecationNotice", "guardianWarning"]);

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/fileRead/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
  "mcpServer/elicitation/request",
  "item/tool/requestUserInput"
]);

/** Map one Codex app-server JSON-RPC message onto a canonical event. */
export function normalizeCodexMessage(message: unknown): RuntimeEvent {
  const record = objectValue(message);
  const method = stringValue(record?.method);
  const params = objectValue(record?.params) ?? {};
  const body = record ? codexBody(record, method, params) : { type: "provider.event" as const };
  return compact({
    v: RUNTIME_EVENT_VERSION,
    provider: "codex",
    ...body,
    threadId: body.threadId ?? codexThreadId(record, params),
    turnId: body.turnId ?? stringValue(params.turnId) ?? stringValue(objectValue(params.turn)?.id),
    raw: compact({ source: "codex.app-server" as const, method, payload: message })
  }) as RuntimeEvent;
}

function codexBody(record: JsonRecord, method: string | undefined, params: JsonRecord): EventBody {
  if (!method) {
    // A JSON-RPC response to one of our requests.
    const error = objectValue(record.error);
    if (error) {
      const message = stringValue(error.message) ?? "Codex request failed";
      return { type: "runtime.error", text: message, error: compact({ message, code: codeString(error.code) }) };
    }
    return { type: "session.configured" };
  }

  if (record.id !== undefined) {
    if (APPROVAL_METHODS.has(method)) {
      const item = objectValue(params.item);
      const title = stringValue(params.reason) ?? stringValue(params.command) ?? stringValue(item?.command) ?? method;
      return { type: "request.opened", text: title, itemId: stringValue(params.itemId) ?? stringValue(item?.id) };
    }
    return { type: "provider.event" };
  }

  const stream = DELTA_STREAMS[method as keyof typeof DELTA_STREAMS];
  if (stream) {
    const text = stringValue(params.delta) ?? "";
    return { type: "content.delta", itemId: stringValue(params.itemId), text, delta: { stream, text } };
  }

  switch (method) {
    case "thread/started":
      return { type: "thread.started", threadId: stringValue(objectValue(params.thread)?.id) };
    case "turn/started":
      return { type: "turn.started", turn: { state: "in_progress" } };
    case "turn/completed":
      return turnCompleted(objectValue(params.turn) ?? {});
    case "turn/plan/updated":
      return {
        type: "turn.plan.updated",
        plan: compact({
          explanation: stringValue(params.explanation),
          entries: arrayValue(params.plan).flatMap(planEntry)
        })
      };
    case "turn/diff/updated": {
      const diff = stringValue(params.diff);
      return diff ? { type: "turn.diff.updated", diff: { unifiedDiff: diff } } : { type: "provider.event" };
    }
    case "thread/tokenUsage/updated":
      return tokenUsage(objectValue(params.tokenUsage) ?? {});
    case "item/started":
    case "item/completed":
      return itemEvent(method, objectValue(params.item) ?? {});
    case "item/fileChange/patchUpdated":
      return {
        type: "item.updated",
        itemId: stringValue(params.itemId),
        item: { itemType: "file_change", status: "in_progress", changes: arrayValue(params.changes).flatMap(fileChange) }
      };
    case "item/mcpToolCall/progress":
      return {
        type: "item.updated",
        itemId: stringValue(params.itemId),
        text: stringValue(params.message),
        item: compact({ itemType: "mcp_tool_call" as const, status: "in_progress" as const, text: stringValue(params.message) })
      };
    case "error": {
      const error = objectValue(params.error) ?? {};
      const message = stringValue(error.message) ?? "Codex reported an error";
      const code = codexErrorCode(error.codexErrorInfo);
      if (params.willRetry === true) {
        return { type: "runtime.warning", text: message, notice: compact({ level: "warning" as const, message, detail: code }) };
      }
      return {
        type: "runtime.error",
        text: message,
        error: compact({ message, code, detail: stringValue(error.additionalDetails) })
      };
    }
    case "model/rerouted": {
      const message = `Model rerouted from ${stringValue(params.fromModel) ?? "?"} to ${stringValue(params.toModel) ?? "?"}`;
      return { type: "runtime.warning", text: message, notice: compact({ level: "warning" as const, message, detail: stringValue(params.reason) }) };
    }
    default:
      if (WARNING_METHODS.has(method)) {
        const message = stringValue(params.message) ?? stringValue(params.summary) ?? method;
        return { type: "runtime.warning", text: message, notice: compact({ level: "warning" as const, message, detail: stringValue(params.details) }) };
      }
      if (method === "thread/settings/updated") return { type: "session.configured" };
      // Status noise: mcp startup, rate limits, thread status, remote control, goals, skills.
      return { type: "provider.event" };
  }
}

function turnCompleted(turn: JsonRecord): EventBody {
  const status = stringValue(turn.status);
  const state: RuntimeTurnState =
    status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : status === "inProgress" ? "completed" : "failed";
  const error = objectValue(turn.error);
  const errorMessage = stringValue(error?.message);
  return {
    type: "turn.completed",
    turnId: stringValue(turn.id),
    text: errorMessage,
    turn: compact({
      state,
      errorMessage,
      errorCode: codexErrorCode(error?.codexErrorInfo),
      durationMs: numberValue(turn.durationMs)
    })
  };
}

function tokenUsage(usage: JsonRecord): EventBody {
  const last = objectValue(usage.last) ?? {};
  const total = objectValue(usage.total) ?? {};
  return {
    type: "usage.updated",
    usage: compact({
      scope: "context" as const,
      usedTokens: numberValue(last.totalTokens),
      maxTokens: numberValue(usage.modelContextWindow),
      inputTokens: numberValue(last.inputTokens),
      cachedInputTokens: numberValue(last.cachedInputTokens),
      outputTokens: numberValue(last.outputTokens),
      reasoningTokens: numberValue(last.reasoningOutputTokens),
      totalTokens: numberValue(total.totalTokens)
    })
  };
}

function itemEvent(method: "item/started" | "item/completed", item: JsonRecord): EventBody {
  const itemId = stringValue(item.id);
  const type = stringValue(item.type);
  if (type === "userMessage") {
    return { type: "user.message", itemId, text: userMessageText(item) };
  }
  const mapped = codexItem(item, method === "item/started");
  return {
    type: method === "item/started" ? "item.started" : "item.completed",
    itemId,
    text: mapped.text ?? mapped.title,
    item: mapped
  };
}

export function codexItem(item: JsonRecord, started: boolean): RuntimeItem {
  const status = itemStatus(item.status, started);
  switch (stringValue(item.type)) {
    case "agentMessage":
      return compact({ itemType: "assistant_message" as const, status, text: stringValue(item.text) });
    case "reasoning": {
      const summary = arrayValue(item.summary).filter((part): part is string => typeof part === "string");
      const content = arrayValue(item.content).filter((part): part is string => typeof part === "string");
      const text = (summary.length > 0 ? summary : content).join("\n\n");
      return compact({ itemType: "reasoning" as const, status, text: text || undefined });
    }
    case "plan":
      return compact({ itemType: "plan" as const, status, text: stringValue(item.text) });
    case "commandExecution": {
      const exitCode = numberValue(item.exitCode);
      const command = unwrapShell(stringValue(item.command));
      return compact({
        itemType: "command_execution" as const,
        status: exitCode !== undefined && exitCode !== 0 && status === "completed" ? "failed" : status,
        title: command,
        command,
        cwd: stringValue(item.cwd),
        exitCode,
        output: stringValue(item.aggregatedOutput)
      });
    }
    case "fileChange": {
      const changes = arrayValue(item.changes).flatMap(fileChange);
      return compact({
        itemType: "file_change" as const,
        status,
        title: changes.length === 1 ? changes[0]!.path : changes.length > 1 ? `${changes.length} files` : undefined,
        changes
      });
    }
    case "mcpToolCall": {
      const toolName = [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join(".") || undefined;
      const error = objectValue(item.error);
      return compact({
        itemType: "mcp_tool_call" as const,
        status,
        title: toolName,
        toolName,
        input: item.arguments,
        output: stringValue(error?.message) ?? contentItemsText(item.result)
      });
    }
    case "dynamicToolCall":
      return compact({
        itemType: "dynamic_tool_call" as const,
        status: item.success === false ? "failed" : status,
        title: stringValue(item.tool),
        toolName: stringValue(item.tool),
        input: item.arguments,
        output: contentItemsText(item.contentItems)
      });
    case "collabAgentToolCall":
    case "subAgentActivity":
      return compact({
        itemType: "subagent" as const,
        status,
        title: stringValue(item.prompt)?.split("\n")[0] ?? stringValue(item.tool) ?? stringValue(item.agentPath) ?? "Subagent",
        toolName: stringValue(item.tool)
      });
    case "webSearch":
      return compact({ itemType: "web_search" as const, status, title: stringValue(item.query) ?? "Web search" });
    case "imageView":
      return compact({ itemType: "image_view" as const, status, title: stringValue(item.path) });
    case "contextCompaction":
      return { itemType: "context_compaction", status, title: "Context compacted" };
    default:
      return compact({ itemType: "other" as const, status, title: stringValue(item.type) });
  }
}

/** Codex runs commands as `/bin/zsh -lc '<command>'`; show the command itself. */
export function unwrapShell(command: string | undefined): string | undefined {
  const match = command && /^(?:\/usr)?\/bin\/(?:ba|z)?sh -lc '(.*)'$/s.exec(command);
  return match ? match[1]!.replace(/'\\''/g, "'") : command;
}

function itemStatus(value: unknown, started: boolean): RuntimeItemStatus {
  switch (stringValue(value)) {
    case "inProgress":
      return started ? "in_progress" : "completed";
    case "failed":
    case "interrupted":
      return "failed";
    case "declined":
      return "declined";
    case "completed":
      return "completed";
    default:
      return started ? "in_progress" : "completed";
  }
}

function fileChange(value: unknown): RuntimeFileChange[] {
  const change = objectValue(value);
  const path = stringValue(change?.path);
  if (!change || !path) return [];
  const kindValue = change.kind;
  const kindRecord = objectValue(kindValue);
  const kindName = stringValue(kindValue) ?? stringValue(kindRecord?.type) ?? "update";
  const movePath = stringValue(kindRecord?.move_path) ?? stringValue(kindRecord?.movePath);
  const kind: RuntimeFileChange["kind"] =
    kindName === "add" ? "add" : kindName === "delete" ? "delete" : movePath ? "move" : "update";
  return [compact({ path, kind, movePath, diff: stringValue(change.diff) })];
}

function planEntry(value: unknown): RuntimePlanEntry[] {
  const entry = objectValue(value);
  const step = stringValue(entry?.step);
  if (!step) return [];
  const status = stringValue(entry?.status);
  return [{ step, status: status === "completed" ? "completed" : status === "inProgress" ? "in_progress" : "pending" }];
}

function userMessageText(item: JsonRecord): string | undefined {
  const parts = arrayValue(item.content).flatMap((part) => {
    const text = stringValue(objectValue(part)?.text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function codexErrorCode(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  const record = objectValue(info);
  return record ? Object.keys(record)[0] : undefined;
}

function codeString(value: unknown): string | undefined {
  return typeof value === "number" ? String(value) : stringValue(value);
}

function codexThreadId(record: JsonRecord | undefined, params: JsonRecord): string | undefined {
  const result = objectValue(record?.result);
  return (
    stringValue(params.threadId) ??
    stringValue(objectValue(params.thread)?.id) ??
    stringValue(result?.threadId) ??
    stringValue(objectValue(result?.thread)?.id)
  );
}

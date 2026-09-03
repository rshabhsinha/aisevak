import type { NormalizedCodexEvent } from "./types.js";

export interface AcpClientInfo {
  name: string;
  version: string;
}

export function buildAcpInitializeParams(clientInfo: AcpClientInfo = { name: "aisevak", version: "0.1.0" }) {
  return {
    protocolVersion: 1,
    clientInfo,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { parameterizedModelPicker: true }
    }
  };
}

export function buildCursorAcpArgs(apiEndpoint?: string | null): string[] {
  return [...(apiEndpoint?.trim() ? ["-e", apiEndpoint.trim()] : []), "acp"];
}

export function buildOpenCodeAcpArgs(): string[] {
  return ["acp"];
}

export function acpPermissionDecision(params: Record<string, unknown>): { outcome: { outcome: "selected"; optionId: string } } {
  const options = Array.isArray(params.options) ? params.options : [];
  const optionIds = options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const optionId = stringValue((option as Record<string, unknown>).optionId);
    return optionId ? [optionId] : [];
  });
  const preferred =
    optionIds.find((id) => /allow_always|allow-always|always_allow/i.test(id)) ??
    optionIds.find((id) => /^allow$/i.test(id)) ??
    optionIds.find((id) => /allow|proceed|approve|yes/i.test(id)) ??
    optionIds[0] ??
    "allow";
  return { outcome: { outcome: "selected", optionId: preferred } };
}

export function extractAcpSessionId(value: unknown): string | undefined {
  const record = objectValue(value);
  return (
    stringValue(record?.sessionId) ??
    stringValue(record?.session_id) ??
    stringValue(objectValue(record?.session)?.sessionId) ??
    stringValue(objectValue(record?.session)?.id)
  );
}

export function normalizeAcpEvent(raw: unknown, sessionId?: string | null): NormalizedCodexEvent {
  const record = objectValue(raw);
  if (!record) return { type: "unknown", raw, threadId: sessionId ?? undefined };

  const method = stringValue(record.method);
  const params = objectValue(record.params) ?? {};
  const threadId =
    extractAcpSessionId(params) ??
    extractAcpSessionId(record.result) ??
    sessionId ??
    undefined;

  if (method === "session/update" || method === "session/update_session") {
    return normalizeSessionUpdate(params, threadId, raw);
  }

  if (method === "session/request_permission") {
    return {
      type: "session/request_permission",
      threadId,
      itemId: stringValue(objectValue(params.toolCall)?.toolCallId),
      text: stringValue(objectValue(params.toolCall)?.title),
      raw
    };
  }

  if (method) {
    return { type: method, threadId, raw };
  }

  return { type: "unknown", threadId, raw };
}

function normalizeSessionUpdate(
  params: Record<string, unknown>,
  threadId: string | undefined,
  raw: unknown
): NormalizedCodexEvent {
  const update = objectValue(params.update) ?? params;
  const kind =
    stringValue(update.sessionUpdate) ??
    stringValue(update.session_update) ??
    stringValue(update.type) ??
    "session/update";
  const toolCall = objectValue(update.toolCall) ?? objectValue(update);
  const content = objectValue(update.content) ?? objectValue(update.delta);
  const text =
    collectAcpText(update.content) ??
    collectAcpText(update.delta) ??
    stringValue(update.text) ??
    stringValue(content?.text) ??
    stringValue(toolCall?.title);
  const itemId =
    stringValue(update.toolCallId) ??
    stringValue(toolCall?.toolCallId) ??
    stringValue(toolCall?.id) ??
    stringValue(update.itemId);

  if (kind === "agent_message_chunk" || kind === "agent_message_delta") {
    return {
      type: "item/agentMessage/delta",
      text,
      threadId,
      itemId: itemId ?? "assistant",
      raw: {
        method: "item/agentMessage/delta",
        params: {
          threadId,
          item: { id: itemId ?? "assistant", type: "agentMessage", text },
          delta: text
        }
      }
    };
  }

  if (kind === "agent_thought_chunk" || kind === "agent_thought_delta") {
    return {
      type: "item/completed",
      text,
      threadId,
      itemId: itemId ?? "reasoning",
      raw: {
        method: "item/completed",
        params: {
          threadId,
          item: { id: itemId ?? "reasoning", type: "reasoning", text }
        }
      }
    };
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    const status = stringValue(update.status) ?? stringValue(toolCall?.status);
    const command =
      stringValue(objectValue(toolCall?.rawInput)?.command) ??
      stringValue(objectValue(update.rawInput)?.command) ??
      stringValue(toolCall?.title);
    return {
      type: status === "completed" || status === "failed" ? "item/completed" : "item/started",
      text: stringValue(toolCall?.title) ?? text,
      threadId,
      itemId,
      status,
      raw: {
        method: status === "completed" || status === "failed" ? "item/completed" : "item/started",
        params: {
          threadId,
          item: {
            id: itemId,
            type: "command_execution",
            command,
            status: acpToolStatus(status),
            aggregated_output: collectAcpText(toolCall?.content) ?? text
          }
        }
      }
    };
  }

  if (kind === "message" || kind === "agent_message") {
    return {
      type: "item/completed",
      text,
      threadId,
      itemId: itemId ?? "assistant",
      raw: {
        method: "item/completed",
        params: {
          threadId,
          item: { id: itemId ?? "assistant", type: "agentMessage", text }
        }
      }
    };
  }

  return { type: kind, text, threadId, itemId, raw };
}

function acpToolStatus(status: string | undefined): string {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

function collectAcpText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const record = objectValue(value);
  if (record) {
    return stringValue(record.text) ?? collectAcpText(record.content);
  }
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    const text = collectAcpText(item);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("") : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

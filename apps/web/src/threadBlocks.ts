export interface ThreadEvent {
  id: string;
  seq: number;
  event_type: string;
  text?: string | null;
  payload: unknown;
  created_at?: string;
}

export interface ThreadRunRef {
  id: string;
  status: string;
  prompt?: string | null;
  queued_at?: string | null;
  started_at?: string | null;
}

export interface PendingUserMessage {
  id: string;
  text: string;
  createdAt: string;
}

export type ToolStatus = "running" | "completed" | "failed";

export interface ThreadToolCall {
  id: string;
  title: string;
  command?: string;
  detail?: string;
  status: ToolStatus;
  exitCode?: number | null;
  icon: "terminal" | "search" | "wrench" | "hammer" | "edit" | "info";
  createdAt: string;
}

export interface ThreadPlanItem {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
}

export type ThreadBlock =
  | { kind: "user"; id: string; text: string; createdAt: string }
  | {
      kind: "assistant";
      id: string;
      itemId: string;
      text: string;
      createdAt: string;
      completedAt?: string;
      streaming: boolean;
    }
  | { kind: "thinking"; id: string; text: string; createdAt: string; streaming: boolean }
  | { kind: "tools"; id: string; entries: ThreadToolCall[]; createdAt: string }
  | { kind: "plan"; id: string; items: ThreadPlanItem[]; createdAt: string }
  | { kind: "comment"; id: string; text: string; createdAt: string }
  | { kind: "error"; id: string; label: string; detail?: string; createdAt: string }
  | { kind: "system"; id: string; text: string; createdAt: string }
  | { kind: "working"; id: string; createdAt: string | null };

const ASSISTANT_ITEM_TYPES = new Set(["agent_message", "agentMessage", "agent_message_chunk"]);
const REASONING_ITEM_TYPES = new Set(["reasoning", "agent_thought", "thought"]);
const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "commandExecution",
  "mcp_tool_call",
  "mcpToolCall",
  "dynamic_tool_call",
  "dynamicToolCall",
  "web_search",
  "webSearch",
  "file_change",
  "fileChange",
  "collab_agent_tool_call",
  "image_view",
  "review",
  "tool_call"
]);

// Persisted `seq` is the authoritative event order: the runner assigns it per
// line it reads, while `created_at` comes from whichever insert statement
// landed first and is NOT monotonic with seq for batched writes. Sorting by
// created_at scrambles streamed text chunks (Devin's token-granularity deltas
// rendered as interleaved fragments), so always order by seq.
export function compareThreadEvents(left: ThreadEvent, right: ThreadEvent): number {
  return left.seq - right.seq || String(left.id).localeCompare(String(right.id));
}

export function deriveThreadBlocks(input: {
  run: ThreadRunRef | null;
  events: ThreadEvent[];
  pendingMessages?: PendingUserMessage[];
}): ThreadBlock[] {
  const sortedEvents = [...input.events].sort(compareThreadEvents);
  const blocks: ThreadBlock[] = [];
  const blockIndex = new Map<string, number>();
  const fallbackCreatedAt =
    input.run?.started_at ?? input.run?.queued_at ?? new Date(0).toISOString();

  const push = (block: ThreadBlock): ThreadBlock => {
    blockIndex.set(block.id, blocks.length);
    blocks.push(block);
    return block;
  };
  const replace = (block: ThreadBlock) => {
    const index = blockIndex.get(block.id);
    if (index === undefined) {
      push(block);
      return;
    }
    blocks[index] = block;
  };

  const assistantByItemId = new Map<string, Extract<ThreadBlock, { kind: "assistant" }>>();
  const toolByItemId = new Map<string, { blockId: string; entryIndex: number }>();
  let thinkingBlock: Extract<ThreadBlock, { kind: "thinking" }> | null = null;
  let planBlockId: string | null = null;
  const hasUserMessageEvent = sortedEvents.some(
    (event) => event.event_type === "thread.message-sent"
  );

  if (input.run?.prompt?.trim() && !hasUserMessageEvent) {
    push({
      kind: "user",
      id: `prompt:${input.run.id}`,
      text: input.run.prompt,
      createdAt: fallbackCreatedAt
    });
  }

  const touchThinking = (createdAt: string) => {
    if (thinkingBlock) return thinkingBlock;
    thinkingBlock = {
      kind: "thinking",
      id: `thinking:${createdAt}:${blocks.length}`,
      text: "",
      createdAt,
      streaming: true
    };
    push(thinkingBlock);
    return thinkingBlock;
  };

  const upsertAssistant = (
    itemId: string,
    createdAt: string,
    mutate: (block: Extract<ThreadBlock, { kind: "assistant" }>) => void
  ) => {
    let block = assistantByItemId.get(itemId);
    if (!block) {
      block = {
        kind: "assistant",
        id: `assistant:${itemId}:${blocks.length}`,
        itemId,
        text: "",
        createdAt,
        streaming: true
      };
      assistantByItemId.set(itemId, block);
      push(block);
    }
    mutate(block);
    replace({ ...block });
  };

  const upsertTool = (
    itemId: string,
    createdAt: string,
    mutate: (entry: ThreadToolCall) => void
  ) => {
    const existing = toolByItemId.get(itemId);
    if (existing) {
      const block = blocks[blockIndex.get(existing.blockId) ?? -1];
      if (block?.kind === "tools") {
        const entry = block.entries[existing.entryIndex];
        if (entry) {
          mutate(entry);
          replace({ ...block, entries: [...block.entries] });
        }
      }
      return;
    }
    // Attach to the immediately-preceding tools block so consecutive tool
    // calls share one card.
    const previous = blocks[blocks.length - 1];
    const target: Extract<ThreadBlock, { kind: "tools" }> =
      previous?.kind === "tools"
        ? previous
        : (push({
            kind: "tools",
            id: `tools:${createdAt}:${blocks.length}`,
            entries: [],
            createdAt
          }) as Extract<ThreadBlock, { kind: "tools" }>);
    const entry: ThreadToolCall = {
      id: itemId,
      title: "",
      status: "running",
      icon: "info",
      createdAt
    };
    mutate(entry);
    const entries = [...target.entries, entry];
    toolByItemId.set(itemId, {
      blockId: target.id,
      entryIndex: entries.length - 1
    });
    replace({ ...target, entries });
  };

  for (const event of sortedEvents) {
    const createdAt = event.created_at ?? fallbackCreatedAt;
    const normalized = rawRecord(event.payload);
    const raw = rawRecord(normalized?.raw) ?? normalized;
    const params = rawRecord(raw?.params);
    const item = rawRecord(raw?.item) ?? rawRecord(params?.item);
    const itemId =
      stringValue(item?.id) ??
      stringValue(params?.itemId) ??
      stringValue(params?.item_id) ??
      `event:${event.id}`;
    const itemType = stringValue(item?.type) ?? stringValue(params?.itemType) ?? "";

    if (event.event_type === "thread.message-sent") {
      const text = stringValue(normalized?.text) ?? event.text;
      if (text?.trim()) {
        push({ kind: "user", id: `user:${event.id}`, text, createdAt });
      }
      continue;
    }

    if (event.event_type === "task.comment") {
      const text = event.text ?? stringValue(normalized?.text);
      if (text?.trim()) {
        push({ kind: "comment", id: `comment:${event.id}`, text, createdAt });
      }
      continue;
    }

    if (event.event_type === "item/agentMessage/delta") {
      const delta = event.text ?? stringValue(params?.delta);
      if (!delta) continue;
      thinkingBlock = null;
      upsertAssistant(itemId, createdAt, (block) => {
        block.text += delta;
      });
      continue;
    }

    if (event.event_type === "plan" || event.event_type === "turn_plan_updated" || itemType === "plan") {
      const items = extractPlanItems(raw, params, item);
      if (items.length > 0) {
        const blockId: string = planBlockId ?? `plan:${event.id}`;
        planBlockId = blockId;
        const previous = blockIndex.has(blockId)
          ? (blocks[blockIndex.get(blockId)!] as Extract<ThreadBlock, { kind: "plan" }>)
          : undefined;
        replace({
          kind: "plan",
          id: blockId,
          items,
          createdAt: previous?.createdAt ?? createdAt
        });
      }
      continue;
    }

    if (REASONING_ITEM_TYPES.has(itemType) || event.event_type === "item/reasoning/delta") {
      const text =
        event.text ??
        stringValue(item?.text) ??
        stringValue(item?.content) ??
        stringArrayValue(item?.summary).join("\n") ??
        "";
      if (!text.trim()) continue;
      const block = touchThinking(createdAt);
      const merged = block.text ? `${block.text}\n\n${text}` : text;
      replace({ ...block, text: merged });
      continue;
    }

    if (ASSISTANT_ITEM_TYPES.has(itemType)) {
      const text = stringValue(item?.text) ?? stringValue(item?.content) ?? event.text;
      if (!text?.trim()) continue;
      upsertAssistant(itemId, createdAt, (block) => {
        block.text = text;
        block.completedAt = createdAt;
        block.streaming = false;
      });
      continue;
    }

    if (TOOL_ITEM_TYPES.has(itemType) || event.event_type === "session/request_permission") {
      thinkingBlock = null;
      const status = toolStatusOf(
        stringValue(item?.status) ?? stringValue(raw?.status),
        numberValue(item?.exit_code) ?? numberValue(item?.exitCode)
      );
      const title =
        stringValue(item?.title) ??
        stringValue(item?.tool_name) ??
        stringValue(item?.toolName) ??
        stringValue(item?.command) ??
        event.text ??
        "Tool call";
      const detail =
        stringValue(item?.aggregated_output) ??
        stringValue(item?.aggregatedOutput) ??
        stringValue(item?.output) ??
        stringValue(item?.result) ??
        (item ? diffTextFromFileChange(item) : undefined) ??
        stringValue(item?.content);
      upsertTool(itemId, createdAt, (entry) => {
        entry.title = title;
        entry.command = stringValue(item?.command);
        entry.detail = detail;
        entry.status = status;
        entry.exitCode = numberValue(item?.exit_code) ?? numberValue(item?.exitCode);
        entry.icon = toolIcon(itemType, entry.command, title);
      });
      continue;
    }

    if (event.event_type === "item/completed" && event.text?.trim()) {
      // Fallback: completed items with no recognizable type (e.g. legacy or
      // provider-specific message items) render as assistant text.
      thinkingBlock = null;
      upsertAssistant(itemId, createdAt, (block) => {
        block.text = event.text!;
        block.completedAt = createdAt;
        block.streaming = false;
      });
      continue;
    }

    if (
      event.event_type === "turn.failed" ||
      event.event_type === "parse.error" ||
      (event.event_type === "turn/completed" &&
        stringValue(rawRecord(rawRecord(raw?.params)?.turn)?.status) === "failed")
    ) {
      push({
        kind: "error",
        id: `error:${event.id}`,
        label: event.event_type === "parse.error" ? "Malformed JSONL event" : "Turn failed",
        detail: event.text ?? undefined,
        createdAt
      });
      continue;
    }

    if (event.event_type === "turn/completed") {
      for (const block of blocks) {
        if (block.kind === "assistant" && block.streaming) {
          block.completedAt = createdAt;
          block.streaming = false;
        }
        if (block.kind === "thinking" && block.streaming) block.streaming = false;
      }
      continue;
    }

    if (event.event_type === "thread.started" || event.event_type === "thread/started") {
      const rawParams = rawRecord(raw?.params);
      const threadId =
        stringValue(raw?.thread_id) ??
        stringValue(rawParams?.threadId) ??
        stringValue(rawRecord(rawParams?.thread)?.id) ??
        stringValue(normalized?.threadId);
      if (threadId) {
        push({
          kind: "system",
          id: `system:${event.id}`,
          text: `Session ${threadId}`,
          createdAt
        });
      }
      continue;
    }
    // All other event kinds (config/mode/commands/usage/session_info/unknown)
    // are provider noise that the unified view intentionally drops.
  }

  for (const message of input.pendingMessages ?? []) {
    push({
      kind: "user",
      id: `pending:${message.id}`,
      text: message.text,
      createdAt: message.createdAt
    });
  }

  // An interrupted run leaves open streaming markers; only keep them when the
  // run is actually still active.
  const runActive = input.run ? isActiveRunStatus(input.run.status) : false;
  if (!runActive) {
    for (const block of blocks) {
      if ((block.kind === "assistant" || block.kind === "thinking") && block.streaming) {
        block.streaming = false;
      }
    }
  }

  // Blocks were appended in seq order; do NOT re-sort by createdAt — those
  // timestamps are not monotonic for batched event writes.
  if (runActive) {
    blocks.push({
      kind: "working",
      id: "working-indicator",
      createdAt: input.run!.started_at ?? input.run!.queued_at ?? null
    });
  }

  return blocks;
}

export function isActiveRunStatus(status: string): boolean {
  return ["queued", "running", "cancel_requested"].includes(status);
}

function toolStatusOf(status: string | undefined, exitCode: number | null): ToolStatus {
  if (exitCode !== null && exitCode !== 0) return "failed";
  if (!status) return "completed";
  const lowered = status.toLowerCase();
  if (lowered === "failed" || lowered === "error") return "failed";
  if (["in_progress", "inprogress", "pending", "running", "started"].includes(lowered)) {
    return "running";
  }
  return "completed";
}

function toolIcon(
  itemType: string,
  command: string | undefined,
  title: string
): ThreadToolCall["icon"] {
  if (itemType === "command_execution" || itemType === "commandExecution" || command) {
    return "terminal";
  }
  if (itemType === "web_search" || itemType === "webSearch") return "search";
  if (itemType === "mcp_tool_call" || itemType === "mcpToolCall") return "wrench";
  if (itemType === "dynamic_tool_call" || itemType === "dynamicToolCall") return "hammer";
  if (itemType === "file_change" || itemType === "fileChange" || itemType === "review") return "edit";
  if (/search|fetch|browse/i.test(title)) return "search";
  return "info";
}

function diffTextFromFileChange(item: Record<string, unknown>): string | undefined {
  const changes = item.changes;
  if (!Array.isArray(changes)) return undefined;
  const diffs = changes
    .map((change) => {
      const record = rawRecord(change);
      const path = stringValue(record?.path) ?? "file";
      const diff = stringValue(record?.diff) ?? stringValue(record?.content);
      return diff ? `--- a/${path}\n+++ b/${path}\n${diff}` : null;
    })
    .filter((diff): diff is string => Boolean(diff));
  return diffs.length > 0 ? diffs.join("\n") : undefined;
}

function extractPlanItems(
  raw: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined
): ThreadPlanItem[] {
  // ACP `plan` updates carry params.update.entries; Codex plan items carry
  // item.plan/todo arrays. Cover both.
  const update = rawRecord(params?.update);
  const candidates = [
    update?.entries,
    rawRecord(raw?.update)?.entries,
    item?.plan,
    item?.todos,
    item?.entries,
    params?.plan,
    params?.entries
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const items = candidate
      .map((entry, index): ThreadPlanItem | null => {
        const record = rawRecord(entry);
        const title =
          stringValue(record?.content) ??
          stringValue(record?.title) ??
          stringValue(record?.text) ??
          stringValue(record?.step) ??
          (typeof entry === "string" ? entry : undefined);
        if (!title) return null;
        return {
          id: stringValue(record?.id) ?? `plan-${index}`,
          title,
          status: planItemStatus(stringValue(record?.status))
        };
      })
      .filter((entry): entry is ThreadPlanItem => entry !== null);
    if (items.length > 0) return items;
  }
  return [];
}

function planItemStatus(status: string | undefined): ThreadPlanItem["status"] {
  switch (status?.toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "in_progress":
    case "inprogress":
    case "running":
      return "running";
    case "failed":
    case "error":
    case "cancelled":
      return "failed";
    default:
      return "pending";
  }
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

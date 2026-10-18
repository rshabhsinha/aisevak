import type {
  RuntimeEvent,
  RuntimeFileChange,
  RuntimeItem,
  RuntimeItemType,
  RuntimeUsage
} from "@aisevak/core/runtime-events";

export interface ThreadEvent {
  id: string;
  seq: number;
  event_type: string;
  text?: string | null;
  payload: unknown;
  created_at?: string;
  run_id?: string | null;
  dispatcher_run_id?: string | null;
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

export type ToolIcon = "terminal" | "search" | "read" | "web" | "wrench" | "hammer" | "edit" | "agent" | "info";

export interface ThreadFileDiff {
  path: string;
  diff: string;
}

export interface ThreadToolCall {
  id: string;
  title: string;
  command?: string;
  /** Final or streamed output (command stdout, tool result). */
  output?: string;
  diffs?: ThreadFileDiff[];
  status: ToolStatus;
  exitCode?: number | null;
  icon: ToolIcon;
  createdAt: string;
}

export interface ThreadPlanItem {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface ThreadUsage {
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cost?: { amount: number; currency: string };
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
  | { kind: "diff"; id: string; diffs: ThreadFileDiff[]; createdAt: string }
  | { kind: "usage"; id: string; usage: ThreadUsage; createdAt: string }
  | { kind: "comment"; id: string; text: string; createdAt: string }
  | { kind: "error"; id: string; label: string; detail?: string; createdAt: string }
  | { kind: "notice"; id: string; level: "info" | "warning"; text: string; detail?: string; createdAt: string }
  | { kind: "system"; id: string; text: string; createdAt: string }
  | { kind: "working"; id: string; createdAt: string | null };

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

  // A thread's event stream is the concatenation of per-run sequences — `seq`
  // and `itemId` are only unique within one run. Group events by their run so
  // streamed chunks accumulate into the correct message, then order run groups
  // by their earliest event timestamp (created_at IS monotonic across runs —
  // a later turn's events always land after the previous turn's writes).
  const runGroups = new Map<string, ThreadEvent[]>();
  for (const event of sortedEvents) {
    const key = event.run_id ?? event.dispatcher_run_id ?? "";
    const group = runGroups.get(key);
    if (group) group.push(event);
    else runGroups.set(key, [event]);
  }
  const orderedGroups = [...runGroups.values()].sort((left, right) =>
    (left[0]?.created_at ?? "").localeCompare(right[0]?.created_at ?? "")
  );

  for (const groupEvents of orderedGroups) {
    const providerEvents = groupEvents.filter(event => !isSteeringEvent(event));
    const steeringEvents = groupEvents.filter(isSteeringEvent).sort((left, right) =>
      (left.created_at ?? "").localeCompare(right.created_at ?? "") || left.id.localeCompare(right.id)
    );
    // Place synthetic inputs at their timestamp boundary without reordering
    // provider chunks, whose database timestamps can arrive out of order.
    const chronologicalEvents: ThreadEvent[] = [];
    let steeringIndex = 0;
    let latestTimestamp = "";
    for (const event of providerEvents) {
      latestTimestamp = [latestTimestamp, event.created_at ?? ""].sort().at(-1)!;
      while (steeringIndex < steeringEvents.length &&
        (steeringEvents[steeringIndex]!.created_at ?? "") < latestTimestamp) {
        chronologicalEvents.push(steeringEvents[steeringIndex++]!);
      }
      chronologicalEvents.push(event);
    }
    chronologicalEvents.push(...steeringEvents.slice(steeringIndex));
    processRunGroup(chronologicalEvents, fallbackCreatedAt, { push, replace, blockIndex, blocks });
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

function isSteeringEvent(event: ThreadEvent): boolean {
  return event.event_type === "thread.message-sent" && rawRecord(event.payload)?.steer === true;
}

type BlockOf<K extends ThreadBlock["kind"]> = Extract<ThreadBlock, { kind: K }>;

function processRunGroup(
  sortedEvents: ThreadEvent[],
  fallbackCreatedAt: string,
  ctx: {
    blocks: ThreadBlock[];
    blockIndex: Map<string, number>;
    push: (block: ThreadBlock) => ThreadBlock;
    replace: (block: ThreadBlock) => void;
  }
): void {
  const { blocks, blockIndex, push, replace } = ctx;
  const assistantByItemId = new Map<string, BlockOf<"assistant">>();
  const toolByItemId = new Map<string, { blockId: string; entryIndex: number }>();
  const reasoningByItemId = new Map<string, string>();
  let thinkingBlock: BlockOf<"thinking"> | null = null;
  let planBlockId: string | null = null;
  // Shown once at the end of the run, holding the latest values.
  const summary: {
    turnDiff: { diffs: ThreadFileDiff[]; createdAt: string } | null;
    usage: { usage: ThreadUsage; createdAt: string } | null;
  } = { turnDiff: null, usage: null };
  const groupStartIndex = blocks.length;

  // Text from a message is final once anything else happens in the run.
  const settleStreams = (createdAt: string) => {
    for (const block of assistantByItemId.values()) {
      if (block.streaming) {
        const next = { ...block, streaming: false, completedAt: block.completedAt ?? createdAt };
        assistantByItemId.set(block.itemId, next);
        replace(next);
      }
    }
  };

  const upsertAssistant = (itemId: string, createdAt: string, mutate: (block: BlockOf<"assistant">) => void) => {
    let block = assistantByItemId.get(itemId);
    if (!block) {
      settleStreams(createdAt);
      block = { kind: "assistant", id: `assistant:${itemId}:${blocks.length}`, itemId, text: "", createdAt, streaming: true };
      push(block);
    }
    const next = { ...block };
    mutate(next);
    assistantByItemId.set(itemId, next);
    replace(next);
  };

  const updateThinking = (itemId: string, createdAt: string, text: string, mode: "append" | "replace") => {
    if (!thinkingBlock) {
      thinkingBlock = { kind: "thinking", id: `thinking:${createdAt}:${blocks.length}`, text: "", createdAt, streaming: true };
      push(thinkingBlock);
    }
    reasoningByItemId.set(itemId, mode === "append" ? (reasoningByItemId.get(itemId) ?? "") + text : text);
    thinkingBlock = { ...thinkingBlock, text: [...reasoningByItemId.values()].filter((part) => part.trim()).join("\n\n") };
    replace(thinkingBlock);
  };

  const upsertTool = (itemId: string, createdAt: string, mutate: (entry: ThreadToolCall) => void) => {
    const existing = toolByItemId.get(itemId);
    if (existing) {
      const block = blocks[blockIndex.get(existing.blockId) ?? -1];
      if (block?.kind === "tools") {
        const entries = [...block.entries];
        const entry = entries[existing.entryIndex];
        if (entry) {
          const next = { ...entry };
          mutate(next);
          entries[existing.entryIndex] = next;
          replace({ ...block, entries });
        }
      }
      return;
    }
    settleStreams(createdAt);
    // Consecutive tool calls in one run share a card.
    const previous = blocks[blocks.length - 1];
    const target: BlockOf<"tools"> =
      blocks.length > groupStartIndex && previous?.kind === "tools"
        ? previous
        : (push({ kind: "tools", id: `tools:${createdAt}:${blocks.length}`, entries: [], createdAt }) as BlockOf<"tools">);
    const entry: ThreadToolCall = { id: itemId, title: "", status: "running", icon: "info", createdAt };
    mutate(entry);
    const entries = [...target.entries, entry];
    toolByItemId.set(itemId, { blockId: target.id, entryIndex: entries.length - 1 });
    replace({ ...target, entries });
  };

  const mergeUsage = (next: RuntimeUsage, createdAt: string) => {
    const current = summary.usage?.usage ?? {};
    summary.usage = {
      createdAt: summary.usage?.createdAt ?? createdAt,
      usage:
        next.scope === "context"
          ? {
              ...current,
              contextUsedTokens: next.usedTokens ?? current.contextUsedTokens,
              contextMaxTokens: next.maxTokens ?? current.contextMaxTokens,
              // Codex reports per-request counts alongside its context gauge.
              inputTokens: next.inputTokens ?? current.inputTokens,
              cachedInputTokens: next.cachedInputTokens ?? current.cachedInputTokens,
              outputTokens: next.outputTokens ?? current.outputTokens,
              reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
              cost: next.cost ?? current.cost
            }
          : {
              ...current,
              inputTokens: next.inputTokens ?? current.inputTokens,
              cachedInputTokens: next.cachedInputTokens ?? current.cachedInputTokens,
              outputTokens: next.outputTokens ?? current.outputTokens,
              reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
              cost: next.cost ?? current.cost
            }
    };
  };

  const closeTurn = (createdAt: string) => {
    for (const block of assistantByItemId.values()) {
      if (block.streaming || !block.completedAt) {
        const next = { ...block, streaming: false, completedAt: block.completedAt ?? createdAt };
        assistantByItemId.set(block.itemId, next);
        replace(next);
      }
    }
    if (thinkingBlock?.streaming) {
      thinkingBlock = { ...thinkingBlock, streaming: false };
      replace(thinkingBlock);
    }
  };

  for (const event of sortedEvents) {
    const createdAt = event.created_at ?? fallbackCreatedAt;
    const payload = rawRecord(event.payload);

    // Rows aisevak writes itself (not provider output).
    if (event.event_type === "thread.message-sent") {
      const text = stringValue(payload?.text) ?? event.text;
      if (text) push({ kind: "user", id: `user:${event.id}`, text, createdAt });
      continue;
    }
    if (event.event_type === "task.comment") {
      const text = stringValue(payload?.text) ?? event.text;
      if (text) push({ kind: "comment", id: `comment:${event.id}`, text, createdAt });
      continue;
    }
    if (event.event_type === "turn.failed") {
      push({ kind: "error", id: `error:${event.id}`, label: "Turn failed", detail: event.text ?? undefined, createdAt });
      closeTurn(createdAt);
      continue;
    }

    if (!isRuntimeEventPayload(payload) || payload.replay) continue;
    const runtime = payload;
    const itemId = runtime.itemId ?? `event:${event.id}`;

    switch (runtime.type) {
      case "content.delta": {
        const delta = runtime.delta;
        if (!delta) break;
        if (delta.stream === "assistant" || delta.stream === "plan") {
          upsertAssistant(itemId, createdAt, (block) => {
            block.text += delta.text;
            block.streaming = true;
          });
        } else if (delta.stream === "reasoning" || delta.stream === "reasoning_summary") {
          updateThinking(itemId, createdAt, delta.text, "append");
        } else {
          upsertTool(itemId, createdAt, (entry) => {
            entry.output = (entry.output ?? "") + delta.text;
          });
        }
        break;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = runtime.item;
        if (!item) break;
        const completed = runtime.type === "item.completed";
        if (item.itemType === "assistant_message" || item.itemType === "plan") {
          if (!completed && !item.text) break;
          upsertAssistant(itemId, createdAt, (block) => {
            if (item.text) block.text = item.text;
            if (completed) {
              block.streaming = false;
              block.completedAt = createdAt;
            }
          });
        } else if (item.itemType === "reasoning") {
          if (item.text) updateThinking(itemId, createdAt, item.text, "replace");
        } else if (item.itemType === "context_compaction") {
          if (completed) push({ kind: "system", id: `system:${event.id}`, text: item.text ? `Context compacted: ${item.text}` : "Context compacted", createdAt });
        } else {
          upsertTool(itemId, createdAt, (entry) => applyToolItem(entry, item));
        }
        break;
      }
      case "turn.plan.updated": {
        const entries = runtime.plan?.entries ?? [];
        if (entries.length === 0) break;
        const items = entries.map((entry, index): ThreadPlanItem => ({
          id: `plan-${index}`,
          title: entry.step,
          status: entry.status === "in_progress" ? "running" : entry.status
        }));
        if (planBlockId) {
          const existing = blocks[blockIndex.get(planBlockId) ?? -1];
          if (existing?.kind === "plan") {
            replace({ ...existing, items });
            break;
          }
        }
        settleStreams(createdAt);
        planBlockId = `plan:${event.id}`;
        push({ kind: "plan", id: planBlockId, items, createdAt });
        break;
      }
      case "turn.diff.updated":
        if (runtime.diff?.unifiedDiff) {
          summary.turnDiff = { diffs: splitUnifiedDiff(runtime.diff.unifiedDiff), createdAt: summary.turnDiff?.createdAt ?? createdAt };
        }
        break;
      case "usage.updated":
        if (runtime.usage) mergeUsage(runtime.usage, createdAt);
        break;
      case "turn.completed": {
        closeTurn(createdAt);
        if (runtime.usage) mergeUsage(runtime.usage, createdAt);
        const turn = runtime.turn;
        if (turn?.state === "failed") {
          const detail = turnFailureDetail(turn);
          const previous = blocks[blocks.length - 1];
          // Codex reports a fatal error and then fails the turn with the same message.
          if (previous?.kind === "error" && blocks.length > groupStartIndex && previous.detail === detail) {
            replace({ ...previous, label: "Turn failed" });
          } else {
            push({ kind: "error", id: `error:${event.id}`, label: "Turn failed", detail, createdAt });
          }
        } else if (turn?.state === "cancelled" || turn?.state === "interrupted") {
          push({ kind: "system", id: `system:${event.id}`, text: turn.state === "cancelled" ? "Turn cancelled" : "Turn interrupted", createdAt });
        }
        break;
      }
      case "runtime.error":
        push({
          kind: "error",
          id: `error:${event.id}`,
          label: "Provider error",
          detail: [runtime.error?.message ?? runtime.text, runtime.error?.detail].filter(Boolean).join(" — ") || undefined,
          createdAt
        });
        break;
      case "runtime.warning":
        push({
          kind: "notice",
          id: `notice:${event.id}`,
          level: runtime.notice?.level === "info" ? "info" : "warning",
          text: runtime.notice?.message ?? runtime.text ?? "Warning",
          detail: runtime.notice?.detail,
          createdAt
        });
        break;
      case "parse.error":
        push({ kind: "error", id: `error:${event.id}`, label: "Malformed provider output", detail: runtime.text, createdAt });
        break;
      case "thread.started":
        if (runtime.threadId) push({ kind: "system", id: `system:${event.id}`, text: `Session ${runtime.threadId}`, createdAt });
        break;
      default:
        // session.configured, request.opened (auto-approved), user.message
        // (aisevak records prompts itself), turn.started, provider.event.
        break;
    }
  }

  const { turnDiff, usage } = summary;
  if (turnDiff && turnDiff.diffs.length > 0) {
    push({ kind: "diff", id: `diff:${groupStartIndex}:${turnDiff.createdAt}`, diffs: turnDiff.diffs, createdAt: turnDiff.createdAt });
  }
  if (usage && hasUsage(usage.usage)) {
    push({ kind: "usage", id: `usage:${groupStartIndex}:${usage.createdAt}`, usage: usage.usage, createdAt: usage.createdAt });
  }
}

function applyToolItem(entry: ThreadToolCall, item: RuntimeItem): void {
  if (item.title) entry.title = item.title;
  else if (!entry.title) entry.title = item.toolName ?? TOOL_LABELS[item.itemType];
  if (item.command) entry.command = item.command;
  if (item.output) entry.output = item.output;
  if (item.exitCode !== undefined) entry.exitCode = item.exitCode;
  if (item.changes?.length) entry.diffs = item.changes.flatMap(fileDiff);
  entry.icon = toolIcon(item.itemType);
  const status: ToolStatus = item.status === "in_progress" ? "running" : item.status === "completed" ? "completed" : "failed";
  // A late progress update never reopens a finished tool.
  if (!(status === "running" && entry.status !== "running")) entry.status = status;
}

const TOOL_LABELS: Record<RuntimeItemType, string> = {
  assistant_message: "Message",
  reasoning: "Reasoning",
  plan: "Plan",
  command_execution: "Command",
  file_change: "Edit",
  file_read: "Read",
  search: "Search",
  web_fetch: "Fetch",
  web_search: "Web search",
  mcp_tool_call: "MCP tool",
  dynamic_tool_call: "Tool call",
  subagent: "Subagent",
  image_view: "View image",
  context_compaction: "Compaction",
  other: "Tool call"
};

function toolIcon(itemType: RuntimeItemType): ToolIcon {
  switch (itemType) {
    case "command_execution":
      return "terminal";
    case "file_change":
      return "edit";
    case "file_read":
    case "image_view":
      return "read";
    case "search":
      return "search";
    case "web_search":
    case "web_fetch":
      return "web";
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "subagent":
      return "agent";
    default:
      return "info";
  }
}

function fileDiff(change: RuntimeFileChange): ThreadFileDiff[] {
  if (!change.diff) return [];
  // Codex sends hunks only; ACP diffs already carry file headers.
  const diff = change.diff.startsWith("--- ")
    ? change.diff
    : `--- ${change.kind === "add" ? "/dev/null" : `a/${change.path}`}\n+++ b/${change.movePath ?? change.path}\n${change.diff}`;
  return [{ path: change.movePath ?? change.path, diff }];
}

/** Split a multi-file unified diff (`diff --git` sections) into per-file diffs. */
export function splitUnifiedDiff(unified: string): ThreadFileDiff[] {
  const sections = unified.split(/^(?=diff --git )/m).filter((section) => section.trim());
  return sections.map((section) => {
    const path =
      /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ??
      /^diff --git a\/\S+ b\/(\S+)/m.exec(section)?.[1] ??
      "changes";
    return { path, diff: section.replace(/^diff --git .*\n/, "").replace(/^index .*\n/m, "").trimEnd() };
  });
}

function turnFailureDetail(turn: NonNullable<RuntimeEvent["turn"]>): string | undefined {
  return turn.errorMessage ?? (turn.stopReason ? `Stopped: ${turn.stopReason}` : undefined);
}

function hasUsage(usage: ThreadUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}

function isRuntimeEventPayload(value: Record<string, unknown> | undefined): value is Record<string, unknown> & RuntimeEvent {
  return value?.v === 2 && typeof value.type === "string";
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

export function isActiveRunStatus(status: string): boolean {
  return ["queued", "running", "cancel_requested"].includes(status);
}


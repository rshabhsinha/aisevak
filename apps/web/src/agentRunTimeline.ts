export interface AgentRunTimelineEvent {
  id: string;
  seq: number;
  event_type: string;
  text?: string | null;
  payload: unknown;
  created_at?: string;
}

export interface AgentRunTimelineRun {
  id: string;
  kind: "worker" | "dispatcher";
  status: string;
  model?: string | null;
  agent_name: string;
  prompt?: string | null;
  queued_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface AgentRunChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  completedAt?: string;
  streaming: boolean;
}

export interface AgentRunWorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: string;
  exitCode?: number | null;
}

type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: AgentRunChatMessage;
    }
  | {
      id: string;
      kind: "comment";
      createdAt: string;
      text: string;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: AgentRunWorkLogEntry;
    };

export type AgentRunTimelineRow =
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: AgentRunChatMessage;
      durationStart: string;
    }
  | {
      kind: "comment";
      id: string;
      createdAt: string;
      text: string;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: AgentRunWorkLogEntry[];
    }
  | { kind: "working"; id: string; createdAt: string | null };

export function deriveAgentRunTimelineRows(input: {
  run: AgentRunTimelineRun | null;
  events: AgentRunTimelineEvent[];
  pendingMessages?: AgentRunChatMessage[];
}): AgentRunTimelineRow[] {
  const timelineEntries = [
    ...deriveTimelineEntries(input.run, input.events),
    ...(input.pendingMessages ?? []).map(
      (message): TimelineEntry => ({
        id: `pending:${message.id}`,
        kind: "message",
        createdAt: message.createdAt,
        message
      })
    )
  ].sort(compareTimelineEntries);
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []))
  );
  const rows: AgentRunTimelineRow[] = [];

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index];
    if (!entry) continue;

    if (entry.kind === "work") {
      const groupedEntries = [entry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      rows.push({
        kind: "work",
        id: entry.id,
        createdAt: entry.createdAt,
        groupedEntries
      });
      index = cursor - 1;
      continue;
    }

    if (entry.kind === "comment") {
      rows.push({
        kind: "comment",
        id: entry.id,
        createdAt: entry.createdAt,
        text: entry.text
      });
      continue;
    }

    rows.push({
      kind: "message",
      id: entry.id,
      createdAt: entry.createdAt,
      message: entry.message,
      durationStart: durationStartByMessageId.get(entry.message.id) ?? entry.message.createdAt
    });
  }

  if (input.run && isActiveRunStatus(input.run.status)) {
    rows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.run.started_at ?? input.run.queued_at ?? null
    });
  }

  return rows;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function deriveTimelineEntries(
  run: AgentRunTimelineRun | null,
  events: AgentRunTimelineEvent[]
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const createdAtFallback = run?.queued_at ?? run?.started_at ?? new Date(0).toISOString();
  const prompt = run?.prompt?.trim();
  const hasUserMessageEvent = events.some((event) => event.event_type === "thread.message-sent");
  if (prompt && !hasUserMessageEvent) {
    entries.push({
      id: `prompt:${run?.id ?? "run"}`,
      kind: "message",
      createdAt: createdAtFallback,
      message: {
        id: `prompt:${run?.id ?? "run"}`,
        role: "user",
        text: prompt,
        createdAt: createdAtFallback,
        completedAt: createdAtFallback,
        streaming: false
      }
    });
  }

  const workByItemId = new Map<string, AgentRunWorkLogEntry>();
  const assistantByItemId = new Map<string, AgentRunChatMessage>();
  const sortedEvents = [...events].sort(compareEventRows);

  for (const event of sortedEvents) {
    const eventCreatedAt = event.created_at ?? createdAtFallback;
    const normalized = rawRecord(event.payload);
    const raw = rawRecord(normalized?.raw) ?? normalized;
    const params = rawRecord(raw?.params);
    const item = rawRecord(raw?.item) ?? rawRecord(params?.item);
    const itemId =
      stringValue(item?.id) ??
      stringValue(params?.itemId) ??
      stringValue(params?.item_id) ??
      `event:${event.id}`;
    const itemType = stringValue(item?.type);

    if (event.event_type === "task.comment") {
      const text = event.text ?? stringValue(normalized?.text);
      if (!text?.trim()) continue;
      entries.push({
        id: `comment:${event.id}`,
        kind: "comment",
        createdAt: eventCreatedAt,
        text
      });
      continue;
    }

    if (event.event_type === "thread.message-sent") {
      const text = stringValue(normalized?.text) ?? event.text;
      if (!text?.trim()) continue;
      entries.push({
        id: `user:${event.id}`,
        kind: "message",
        createdAt: eventCreatedAt,
        message: {
          id: `user:${event.id}`,
          role: "user",
          text,
          createdAt: eventCreatedAt,
          completedAt: eventCreatedAt,
          streaming: false
        }
      });
      continue;
    }

    if (event.event_type === "item/agentMessage/delta") {
      const delta = event.text ?? stringValue(params?.delta);
      if (!delta) continue;
      const previous = assistantByItemId.get(itemId);
      const message: AgentRunChatMessage = {
        id: `assistant:${itemId}`,
        role: "assistant",
        text: `${previous?.text ?? ""}${delta}`,
        createdAt: previous?.createdAt ?? eventCreatedAt,
        streaming: true
      };
      assistantByItemId.set(itemId, message);
      upsertMessageEntry(entries, message);
      continue;
    }

    if (itemType === "agent_message" || itemType === "agentMessage") {
      const text = stringValue(item?.text) ?? stringValue(item?.content) ?? event.text;
      if (!text?.trim()) continue;
      const previous = assistantByItemId.get(itemId);
      const message: AgentRunChatMessage = {
        id: previous?.id ?? `assistant:${itemId}`,
        role: "assistant",
        text,
        createdAt: previous?.createdAt ?? eventCreatedAt,
        completedAt: eventCreatedAt,
        streaming: false
      };
      assistantByItemId.set(itemId, message);
      upsertMessageEntry(entries, message);
      continue;
    }

    if (itemType === "reasoning") {
      const summary = stringArrayValue(item?.summary).join("\n");
      const content = stringArrayValue(item?.content).join("\n");
      const text = stringValue(item?.text) ?? event.text ?? (summary || content);
      if (!text?.trim()) continue;
      entries.push({
        id: `thinking:${event.id}`,
        kind: "work",
        createdAt: eventCreatedAt,
        entry: {
          id: `thinking:${event.id}`,
          createdAt: eventCreatedAt,
          label: text,
          tone: "thinking",
          itemType
        }
      });
      continue;
    }

    if (itemType === "command_execution" || itemType === "commandExecution") {
      const command = stringValue(item?.command);
      const output = stringValue(item?.aggregated_output) ?? stringValue(item?.aggregatedOutput);
      const exitCode = numberValue(item?.exit_code) ?? numberValue(item?.exitCode);
      const status = stringValue(item?.status);
      const previous = workByItemId.get(itemId);
      const entry: AgentRunWorkLogEntry = {
        id: `work:${itemId}`,
        createdAt: previous?.createdAt ?? eventCreatedAt,
        label:
          status === "in_progress"
            ? "Command running"
            : exitCode && exitCode !== 0
              ? "Command failed"
              : "Command completed",
        command,
        rawCommand: command,
        detail: output,
        tone: exitCode && exitCode !== 0 ? "error" : "tool",
        toolTitle: command ? commandTitle(command) : "Command",
        itemType,
        exitCode
      };
      workByItemId.set(itemId, entry);
      if (!entries.some((entry) => entry.id === `work:${itemId}`)) {
        entries.push({
          id: `work:${itemId}`,
          kind: "work",
          createdAt: entry.createdAt,
          entry
        });
      } else {
        replaceWorkEntry(entries, entry);
      }
      continue;
    }

    if (event.event_type === "item/completed" && event.text?.trim()) {
      entries.push({
        id: `assistant:${event.id}`,
        kind: "message",
        createdAt: eventCreatedAt,
        message: {
          id: `assistant:${event.id}`,
          role: "assistant",
          text: event.text,
          createdAt: eventCreatedAt,
          completedAt: eventCreatedAt,
          streaming: false
        }
      });
      continue;
    }

    if (event.event_type === "turn/completed") {
      const turnStatus = stringValue(rawRecord(rawRecord(raw?.params)?.turn)?.status);
      if (turnStatus !== "failed") {
        for (const message of assistantByItemId.values()) {
          if (!message.streaming) continue;
          upsertMessageEntry(entries, {
            ...message,
            completedAt: eventCreatedAt,
            streaming: false
          });
        }
        continue;
      }
    }

    if (
      event.event_type === "turn.failed" ||
      event.event_type === "parse.error" ||
      (event.event_type === "turn/completed" &&
        stringValue(rawRecord(rawRecord(raw?.params)?.turn)?.status) === "failed")
    ) {
      entries.push({
        id: `error:${event.id}`,
        kind: "work",
        createdAt: eventCreatedAt,
        entry: {
          id: `error:${event.id}`,
          createdAt: eventCreatedAt,
          label: event.event_type === "parse.error" ? "Malformed JSONL event" : "Turn failed",
          detail: eventText(event),
          tone: "error"
        }
      });
      continue;
    }

    if (event.event_type === "thread.started" || event.event_type === "thread/started") {
      const rawParams = rawRecord(raw?.params);
      const threadId =
        stringValue(raw?.thread_id) ??
        stringValue(rawParams?.threadId) ??
        stringValue(rawRecord(rawParams?.thread)?.id) ??
        stringValue(normalized?.threadId);
      entries.push({
        id: `system:${event.id}`,
        kind: "work",
        createdAt: eventCreatedAt,
        entry: {
          id: `system:${event.id}`,
          createdAt: eventCreatedAt,
          label: "Thread started",
          detail: threadId ? `Codex thread ${threadId}` : undefined,
          tone: "info"
        }
      });
    }
  }

  return entries.sort(compareTimelineEntries);
}

function compareEventRows(left: AgentRunTimelineEvent, right: AgentRunTimelineEvent): number {
  const leftTime = left.created_at ?? "";
  const rightTime = right.created_at ?? "";
  return (
    leftTime.localeCompare(rightTime) ||
    left.seq - right.seq ||
    String(left.id).localeCompare(String(right.id))
  );
}

function computeMessageDurationStart(messages: ReadonlyArray<AgentRunChatMessage>): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) return createdAtComparison;
  return lifecycleRank(left.kind) - lifecycleRank(right.kind) || left.id.localeCompare(right.id);
}

function lifecycleRank(kind: TimelineEntry["kind"]): number {
  if (kind === "message") return 0;
  if (kind === "comment") return 1;
  return 2;
}

function isActiveRunStatus(status: string): boolean {
  return ["queued", "running", "cancel_requested"].includes(status);
}

function replaceWorkEntry(entries: TimelineEntry[], replacement: AgentRunWorkLogEntry): void {
  const index = entries.findIndex((entry) => entry.id === replacement.id && entry.kind === "work");
  if (index >= 0) {
    entries[index] = {
      id: replacement.id,
      kind: "work",
      createdAt: replacement.createdAt,
      entry: replacement
    };
  }
}

function upsertMessageEntry(entries: TimelineEntry[], message: AgentRunChatMessage): void {
  const index = entries.findIndex((entry) => entry.kind === "message" && entry.message.id === message.id);
  const replacement: TimelineEntry = {
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message
  };
  if (index >= 0) {
    entries[index] = replacement;
    return;
  }
  entries.push(replacement);
}

function eventText(event: AgentRunTimelineEvent): string {
  if (event.text) return event.text;
  const normalized = rawRecord(event.payload);
  const raw = rawRecord(normalized?.raw) ?? normalized;
  const item = rawRecord(raw?.item);
  return (
    stringValue(item?.text) ??
    stringValue(item?.command) ??
    stringValue(item?.aggregated_output) ??
    JSON.stringify(event.payload)
  );
}

function commandTitle(command: string): string {
  const match = command.match(/(?:^|["'\s])(?:pnpm|npm|yarn|bun|git|find|sed|cat|rg|ls|tsx|node|rm|mkdir|psql)\b[^"']*/);
  return match?.[0]?.trim().replace(/^["']/, "") || "Command";
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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

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
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: AgentRunWorkLogEntry[];
    }
  | { kind: "working"; id: string; createdAt: string | null };

export function deriveAgentRunTimelineRows(input: {
  run: AgentRunTimelineRun | null;
  events: AgentRunTimelineEvent[];
}): AgentRunTimelineRow[] {
  const timelineEntries = deriveTimelineEntries(input.run, input.events);
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
  if (prompt) {
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
  const sortedEvents = [...events].sort((left, right) => left.seq - right.seq);

  for (const event of sortedEvents) {
    const eventCreatedAt = event.created_at ?? createdAtFallback;
    const normalized = rawRecord(event.payload);
    const raw = rawRecord(normalized?.raw) ?? normalized;
    const item = rawRecord(raw?.item);
    const itemId = stringValue(item?.id) ?? `event:${event.id}`;
    const itemType = stringValue(item?.type);

    if (itemType === "agent_message") {
      const text = stringValue(item?.text) ?? event.text;
      if (!text?.trim()) continue;
      entries.push({
        id: `assistant:${event.id}`,
        kind: "message",
        createdAt: eventCreatedAt,
        message: {
          id: `assistant:${event.id}`,
          role: "assistant",
          text,
          createdAt: eventCreatedAt,
          completedAt: eventCreatedAt,
          streaming: false
        }
      });
      continue;
    }

    if (itemType === "reasoning") {
      const text = stringValue(item?.text) ?? event.text;
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

    if (itemType === "command_execution") {
      const command = stringValue(item?.command);
      const output = stringValue(item?.aggregated_output);
      const exitCode = numberValue(item?.exit_code);
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

    if (event.event_type === "turn.failed" || event.event_type === "parse.error") {
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

    if (event.event_type === "thread.started") {
      const threadId = stringValue(raw?.thread_id) ?? stringValue(normalized?.threadId);
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
  return kind === "message" ? 0 : 1;
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

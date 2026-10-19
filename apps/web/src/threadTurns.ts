import type { ThreadBlock, ThreadToolCall } from "./threadBlocks";

type BlockOf<K extends ThreadBlock["kind"]> = Extract<ThreadBlock, { kind: K }>;

/** A step drawn on the turn's rail. */
export type TurnStep = Exclude<ThreadBlock, { kind: "user" | "comment" | "turn-end" | "working" }>;

export interface AgentTurn {
  type: "turn";
  id: string;
  /** Work leading up to the answer: thinking, tools, plans, commentary. */
  steps: TurnStep[];
  /** The agent's closing message, kept visible when the work collapses. */
  answer: BlockOf<"assistant"> | null;
  /** Results worth seeing without expanding: changed files and errors after the answer. */
  outcomes: TurnStep[];
  end: BlockOf<"turn-end"> | null;
  live: BlockOf<"working"> | null;
  startedAt: string;
}

export type TimelineItem =
  | { type: "user"; block: BlockOf<"user"> }
  | { type: "comment"; block: BlockOf<"comment"> }
  | AgentTurn;

/**
 * Group the flat block stream into user messages and agent turns. A turn runs
 * from the first agent block after a user message to its turn-end (or the live
 * indicator), so every harness reads as the same linear story.
 */
export function groupTimeline(blocks: ThreadBlock[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let pending: TurnStep[] = [];
  let pendingId: string | null = null;

  const flush = (end: BlockOf<"turn-end"> | null, live: BlockOf<"working"> | null) => {
    if (pending.length === 0 && !end && !live) return;
    items.push(buildTurn(pendingId ?? end?.id ?? live?.id ?? `turn:${items.length}`, pending, end, live));
    pending = [];
    pendingId = null;
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "user":
      case "comment":
        // A steering message mid-turn splits the work around it.
        flush(null, null);
        items.push(block.kind === "user" ? { type: "user", block } : { type: "comment", block });
        break;
      case "turn-end":
        flush(block, null);
        break;
      case "working":
        flush(null, block);
        break;
      default:
        pendingId ??= `turn:${block.id}`;
        pending.push(block);
    }
  }
  flush(null, null);
  return items;
}

function buildTurn(
  id: string,
  blocks: TurnStep[],
  end: BlockOf<"turn-end"> | null,
  live: BlockOf<"working"> | null
): AgentTurn {
  const startedAt = blocks[0]?.createdAt ?? end?.createdAt ?? live?.createdAt ?? new Date(0).toISOString();
  // Live turns, and work cut off by a steering message (it has no ending of
  // its own), stay open on the rail.
  if (live || !end) return { type: "turn", id, steps: blocks, answer: null, outcomes: [], end, live, startedAt };

  let answerIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const kind = blocks[index]!.kind;
    if (kind === "assistant") {
      answerIndex = index;
      break;
    }
    // The agent kept working after its last message, so it is not an answer.
    if (kind === "tools" || kind === "thinking" || kind === "plan") break;
  }
  const answer = answerIndex >= 0 ? (blocks[answerIndex] as BlockOf<"assistant">) : null;
  const before = answerIndex >= 0 ? blocks.slice(0, answerIndex) : blocks;
  const after = answerIndex >= 0 ? blocks.slice(answerIndex + 1) : [];
  const isOutcome = (block: TurnStep) => block.kind === "diff" || block.kind === "error";
  const rest = answer ? [...before, ...after] : blocks;
  return {
    type: "turn",
    id,
    steps: answer ? [...before, ...after.filter((block) => !isOutcome(block))] : rest.filter((block) => !isOutcome(block)),
    answer,
    outcomes: answer ? after.filter(isOutcome) : rest.filter(isOutcome),
    end,
    live: null,
    startedAt
  };
}

type Activity = { verb: string; noun: [string, string]; count: (entries: ThreadToolCall[]) => number };

const ACTIVITIES: Record<ThreadToolCall["icon"], Activity> = {
  terminal: { verb: "Ran", noun: ["command", "commands"], count: (entries) => entries.length },
  edit: { verb: "Edited", noun: ["file", "files"], count: uniqueFiles },
  read: { verb: "Read", noun: ["file", "files"], count: uniqueFiles },
  search: { verb: "Searched", noun: ["time", "times"], count: (entries) => entries.length },
  web: { verb: "Browsed", noun: ["page", "pages"], count: (entries) => entries.length },
  wrench: { verb: "Called", noun: ["tool", "tools"], count: (entries) => entries.length },
  hammer: { verb: "Called", noun: ["tool", "tools"], count: (entries) => entries.length },
  agent: { verb: "Ran", noun: ["subagent", "subagents"], count: (entries) => entries.length },
  info: { verb: "Called", noun: ["tool", "tools"], count: (entries) => entries.length }
};

function uniqueFiles(entries: ThreadToolCall[]): number {
  const files = new Set(entries.flatMap((entry) => (entry.diffs?.length ? entry.diffs.map((diff) => diff.path) : [entry.title])));
  return files.size;
}

/** "Ran 3 commands, edited 2 files" — the digest for a run of tool calls. */
export function summarizeTools(entries: ThreadToolCall[]): string {
  const groups = new Map<string, { activity: Activity; entries: ThreadToolCall[] }>();
  for (const entry of entries) {
    const activity = ACTIVITIES[entry.icon];
    const key = `${activity.verb} ${activity.noun[1]}`;
    const group = groups.get(key) ?? { activity, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const phrases = [...groups.values()].map(({ activity, entries: group }) => {
    const count = activity.count(group);
    return `${activity.verb} ${count} ${count === 1 ? activity.noun[0] : activity.noun[1]}`;
  });
  return phrases.map((phrase, index) => (index === 0 ? phrase : phrase[0]!.toLowerCase() + phrase.slice(1))).join(", ");
}

/** Digest for a whole collapsed turn. */
export function summarizeSteps(steps: TurnStep[]): string {
  const tools = steps.flatMap((step) => (step.kind === "tools" ? step.entries : []));
  const parts: string[] = [];
  if (tools.length) parts.push(summarizeTools(tools));
  const messages = steps.filter((step) => step.kind === "assistant").length;
  if (!tools.length && steps.some((step) => step.kind === "thinking")) parts.push("Thought it through");
  if (messages) parts.push(`${messages} ${messages === 1 ? "update" : "updates"}`);
  return parts.join(" · ");
}

/** What the agent is doing right now, for the live row. */
export function currentActivity(steps: TurnStep[]): string {
  const last = steps[steps.length - 1];
  if (!last) return "Starting";
  if (last.kind === "thinking" && last.streaming) return "Thinking";
  if (last.kind === "assistant" && last.streaming) return "Writing";
  if (last.kind === "tools") {
    const running = [...last.entries].reverse().find((entry) => entry.status === "running");
    if (running) {
      const verb = { terminal: "Running", edit: "Editing", read: "Reading", search: "Searching", web: "Browsing", agent: "Delegating" }[
        running.icon as string
      ];
      const subject = running.command ?? running.title;
      return verb ? `${verb} ${subject}` : subject || "Working";
    }
  }
  return "Working";
}

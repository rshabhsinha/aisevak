import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileIcon,
  GitDiff,
  Info,
  ListChecks,
  Sparkle,
  StopCircle
} from "./icons";
import { AgentOrb, FileDiff, TaskList, ThinkingReasoning, ToolCall } from "./aicss";
import { ThinkingState } from "./aicss/thinking-state";
import { MarkdownContent } from "./markdown";
import { Button } from "./ui/button";
import {
  deriveThreadBlocks,
  type PendingUserMessage,
  type ThreadBlock,
  type ThreadEvent,
  type ThreadRunRef,
  type ThreadUsage
} from "../threadBlocks";
import { currentActivity, groupTimeline, summarizeSteps, summarizeTools, type AgentTurn, type TurnStep } from "../threadTurns";
import { formatDuration, formatElapsed } from "../agentRunTimeline";
import { attachmentUrl, fileExtensionLabel, formatBytes, isImageAttachment, splitAttachmentBlock, type MessageAttachment } from "../messageAttachments";

type BlockOf<K extends ThreadBlock["kind"]> = Extract<ThreadBlock, { kind: K }>;

// One linear timeline for every harness. deriveThreadBlocks normalizes provider
// events into blocks and groupTimeline folds them into user messages and agent
// turns, so nothing here branches on the provider.
export function ChatTimeline({
  run,
  events,
  pendingMessages = []
}: {
  run: ThreadRunRef | null;
  events: ThreadEvent[];
  pendingMessages?: PendingUserMessage[];
}) {
  const items = useMemo(
    () => groupTimeline(deriveThreadBlocks({ run, events, pendingMessages })),
    [events, pendingMessages, run]
  );

  return (
    <div className="chat-timeline tl">
      {items.length === 0 ? <span className="tl-empty">No messages yet.</span> : null}
      {items.map((item, index) => {
        if (item.type === "user") return <UserMessage key={item.block.id} block={item.block} />;
        if (item.type === "comment") return <TaskComment key={item.block.id} block={item.block} />;
        return <Turn key={item.id} turn={item} latest={index === items.length - 1} />;
      })}
    </div>
  );
}

const UserMessage = memo(function UserMessage({ block }: { block: BlockOf<"user"> }) {
  const { text, attachments } = useMemo(() => splitAttachmentBlock(block.text), [block.text]);
  return (
    <div className="tl-user" title={formatTimestamp(block.createdAt)}>
      {attachments.length ? <AttachmentStrip attachments={attachments} /> : null}
      {text ? (
        <div className="tl-user-bubble">
          <CollapsibleText text={text} />
        </div>
      ) : null}
    </div>
  );
});

function AttachmentStrip({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="tl-attachments">
      {attachments.map((file) =>
        isImageAttachment(file) && file.id ? (
          <a key={file.path} className="tl-attachment-image" href={attachmentUrl(file)} target="_blank" rel="noreferrer" title={file.name}>
            <img src={attachmentUrl(file)} alt={file.name} loading="lazy" />
          </a>
        ) : (
          <span key={file.path} className="tl-attachment-file" title={file.path}>
            <FileIcon size={14} />
            <span className="tl-attachment-name">{file.name}</span>
            <span className="tl-attachment-meta">
              {fileExtensionLabel(file.name)} · {formatBytes(file.size)}
            </span>
          </span>
        )
      )}
    </div>
  );
}

function TaskComment({ block }: { block: BlockOf<"comment"> }) {
  return (
    <div className="tl-comment" title={formatTimestamp(block.createdAt)}>
      <span className="tl-comment-label">Task comment</span>
      <MarkdownContent text={block.text} plain />
    </div>
  );
}

const Turn = memo(function Turn({ turn, latest }: { turn: AgentTurn; latest: boolean }) {
  if (turn.live || !turn.end) {
    return (
      <section className={`tl-turn ${turn.live ? "is-live" : ""}`} aria-label={turn.live ? "Agent turn in progress" : "Agent work"}>
        <Rail steps={turn.steps} live={Boolean(turn.live)} />
        {turn.live ? <LiveRow turn={turn} /> : null}
      </section>
    );
  }

  const failed = turn.end?.state === "failed";
  const stopped = turn.end?.state === "cancelled" || turn.end?.state === "interrupted";
  return (
    <section className="tl-turn" aria-label="Agent turn">
      {turn.steps.length > 0 ? <WorkSummary turn={turn} defaultOpen={latest && !turn.answer} /> : null}
      {turn.answer ? <Answer block={turn.answer} turn={turn} showMeta={turn.steps.length === 0} /> : null}
      {turn.outcomes.map((step) => (
        <div className="tl-outcome" key={step.id}>
          <StepBody step={step} />
        </div>
      ))}
      {failed || stopped || (!turn.answer && turn.steps.length === 0 && turn.outcomes.length === 0) ? (
        <EndRow turn={turn} />
      ) : null}
    </section>
  );
});

/** The collapsed "Worked for 1m 4s · Ran 3 commands" row over a finished turn's work. */
function WorkSummary({ turn, defaultOpen }: { turn: AgentTurn; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const state = turn.end?.state ?? "completed";
  const duration = turn.end ? formatElapsed(turn.end.createdAt, turn.end.completedAt) : null;
  const verb = state === "failed" ? "Failed after" : state === "completed" ? "Worked for" : "Stopped after";
  const digest = summarizeSteps(turn.steps);
  return (
    <div className={`tl-work ${open ? "is-open" : ""}`}>
      <button type="button" className="tl-work-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`tl-work-icon is-${state}`}>
          {state === "failed" ? <CircleAlert size={14} weight="fill" /> : state === "completed" ? <CheckCircle2 size={14} /> : <StopCircle size={14} />}
        </span>
        <span className="tl-work-label">
          {duration ? `${verb} ${duration}` : verb === "Worked for" ? "Worked" : state === "failed" ? "Failed" : "Stopped"}
        </span>
        {digest ? <span className="tl-work-digest">{digest}</span> : null}
        <ChevronRight size={12} className="tl-chevron" />
        {turn.end?.usage ? <UsageMeta usage={turn.end.usage} /> : null}
      </button>
      {open ? <Rail steps={turn.steps} /> : null}
    </div>
  );
}

function Answer({ block, turn, showMeta }: { block: BlockOf<"assistant">; turn: AgentTurn; showMeta: boolean }) {
  const duration = turn.end ? formatElapsed(turn.end.createdAt, turn.end.completedAt) : null;
  return (
    <div className="tl-answer">
      <MarkdownContent text={block.text || "(empty response)"} />
      <div className="tl-answer-actions">
        {block.text.trim() ? <CopyButton text={block.text} label="Copy message" /> : null}
        {showMeta && duration ? <span className="tl-meta">{duration}</span> : null}
        {showMeta && turn.end?.usage ? <UsageMeta usage={turn.end.usage} /> : null}
        <span className="tl-meta tl-answer-time">{formatTime(block.createdAt)}</span>
      </div>
    </div>
  );
}

function EndRow({ turn }: { turn: AgentTurn }) {
  const end = turn.end;
  const state = end?.state ?? "completed";
  const duration = end ? formatElapsed(end.createdAt, end.completedAt) : null;
  const label =
    state === "failed"
      ? "Turn failed"
      : state === "cancelled"
        ? "Cancelled"
        : state === "interrupted"
          ? "Interrupted"
          : "Finished without a reply";
  return (
    <div className={`tl-end is-${state}`} role={state === "failed" ? "alert" : undefined}>
      <span className="tl-end-icon">
        {state === "failed" ? <CircleAlert size={14} weight="fill" /> : state === "completed" ? <CheckCircle2 size={14} /> : <StopCircle size={14} />}
      </span>
      <span className="tl-end-text">
        <strong>{label}</strong>
        {duration ? <span className="tl-meta"> · {duration}</span> : null}
        {end?.detail ? <span className="tl-end-detail">{end.detail}</span> : null}
      </span>
    </div>
  );
}

function LiveRow({ turn }: { turn: AgentTurn }) {
  const activity = currentActivity(turn.steps);
  return (
    <div className="tl-live" role="status">
      <span className="tl-marker">
        <AgentOrb variant="working" size={13} color="var(--primary)" />
      </span>
      <ThinkingState className="tl-live-label">{activity}</ThinkingState>
      {turn.live?.createdAt ? <LiveElapsed createdAt={turn.live.createdAt} /> : null}
    </div>
  );
}

/** The vertical line through a turn's steps, one marker per step. */
function Rail({ steps, live = false }: { steps: TurnStep[]; live?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <ol className={`tl-rail ${live ? "is-live" : ""}`}>
      {steps.map((step) => (
        <li className={`tl-step is-${step.kind}`} key={step.id}>
          <span className="tl-marker" aria-hidden="true">
            <StepMarker step={step} />
          </span>
          <div className="tl-step-body">
            <StepBody step={step} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepMarker({ step }: { step: TurnStep }) {
  switch (step.kind) {
    case "thinking":
      return step.streaming ? <AgentOrb variant="thinking" size={12} color="var(--primary)" /> : <Sparkle size={13} />;
    case "tools": {
      const running = step.entries.some((entry) => entry.status === "running");
      if (running) return <AgentOrb variant="working" size={12} color="var(--primary)" />;
      return step.entries.some((entry) => entry.status === "failed") ? (
        <CircleAlert size={13} className="tl-tone-danger" />
      ) : (
        <CheckCircle2 size={13} />
      );
    }
    case "plan":
      return <ListChecks size={13} />;
    case "diff":
      return <GitDiff size={13} />;
    case "error":
      return <CircleAlert size={13} weight="fill" className="tl-tone-danger" />;
    case "notice":
      return <Info size={13} className="tl-tone-warning" />;
    default:
      return <span className="tl-dot" />;
  }
}

function StepBody({ step }: { step: TurnStep }): ReactNode {
  switch (step.kind) {
    case "assistant":
      return (
        <div className="tl-commentary">
          <MarkdownContent text={step.text} />
          {step.streaming ? <span className="streaming-caret" aria-hidden="true" /> : null}
        </div>
      );
    case "thinking": {
      const duration = step.completedAt ? formatElapsed(step.createdAt, step.completedAt) : null;
      return (
        <ThinkingReasoning
          className="tl-thinking"
          label={step.streaming ? "Thinking" : duration && duration !== "0ms" ? `Thought for ${duration}` : "Thought"}
          isStreaming={step.streaming}
          rawText={step.text}
        />
      );
    }
    case "tools":
      return <ToolGroup step={step} />;
    case "plan":
      return <TaskList className="tl-plan" title="Plan" tasks={step.items.map((item) => ({ ...item, detail: undefined }))} />;
    case "diff":
      return <Changes step={step} />;
    case "error":
      return (
        <div className="tl-error">
          <strong>{step.label}</strong>
          {step.detail ? <span>{step.detail}</span> : null}
        </div>
      );
    case "notice":
      return (
        <div className={`tl-notice is-${step.level}`}>
          {step.text}
          {step.detail ? <span className="tl-meta"> · {step.detail}</span> : null}
        </div>
      );
    case "system":
      return <div className="tl-system">{step.text}</div>;
  }
}

/** A run of tool calls: one row when alone, a digest that opens into rows otherwise. */
function ToolGroup({ step }: { step: BlockOf<"tools"> }) {
  const running = step.entries.some((entry) => entry.status === "running");
  const [open, setOpen] = useState<boolean | null>(null);
  if (step.entries.length === 1) return <ToolCall entry={step.entries[0]!} />;
  const isOpen = open ?? running;
  return (
    <div className={`tl-tools ${isOpen ? "is-open" : ""}`}>
      <button type="button" className="tl-tools-toggle" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <span>{summarizeTools(step.entries)}</span>
        <ChevronRight size={12} className="tl-chevron" />
      </button>
      {isOpen ? (
        <div className="tl-tools-rows">
          {step.entries.map((entry) => (
            <ToolCall entry={entry} key={entry.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Changes({ step }: { step: BlockOf<"diff"> }) {
  const [open, setOpen] = useState(false);
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const diff of step.diffs) {
      for (const line of diff.diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
      }
    }
    return { additions, deletions };
  }, [step.diffs]);
  return (
    <div className={`tl-changes ${open ? "is-open" : ""}`}>
      <button type="button" className="tl-tools-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <GitDiff size={13} />
        <span>
          Changed {step.diffs.length} {step.diffs.length === 1 ? "file" : "files"}
        </span>
        <span className="tl-diffstat">
          <span className="is-add">+{totals.additions}</span> <span className="is-del">−{totals.deletions}</span>
        </span>
        <ChevronRight size={12} className="tl-chevron" />
      </button>
      {open ? (
        <div className="tl-changes-files">
          {step.diffs.map((diff) => (
            <FileDiff key={diff.path} filename={diff.path} diff={diff.diff} defaultExpanded={step.diffs.length === 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UsageMeta({ usage }: { usage: ThreadUsage }) {
  const percent = contextPercent(usage);
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const parts: string[] = [];
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (usage.cost && usage.cost.amount > 0) parts.push(`${usage.cost.currency === "USD" ? "$" : `${usage.cost.currency} `}${usage.cost.amount.toFixed(2)}`);
  if (parts.length === 0 && percent === null) return null;
  return (
    <span className="tl-usage" title={usageTitle(usage)}>
      {parts.join(" · ")}
      {percent !== null ? (
        <span className="tl-usage-ring" style={{ ["--pct" as string]: `${Math.min(100, percent)}` }} aria-label={`Context ${percent}% full`}>
          {percent}%
        </span>
      ) : null}
    </span>
  );
}

export function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = text.length > 500 || text.split("\n").length > 7;
  const collapsed = shouldCollapse && !expanded;

  return (
    <div className="agent-collapsible-container">
      <div className={`collapsible-message ${collapsed ? "collapsed" : ""}`}>
        <MarkdownContent text={text} plain />
      </div>
      {shouldCollapse ? (
        <button className="collapsible-toggle-btn" type="button" onClick={() => setExpanded((value) => !value)}>
          <span>{expanded ? "Show less" : "Show more"}</span>
          <ChevronDown
            size={12}
            style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 140ms ease" }}
          />
        </button>
      ) : null}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className="copy-button"
      variant="ghost"
      size="icon"
      type="button"
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={async () => {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
    </Button>
  );
}

function LiveElapsed({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - Date.parse(createdAt));
  return <span className="tl-meta tl-live-elapsed">{Number.isFinite(elapsed) ? formatDuration(Math.floor(elapsed / 1000) * 1000 || 1000) : ""}</span>;
}

function contextPercent(usage: ThreadUsage): number | null {
  if (!usage.contextUsedTokens || !usage.contextMaxTokens) return null;
  return Math.round((usage.contextUsedTokens / usage.contextMaxTokens) * 100);
}

function usageTitle(usage: ThreadUsage): string {
  return [
    usage.contextUsedTokens !== undefined && usage.contextMaxTokens !== undefined
      ? `Context: ${usage.contextUsedTokens.toLocaleString()} / ${usage.contextMaxTokens.toLocaleString()} tokens`
      : null,
    usage.inputTokens !== undefined ? `Input: ${usage.inputTokens.toLocaleString()}` : null,
    usage.cachedInputTokens !== undefined ? `Cached input: ${usage.cachedInputTokens.toLocaleString()}` : null,
    usage.outputTokens !== undefined ? `Output: ${usage.outputTokens.toLocaleString()}` : null,
    usage.reasoningTokens !== undefined ? `Reasoning: ${usage.reasoningTokens.toLocaleString()}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

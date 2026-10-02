import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  Hammer,
  Terminal,
  Wrench
} from "./icons";
import { AgentOrb, FileDiff, TaskList, ThinkingReasoning } from "./aicss";
import { MarkdownContent } from "./markdown";
import { Button } from "./ui/button";
import {
  deriveThreadBlocks,
  type PendingUserMessage,
  type ThreadBlock,
  type ThreadEvent,
  type ThreadRunRef,
  type ThreadToolCall
} from "../threadBlocks";
import { formatElapsed, normalizeCompactToolLabel } from "../agentRunTimeline";

// Unified chat renderer: every harness (Codex, Cursor, OpenCode, Devin) is
// normalized into ThreadBlock[] by deriveThreadBlocks, so this component never
// needs provider-specific branches.
export function ChatTimeline({
  run,
  events,
  pendingMessages = []
}: {
  run: ThreadRunRef | null;
  events: ThreadEvent[];
  pendingMessages?: PendingUserMessage[];
}) {
  const blocks = useMemo(
    () => deriveThreadBlocks({ run, events, pendingMessages }),
    [events, pendingMessages, run]
  );

  return (
    <div className="chat-timeline">
      {blocks.length === 0 ? <span className="text-muted">No run events yet.</span> : null}
      {blocks.map((block) => (
        <ThreadBlockView block={block} key={block.id} />
      ))}
    </div>
  );
}

function ThreadBlockView({ block }: { block: ThreadBlock }) {
  switch (block.kind) {
    case "user":
      return <UserBlock block={block} />;
    case "assistant":
      return <AssistantBlock block={block} />;
    case "thinking":
      return <ThinkingBlock block={block} />;
    case "tools":
      return <ToolsBlock block={block} />;
    case "plan":
      return <PlanBlock block={block} />;
    case "comment":
      return <CommentBlock block={block} />;
    case "error":
      return <ErrorBlock block={block} />;
    case "system":
      return <SystemBlock block={block} />;
    case "working":
      return <WorkingBlock block={block} />;
  }
}

function UserBlock({ block }: { block: Extract<ThreadBlock, { kind: "user" }> }) {
  return (
    <div className="timeline-user-row">
      <div className="user-bubble">
        <CollapsibleText text={block.text} />
        <span className="timeline-meta">{formatTime(block.createdAt)}</span>
      </div>
    </div>
  );
}

function AssistantBlock({ block }: { block: Extract<ThreadBlock, { kind: "assistant" }> }) {
  return (
    <div className="timeline-assistant-row">
      <div className="assistant-message group-assistant">
        <MarkdownContent text={block.text || (block.streaming ? "" : "(empty response)")} />
        {block.streaming ? <span className="streaming-caret" aria-hidden="true" /> : null}
        <div className="assistant-meta-row">
          <span className="timeline-meta">
            {formatTime(block.createdAt)}
            {block.completedAt
              ? ` · ${formatElapsed(block.createdAt, block.completedAt) ?? ""}`
              : ""}
          </span>
          {!block.streaming && block.text.trim() ? (
            <CopyButton text={block.text} label="Copy message" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ block }: { block: Extract<ThreadBlock, { kind: "thinking" }> }) {
  return (
    <div className="working-row py-1">
      <ThinkingReasoning
        label="Thinking"
        isStreaming={block.streaming}
        defaultExpanded={false}
        rawText={block.text}
      />
    </div>
  );
}

function ToolsBlock({ block }: { block: Extract<ThreadBlock, { kind: "tools" }> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const maxVisible = 6;
  const hasOverflow = block.entries.length > maxVisible;
  const visibleEntries = hasOverflow && !isExpanded ? block.entries.slice(-maxVisible) : block.entries;
  const hiddenCount = block.entries.length - visibleEntries.length;

  return (
    <div className="work-group">
      {hasOverflow ? (
        <div className="work-group-head">
          <span>Tool calls ({block.entries.length})</span>
          <button type="button" onClick={() => setIsExpanded((value) => !value)}>
            {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
          </button>
        </div>
      ) : null}
      <div className="work-group-rows">
        {visibleEntries.map((entry) => (
          <ToolCallRow entry={entry} key={entry.id} />
        ))}
      </div>
    </div>
  );
}

function ToolCallRow({ entry }: { entry: ThreadToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = toolCallIcon(entry);
  const heading = normalizeCompactToolLabel(entry.title) || "Tool call";
  const preview = toolCallPreview(entry, heading);
  const hasDetail = Boolean(entry.detail?.trim());
  const isDiff = Boolean(
    entry.detail &&
      (entry.detail.includes("--- a/") ||
        entry.detail.includes("+++ b/") ||
        (entry.detail.includes("@@") && entry.detail.includes("\n+")))
  );

  return (
    <div className={`work-entry ${entry.status === "failed" ? "error" : "tool"}`}>
      <button
        type="button"
        className="work-entry-main"
        onClick={() => setExpanded((value) => !value)}
        title={preview ? `${heading} - ${preview}` : heading}
      >
        <span className="work-entry-icon">
          {entry.status === "running" ? (
            <AgentOrb variant="working" size={13} color="var(--primary)" />
          ) : (
            <Icon size={13} />
          )}
        </span>
        <span className="work-entry-text">
          <strong>{heading}</strong>
          {preview ? <span> - {preview}</span> : null}
        </span>
        {hasDetail ? (
          <span className="work-entry-chevron">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : null}
      </button>
      {expanded && hasDetail ? (
        isDiff ? (
          <div className="px-2 pb-2">
            <FileDiff filename={preview || heading} diff={entry.detail!} defaultExpanded={true} />
          </div>
        ) : (
          <pre className="work-entry-detail">{entry.detail}</pre>
        )
      ) : null}
    </div>
  );
}

function PlanBlock({ block }: { block: Extract<ThreadBlock, { kind: "plan" }> }) {
  return <TaskList title="Plan" tasks={block.items.map((item) => ({ ...item, detail: undefined }))} />;
}

function CommentBlock({ block }: { block: Extract<ThreadBlock, { kind: "comment" }> }) {
  return (
    <div className="task-comment-row">
      <div className="task-comment-bubble">
        <div className="task-comment-label">Task comment</div>
        <MarkdownContent text={block.text} plain />
        <span className="timeline-meta">{formatTime(block.createdAt)}</span>
      </div>
    </div>
  );
}

function ErrorBlock({ block }: { block: Extract<ThreadBlock, { kind: "error" }> }) {
  return (
    <div className="agent-run-failure" role="alert">
      <span className="agent-run-failure-icon">
        <CircleAlert size={15} weight="fill" />
      </span>
      <span>
        <strong>{block.label}</strong>
        {block.detail ? <small>{block.detail}</small> : null}
      </span>
    </div>
  );
}

function SystemBlock({ block }: { block: Extract<ThreadBlock, { kind: "system" }> }) {
  return (
    <div className="system-row">
      <span>{block.text}</span>
    </div>
  );
}

function WorkingBlock({ block }: { block: Extract<ThreadBlock, { kind: "working" }> }) {
  return (
    <div className="working-row py-1 max-w-fit">
      <ThinkingReasoning
        label="Agent active"
        isStreaming={true}
        defaultExpanded={false}
        liveElapsed={block.createdAt ? <LiveElapsed createdAt={block.createdAt} /> : undefined}
        rawText={
          block.createdAt
            ? `Run in progress · Started at ${new Date(block.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
            : undefined
        }
      />
    </div>
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
        <button
          className="collapsible-toggle-btn"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? "Show less" : "Show full report"}</span>
          <ChevronDown
            size={12}
            style={{
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 140ms ease"
            }}
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
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-[10.5px] text-muted-foreground/75 tabular-nums">
      {formatElapsed(createdAt, now) ?? "0s"}
    </span>
  );
}

function toolCallIcon(entry: ThreadToolCall) {
  switch (entry.icon) {
    case "terminal":
      return Terminal;
    case "search":
      return Eye;
    case "wrench":
      return Wrench;
    case "hammer":
      return Hammer;
    case "edit":
      return Bot;
    default:
      return entry.status === "failed" ? CircleAlert : Activity;
  }
}

function toolCallPreview(entry: ThreadToolCall, heading: string): string | null {
  const preview = entry.command || entry.detail;
  if (!preview) return null;
  const normalizedPreview = normalizeCompactToolLabel(preview).toLowerCase();
  const normalizedHeading = normalizeCompactToolLabel(heading).toLowerCase();
  if (normalizedPreview === normalizedHeading) return null;
  return preview.replace(/\s+/g, " ").trim();
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

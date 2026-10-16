import { useState, type ReactElement } from "react";
import { AgentOrb } from "./agent-orbs";
import { CodeBlock } from "./code-block";
import { FileDiff } from "./file-diff";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  FileText,
  Globe,
  Hammer,
  PencilSimple,
  Terminal,
  Wrench
} from "../icons";
import type { ThreadToolCall } from "../../threadBlocks";
import { normalizeCompactToolLabel } from "../../agentRunTimeline";

export type ToolCallEntry = Pick<ThreadToolCall, "title" | "command" | "output" | "diffs" | "status" | "exitCode" | "icon">;

export function ToolCall({ entry }: { entry: ToolCallEntry }): ReactElement {
  const running = entry.status === "running";
  const hasOutput = Boolean(entry.output?.trim());
  const hasDiffs = Boolean(entry.diffs?.length);
  // Live output opens by itself; finished tools stay compact until clicked.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const isExpanded = expanded ?? (running && hasOutput);
  const Icon = toolCallIcon(entry);
  const heading = normalizeCompactToolLabel(entry.title) || "Tool call";
  const preview = toolCallPreview(entry, heading);
  const expandable = hasOutput || hasDiffs;

  return (
    <div className={`work-entry ${entry.status === "failed" ? "error" : "tool"}`}>
      <button
        type="button"
        className="work-entry-main"
        onClick={() => setExpanded(!isExpanded)}
        title={preview ? `${heading} - ${preview}` : heading}
      >
        <span className="work-entry-icon">
          {running ? <AgentOrb variant="working" size={13} color="var(--primary)" /> : <Icon size={13} />}
        </span>
        <span className="work-entry-text">
          <strong>{heading}</strong>
          {preview ? <span> - {preview}</span> : null}
        </span>
        {entry.exitCode !== undefined && entry.exitCode !== null && entry.exitCode !== 0 ? (
          <span className="work-entry-exit">exit {entry.exitCode}</span>
        ) : null}
        {expandable ? (
          <span className="work-entry-chevron">
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : null}
      </button>
      {isExpanded && expandable ? (
        <div className="work-entry-body">
          {entry.diffs?.map((diff) => (
            <FileDiff key={diff.path} filename={diff.path} diff={diff.diff} defaultExpanded={true} />
          ))}
          {hasOutput ? (
            <CodeBlock label={entry.icon === "terminal" ? "output" : "result"} code={entry.output!} streaming={running} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function toolCallIcon(entry: ToolCallEntry) {
  switch (entry.icon) {
    case "terminal":
      return Terminal;
    case "search":
      return Eye;
    case "read":
      return FileText;
    case "web":
      return Globe;
    case "wrench":
      return Wrench;
    case "hammer":
      return Hammer;
    case "edit":
      return PencilSimple;
    case "agent":
      return Bot;
    default:
      return entry.status === "failed" ? CircleAlert : Activity;
  }
}

function toolCallPreview(entry: ToolCallEntry, heading: string): string | null {
  const preview = entry.command;
  if (!preview) return null;
  const normalizedPreview = normalizeCompactToolLabel(preview).toLowerCase();
  const normalizedHeading = normalizeCompactToolLabel(heading).toLowerCase();
  if (normalizedPreview === normalizedHeading) return null;
  return preview.replace(/\s+/g, " ").trim();
}

import { useState, type ReactElement } from "react";
import { AgentOrb } from "./agent-orbs";
import { FileDiff } from "./file-diff";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  Hammer,
  Terminal,
  Wrench
} from "../icons";
import type { ThreadToolCall } from "../../threadBlocks";
import { normalizeCompactToolLabel } from "../../agentRunTimeline";

export interface ToolCallEntry {
  title: string;
  command?: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  exitCode?: number | null;
  icon: "terminal" | "search" | "wrench" | "hammer" | "edit" | "info";
}

export function ToolCall({ entry }: { entry: ToolCallEntry }): ReactElement {
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

function toolCallIcon(entry: ToolCallEntry) {
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

function toolCallPreview(entry: ToolCallEntry, heading: string): string | null {
  const preview = entry.command || entry.detail;
  if (!preview) return null;
  const normalizedPreview = normalizeCompactToolLabel(preview).toLowerCase();
  const normalizedHeading = normalizeCompactToolLabel(heading).toLowerCase();
  if (normalizedPreview === normalizedHeading) return null;
  return preview.replace(/\s+/g, " ").trim();
}

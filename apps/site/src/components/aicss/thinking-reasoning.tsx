import { useState, type ReactElement, type ReactNode } from "react";
import { AgentOrb } from "./agent-orbs";
import { ChevronDown, ChevronRight } from "../icons";

interface ThinkingReasoningProps {
  label?: string;
  isStreaming?: boolean;
  elapsedSeconds?: number;
  tokensPerSecond?: number;
  liveElapsed?: ReactNode;
  defaultExpanded?: boolean;
  children?: ReactNode;
  rawText?: string;
  className?: string;
}

export function ThinkingReasoning({
  label = "Thinking",
  isStreaming = false,
  elapsedSeconds,
  tokensPerSecond,
  liveElapsed,
  defaultExpanded = false,
  children,
  rawText,
  className = ""
}: ThinkingReasoningProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasContent = Boolean(children || (rawText && rawText.trim().length > 0));

  return (
    <div className={`aicss-tr-card ${className}`}>
      <button
        type="button"
        className="aicss-tr-header"
        onClick={() => hasContent && setExpanded(!expanded)}
        aria-expanded={expanded}
        disabled={!hasContent}
      >
        <div className="aicss-tr-header-left">
          <AgentOrb
            variant={isStreaming ? "thinking" : "idle"}
            size={13}
            color={isStreaming ? "var(--primary)" : "var(--muted-foreground)"}
          />
          <span className={isStreaming ? "aicss-shimmer font-medium" : "text-muted-foreground font-medium"}>
            {label}
            {isStreaming && "…"}
          </span>
        </div>

        <div className="aicss-tr-meta">
          {liveElapsed}
          {typeof tokensPerSecond === "number" && tokensPerSecond > 0 && (
            <span>{Math.round(tokensPerSecond)} t/s</span>
          )}
          {typeof elapsedSeconds === "number" && (
            <span>{elapsedSeconds.toFixed(1)}s</span>
          )}
          {hasContent && (
            <span style={{ display: "inline-flex", opacity: 0.6 }}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </div>
      </button>

      {expanded && hasContent && (
        <div className="aicss-tr-body">
          {children || rawText}
        </div>
      )}
    </div>
  );
}

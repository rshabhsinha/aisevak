import type { ReactElement, ReactNode } from "react";

// Adapted from AICSS Thinking State (https://www.aicss.dev/components/thinking-state):
// a shimmering label that signals the agent is still working. Colors come from
// theme tokens; see `.aicss-thinking-state` in timeline.css.
export function ThinkingState({ children = "Thinking", className = "" }: { children?: ReactNode; className?: string }): ReactElement {
  return <span className={`aicss-thinking-state ${className}`}>{children}</span>;
}

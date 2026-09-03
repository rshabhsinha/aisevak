import { useEffect, type ReactElement } from "react";
import { CircleAlert, Terminal } from "../icons";

interface ApprovalCardProps {
  toolName: string;
  payload: string;
  description?: string;
  onApprove: () => void;
  onReject: () => void;
  isSubmitting?: boolean;
  className?: string;
}

export function ApprovalCard({
  toolName,
  payload,
  description,
  onApprove,
  onReject,
  isSubmitting = false,
  className = ""
}: ApprovalCardProps): ReactElement {
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onApprove();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onReject();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onApprove, onReject]);

  return (
    <div className={`aicss-approval-card ${className}`}>
      <div className="aicss-approval-header">
        <div className="flex items-center gap-2">
          <CircleAlert size={14} className="text-amber-400" />
          <span className="text-xs font-semibold text-foreground">
            Approval Required: <span className="font-mono text-muted-foreground">{toolName}</span>
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded">
          Permission
        </span>
      </div>

      {description && (
        <p className="text-xs text-muted-foreground mb-2">{description}</p>
      )}

      <div className="aicss-approval-payload">
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground mb-1 font-sans">
          <Terminal size={11} />
          <span>Payload</span>
        </div>
        {payload}
      </div>

      <div className="aicss-approval-actions">
        <button
          type="button"
          onClick={onReject}
          disabled={isSubmitting}
          className="btn-ghost text-xs h-7 px-3 text-muted-foreground hover:text-foreground"
        >
          Reject <kbd className="ml-1.5 text-[10px] opacity-60 font-mono">Esc</kbd>
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={isSubmitting}
          className="btn-primary text-xs h-7 px-3"
        >
          Approve <kbd className="ml-1.5 text-[10px] opacity-75 font-mono">⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}

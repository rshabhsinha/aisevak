import { useState, type ReactElement } from "react";
import { CheckCircle2, Copy } from "../icons";

interface FileDiffProps {
  filename: string;
  diff: string;
  additions?: number;
  deletions?: number;
  className?: string;
  defaultExpanded?: boolean;
}

export function FileDiff({
  filename,
  diff,
  additions,
  deletions,
  className = "",
  defaultExpanded = true
}: FileDiffProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const lines = diff.split("\n");

  let computedAdds = additions ?? 0;
  let computedDels = deletions ?? 0;
  if (additions === undefined && deletions === undefined) {
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) computedAdds++;
      if (line.startsWith("-") && !line.startsWith("---")) computedDels++;
    }
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // fallback
    }
  };

  return (
    <div className={`aicss-diff-card ${className}`}>
      <div
        className="aicss-diff-header cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-foreground truncate">{filename}</span>
          {(computedAdds > 0 || computedDels > 0) && (
            <span className="flex items-center gap-1.5 text-[11px] font-mono">
              {computedAdds > 0 && <span className="text-emerald-400 font-semibold">+{computedAdds}</span>}
              {computedDels > 0 && <span className="text-rose-400 font-semibold">-{computedDels}</span>}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors"
            onClick={handleCopy}
            title="Copy diff"
          >
            {copied ? <CheckCircle2 size={12} className="text-emerald-400" /> : <Copy size={12} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="aicss-diff-body">
          {lines.map((line, idx) => {
            const isAdd = line.startsWith("+") && !line.startsWith("+++");
            const isDel = line.startsWith("-") && !line.startsWith("---");
            const isHunk = line.startsWith("@@");

            let lineClass = "aicss-diff-line aicss-diff-line-ctx";
            if (isAdd) lineClass = "aicss-diff-line aicss-diff-line-add";
            else if (isDel) lineClass = "aicss-diff-line aicss-diff-line-del";
            else if (isHunk) lineClass = "aicss-diff-line text-muted-foreground opacity-60 bg-white/5";

            return (
              <div key={idx} className={lineClass}>
                <span className="select-none w-7 text-right pr-3 text-muted-foreground/50 opacity-60 text-[10.5px]">
                  {idx + 1}
                </span>
                <span className="whitespace-pre flex-1 font-mono">{line}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

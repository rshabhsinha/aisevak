import { useEffect, useRef, useState, type ReactElement } from "react";
import { CheckCircle2, Copy } from "../icons";

// Adapted from AICSS CodeBlock (MIT, https://www.aicss.dev/components/code-block).
// Used for tool output, which can stream in while a command is running.
export function CodeBlock({
  label,
  code,
  streaming = false,
  maxLines = 400
}: {
  label: string;
  code: string;
  streaming?: boolean;
  maxLines?: number;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const allLines = code.replace(/\n$/, "").split("\n");
  const hidden = Math.max(0, allLines.length - maxLines);
  const lines = hidden > 0 ? allLines.slice(-maxLines) : allLines;

  useEffect(() => {
    // Follow live output like a terminal.
    if (streaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [code, streaming]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be unavailable on insecure origins.
    }
  };

  return (
    <div className="aicss-cb">
      <div className="aicss-cb-head">
        <span className="aicss-cb-file">
          <svg className="aicss-cb-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="m8 6-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="aicss-cb-lang">{label}</span>
          {streaming ? <span className="aicss-cb-live">live</span> : null}
        </span>
        <button type="button" className="aicss-cb-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy output"}>
          {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <div className="aicss-cb-body" ref={bodyRef}>
        {hidden > 0 ? <div className="aicss-cb-more">{hidden} earlier lines hidden</div> : null}
        <div className="aicss-cb-lines">
          {lines.map((line, index) => (
            <div className="aicss-cb-row" key={index}>
              <span className="aicss-cb-ln">{hidden + index + 1}</span>
              <code className="aicss-cb-code">{line || " "}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckCircle2, Copy } from "./icons";
import { Button } from "./ui/button";

const markdownComponents: Components = {
  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  code({ children, className }) {
    const value = String(children).replace(/\n$/, "");
    const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1];
    const isBlock = Boolean(className?.includes("language-")) || String(children).includes("\n");

    if (!isBlock) return <code className="inline-code">{children}</code>;

    return (
      <div className="code-block">
        <div className="code-block-head">
          <span>{language || "text"}</span>
          <MarkdownCopyButton text={value} />
        </div>
        <pre>{value}</pre>
      </div>
    );
  },
  img({ alt, src, title }) {
    return <img alt={alt ?? ""} src={src} title={title ?? undefined} loading="lazy" referrerPolicy="no-referrer" />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  }
};

export function MarkdownContent({ text, plain = false }: { text: string; plain?: boolean }) {
  return (
    <div className={`basic-markdown ${plain ? "plain" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      className="copy-button"
      variant="ghost"
      size="icon"
      type="button"
      title={copied ? "Copied" : "Copy code"}
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

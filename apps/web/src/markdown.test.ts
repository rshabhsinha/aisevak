import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./components/markdown.js";

function renderMarkdown(text: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { text }));
}

describe("MarkdownContent", () => {
  it("renders links as safe clickable anchors", () => {
    const html = renderMarkdown("[Authenticate Google Cloud](https://accounts.google.com/oauth2/auth?scope=test)");
    const unsafeHtml = renderMarkdown("[Unsafe](javascript:alert(1))");

    expect(html).toContain('href="https://accounts.google.com/oauth2/auth?scope=test"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">Authenticate Google Cloud</a>");
    expect(unsafeHtml).not.toContain("javascript:");
  });

  it("renders GitHub-style formatting and fenced code", () => {
    const html = renderMarkdown("- **ready**\n- ~~obsolete~~\n\n```ts\nconst ready = true;\n```");

    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>ready</strong>");
    expect(html).toContain("<del>obsolete</del>");
    expect(html).toContain("<span>ts</span>");
    expect(html).toContain("const ready = true;");
  });

  it("does not interpret raw HTML", () => {
    const html = renderMarkdown('before<script>alert("xss")</script>after');

    expect(html).not.toContain("<script");
    expect(html).toContain("alert(&quot;xss&quot;)");
  });
});

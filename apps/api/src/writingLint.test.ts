import { describe, expect, it } from "vitest";
import { adviseWritingCheck, lintIncident, lintReport, writingLintMode } from "./writingLint.js";

const goodReport = {
  title: "Cloud health: quiet, four incidents still open",
  description: "Three-hour production check, 23:46–02:46 UTC on 19–20 Oct.",
  markdown: [
    "Production looks healthy and nothing new broke. Four incidents remain open, none with confirmed customer impact.",
    "",
    "- GCP errors rose from 0 to 5, all from the slow usage writes already tracked in `INC-36`.",
    "- One signup analytics call returned 503 (`INC-30`).",
    "",
    "Builder is restoring Vercel runtime-log access. No new incident."
  ].join("\n")
};

const goodIncident = "Probably a false alarm. The warning comes from an hourly sync job that never calls Anthropic, and `REPORT-657` shows no failed requests. Impact is unconfirmed until someone checks the production secret.";

const filler = (words: number) => Array.from({ length: words }, () => "word").join(" ");

function rules(check: { errors: Array<{ rule: string }>; warnings: Array<{ rule: string }> }) {
  return { errors: check.errors.map((item) => item.rule), warnings: check.warnings.map((item) => item.rule) };
}

describe("report writing lint", () => {
  it("passes a short plain report", () => {
    expect(rules(lintReport(goodReport))).toEqual({ errors: [], warnings: [] });
  });

  it("does not require any particular layout or labels", () => {
    const layouts = [
      "All quiet. No action needed.",
      "## Summary\n\nAll quiet.\n\n## Details\n\n- Nothing changed.",
      "| Check | Result |\n|---|---|\n| Builds | Passing |\n| Deploys | None |"
    ];
    for (const markdown of layouts) expect(lintReport({ ...goodReport, markdown }).passed).toBe(true);
  });

  it("rejects timestamps in titles and warns on log-style bodies", () => {
    const check = lintReport({
      title: "Embedr cloud health — 2026-10-19T23:46:25Z to 2026-10-20T02:46:25Z",
      description: "Three-hour production comparison.",
      markdown: [
        "- Current [2026-10-19T23:46:25Z,2026-10-20T02:46:25Z); prior [2026-10-19T20:46:25Z,2026-10-19T23:46:25Z).",
        "- Counts: GCP flagged/errors/4xx/5xx 33/5/9/0 vs 13/0/2/0."
      ].join("\n")
    });
    expect(rules(check)).toEqual({ errors: ["title-identifiers"], warnings: ["timestamps", "packed-counts"] });
  });

  it("rejects long titles and descriptions", () => {
    const check = lintReport({ ...goodReport, title: "x".repeat(81), description: "y".repeat(201) });
    expect(rules(check).errors).toEqual(["title-length", "description-length"]);
  });

  it("rejects ledgers with long tables and raw UUIDs", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      `| ${index} | item-${index} | 981758a4-c188-4078-b1f3-8774a7272a46 |`);
    const check = lintReport({
      ...goodReport,
      markdown: `${goodReport.markdown}\n\n| Rank | Item | Owner |\n| --- | --- | --- |\n${rows.join("\n")}`
    });
    expect(rules(check).errors).toEqual(["table-rows", "raw-ids"]);
  });

  it("does not count a table header as a row", () => {
    const rows = Array.from({ length: 25 }, (_, index) => `| ${index} | item |`);
    const check = lintReport({ ...goodReport, markdown: `${goodReport.markdown}\n\n| Rank | Item |\n|---|---|\n${rows.join("\n")}` });
    expect(check.passed).toBe(true);
  });

  it("counts rows across several tables, ignoring fenced separators", () => {
    const table = (rows: number) => `| A | B |\n|---|---|\n${Array.from({ length: rows }, (_, index) => `| ${index} | x |`).join("\n")}`;
    const fencedSeparators = "```text\n" + Array.from({ length: 6 }, () => "|---|---|").join("\n") + "\n```";
    const check = lintReport({ ...goodReport, markdown: `${goodReport.markdown}\n\n${table(20)}\n\n${table(20)}\n\n${fencedSeparators}` });
    expect(check.errors.find((item) => item.rule === "table-rows")?.message).toContain("now 40");
  });

  it("counts rows in tables written without leading pipes", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `${index} | x`).join("\n");
    const check = lintReport({ ...goodReport, markdown: `${goodReport.markdown}\n\nA | B\n--- | ---\n${rows}` });
    expect(rules(check).errors).toEqual(["table-rows"]);
  });

  it("warns, then errors, as the prose grows", () => {
    expect(rules(lintReport({ ...goodReport, markdown: filler(300) }))).toEqual({ errors: [], warnings: ["length", "long-block"] });
    expect(rules(lintReport({ ...goodReport, markdown: filler(450) })).errors).toEqual(["length"]);
  });

  it("counts fenced code toward length but not toward paragraph warnings", () => {
    const short = lintReport({ ...goodReport, markdown: `${goodReport.markdown}\n\n\`\`\`bash\npnpm test\n\`\`\`` });
    expect(rules(short)).toEqual({ errors: [], warnings: [] });
    const logs = Array.from({ length: 250 }, (_, index) => `line ${index}`).join("\n");
    expect(rules(lintReport({ ...goodReport, markdown: `\`\`\`text\n${logs}\n\`\`\`` }))).toEqual({ errors: ["length"], warnings: [] });
  });

  it("treats text after an unclosed fence as prose", () => {
    expect(rules(lintReport({ ...goodReport, markdown: `\`\`\`\n${filler(450)}` })).errors).toEqual(["length"]);
  });

  it("counts rows in tables with one-dash separators", () => {
    const rows = Array.from({ length: 40 }, (_, index) => `|${index}|x|`).join("\n");
    expect(rules(lintReport({ ...goodReport, markdown: `|a|b|\n|-|-|\n${rows}` })).errors).toEqual(["table-rows"]);
  });

  it("does not mistake slash dates for packed counts", () => {
    expect(rules(lintReport({ ...goodReport, markdown: "Shipped on 10/20/2026 and 2026/10/21." })).warnings).toEqual([]);
  });

  it("flags a heading that repeats the title and a description that repeats it", () => {
    const check = lintReport({ title: "Weekly review", description: "Weekly review", markdown: "# Weekly review\n\nFine." });
    expect(rules(check)).toEqual({ errors: [], warnings: ["description-repeats-title", "repeated-title"] });
  });
});

describe("incident writing lint", () => {
  it("passes a short update in any layout", () => {
    expect(rules(lintIncident({ markdown: goodIncident, stage: "update" }))).toEqual({ errors: [], warnings: [] });
    expect(lintIncident({ markdown: "Resolved: three quiet hours in `REPORT-661`.", stage: "resolve" }).passed).toBe(true);
  });

  it("uses tighter length limits than reports", () => {
    expect(rules(lintIncident({ markdown: filler(150), stage: "update" })).warnings).toContain("length");
    expect(rules(lintIncident({ markdown: filler(260), stage: "update" })).errors).toEqual(["length"]);
  });

  it("checks title and description only when declaring", () => {
    const title = "x".repeat(100);
    expect(rules(lintIncident({ title, description: "Short.", markdown: goodIncident, stage: "declare" })).errors).toEqual(["title-length"]);
    expect(lintIncident({ title, markdown: goodIncident, stage: "update" }).passed).toBe(true);
  });
});

describe("writing lint mode", () => {
  const failing = lintReport({ title: "x".repeat(90), description: "Scope.", markdown: filler(450) });

  it("returns findings as advice, and nothing when off", () => {
    expect(adviseWritingCheck(failing, "warn")).toBe(failing);
    expect(failing.errors.map((item) => item.rule)).toEqual(["title-length", "length"]);
    expect(adviseWritingCheck(failing, "off")).toEqual({ passed: true, errors: [], warnings: [] });
  });

  it("only turns off when asked; legacy enforce values still just warn", () => {
    expect(writingLintMode(undefined)).toBe("warn");
    expect(writingLintMode("enforce")).toBe("warn");
    expect(writingLintMode("off")).toBe("off");
  });
});

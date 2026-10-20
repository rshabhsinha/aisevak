import { describe, expect, it } from "vitest";
import { assertWritingCheck, lintIncident, lintReport, writingLintMode } from "./writingLint.js";

const goodReport = {
  title: "Cloud health: quiet, four incidents still open",
  description: "Three-hour production check, 23:46–02:46 UTC on 19–20 Oct.",
  markdown: [
    "**Bottom line:** Production looks healthy and nothing new broke. Four existing incidents remain open, none with confirmed customer impact.",
    "",
    "**What changed**",
    "- GCP errors rose from 0 to 5, all from the slow usage writes already tracked in `INC-36`.",
    "- One signup analytics call returned 503 (`INC-30`).",
    "",
    "**Next:** Builder restores Vercel runtime-log access. No new incident.",
    "",
    "References: `INC-25`, `INC-30`, `INC-36`, `INC-40`"
  ].join("\n")
};

const goodIncident = [
  "**Status:** Open, medium. Probably a false alarm, but not yet confirmed.",
  "",
  "**Impact:** Unconfirmed. No Anthropic request failures were seen in `REPORT-657`.",
  "",
  "**Evidence:** The warning comes from an hourly sync job that never calls Anthropic.",
  "",
  "**Next:** Someone with GCP access deploys Builder's fix and confirms the secret."
].join("\n");

function rules(check: { errors: Array<{ rule: string }>; warnings: Array<{ rule: string }> }) {
  return { errors: check.errors.map((item) => item.rule), warnings: check.warnings.map((item) => item.rule) };
}

describe("report writing lint", () => {
  it("passes a report in the documented shape", () => {
    const check = lintReport(goodReport);
    expect(check.passed).toBe(true);
    expect(rules(check)).toEqual({ errors: [], warnings: [] });
  });

  it("accepts label variants and a leading heading", () => {
    const check = lintReport({ ...goodReport, markdown: "## Summary\n\nBottom line: All quiet.\n\n## Next\n\nNo action needed." });
    expect(check.passed).toBe(true);
  });

  it("rejects the dense log-style report the skill warns about", () => {
    const check = lintReport({
      title: "Embedr cloud health — 2026-10-19T23:46:25Z to 2026-10-20T02:46:25Z",
      description: "Exact three-hour Embedr production comparison with the preceding three hours; deduplicated against existing incidents.",
      markdown: [
        "## Snapshot",
        "- Current [2026-10-19T23:46:25Z,2026-10-20T02:46:25Z); prior [2026-10-19T20:46:25Z,2026-10-19T23:46:25Z).",
        "- Counts: GCP flagged/errors/4xx/5xx 33/5/9/0 vs 13/0/2/0."
      ].join("\n")
    });
    expect(check.passed).toBe(false);
    expect(rules(check).errors).toEqual(["title-identifiers", "bottom-line", "next"]);
    expect(rules(check).warnings).toEqual(expect.arrayContaining(["timestamps", "packed-counts"]));
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

  it("warns, then errors, as the prose grows", () => {
    const filler = (words: number) => Array.from({ length: words }, () => "word").join(" ");
    const long = lintReport({ ...goodReport, markdown: `**Bottom line:** ${filler(300)}\n\n**Next:** None.` });
    expect(rules(long)).toEqual({ errors: [], warnings: ["length", "long-block"] });
    const tooLong = lintReport({ ...goodReport, markdown: `**Bottom line:** ${filler(450)}\n\n**Next:** None.` });
    expect(rules(tooLong).errors).toEqual(["length"]);
  });

  it("ignores fenced code when counting prose", () => {
    const code = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const check = lintReport({ ...goodReport, markdown: `${goodReport.markdown}\n\n\`\`\`text\n${code}\n\`\`\`` });
    expect(check.passed).toBe(true);
  });

  it("flags a heading that repeats the title and a description that repeats it", () => {
    const check = lintReport({
      title: "Weekly review",
      description: "Weekly review",
      markdown: "# Weekly review\n\n**Bottom line:** Fine.\n\n**Next:** None."
    });
    expect(rules(check)).toEqual({ errors: [], warnings: ["description-repeats-title", "repeated-title"] });
  });
});

describe("incident writing lint", () => {
  it("passes an update in the documented shape", () => {
    expect(rules(lintIncident({ markdown: goodIncident, stage: "update" }))).toEqual({ errors: [], warnings: [] });
  });

  it("requires a status lead and a next step on updates", () => {
    const check = lintIncident({ markdown: "Builder traced the warning to module-load validation.", stage: "update" });
    expect(rules(check).errors).toEqual(["status", "next"]);
    expect(rules(check).warnings).toEqual(["impact"]);
  });

  it("checks title and description only when declaring", () => {
    const title = "x".repeat(100);
    expect(rules(lintIncident({ title, description: "Short.", markdown: goodIncident, stage: "declare" })).errors).toEqual(["title-length"]);
    expect(lintIncident({ title, markdown: goodIncident, stage: "update" }).passed).toBe(true);
  });

  it("requires resolutions to say Resolved and nothing more", () => {
    expect(lintIncident({ markdown: "**Status:** Resolved. Three quiet hours in `REPORT-661`.", stage: "resolve" }).passed).toBe(true);
    expect(rules(lintIncident({ markdown: "**Status:** Monitoring.", stage: "resolve" })).errors).toEqual(["status"]);
  });
});

describe("writing lint enforcement", () => {
  const failing = lintReport({ title: "Fine", description: "Scope.", markdown: "No lead." });

  it("throws a 422 listing every finding when enforcing", () => {
    expect(() => assertWritingCheck(failing, "REPORT-9", "enforce")).toThrowError(
      expect.objectContaining({ statusCode: 422, code: "WRITING_LINT", message: expect.stringContaining("Bottom line") })
    );
  });

  it("returns findings without throwing in warn mode and nothing when off", () => {
    expect(assertWritingCheck(failing, "REPORT-9", "warn").errors.length).toBe(2);
    expect(assertWritingCheck(failing, "REPORT-9", "off")).toEqual({ passed: true, errors: [], warnings: [] });
  });

  it("defaults to enforce for unknown modes", () => {
    expect(writingLintMode(undefined)).toBe("enforce");
    expect(writingLintMode("bogus")).toBe("enforce");
    expect(writingLintMode("warn")).toBe("warn");
  });
});

---
name: report-writing
description: Read before every `aisevak reports create`, `revise`, or `publish`. Write short, plain-language Aisevak reports that make the situation, impact, and next action obvious at a glance; publishing is linted and rejected when the shape is wrong.
---

# Report writing

A report is read by a busy human scrolling the Activity feed. They read the title and the first two lines, then decide whether to open it. Write for that reader, not for a log parser, an auditor, or the next agent run.

Keep audit detail (every query, every count, every coverage caveat) in the thread or run log. The report carries only what changes the reader's understanding or next decision.

## Shape

```markdown
**Bottom line:** <one or two plain sentences: what is healthy, what is broken, what is unknown.>

**What changed**
- <three to five bullets, each one fact and why it matters>

**Next:** <one action and who owns it, or "No action needed.">

References: `INC-7`, `REPORT-105`
```

- **Title** (max 80 characters): what a person would say out loud. "Cloud health: quiet, four incidents still open", not "Embedr cloud health — 2026-10-19T23:46:25Z to 2026-10-20T02:46:25Z".
- **Description** (max 200 characters): the scope in one line, such as "Three-hour production check, 23:46–02:46 UTC." It must not repeat the title.
- **Body**: do not repeat the title as a heading. The first line is `**Bottom line:**`. The body has a `**Next:**` line. Aim for 150 words, never more than 400.

## Rules

- Write numbers as sentences. "GCP errors rose from 0 to 5" reads; "flagged/errors/4xx/5xx 33/5/9/0 vs 13/0/2/0" does not.
- Use short times ("02:11 UTC", "last 3 hours"). Give the full time window once, in the description.
- Never paste UUIDs, run IDs, or hashes the reader cannot act on. Use stable references (`INC-40`, `TASK-1033`) or names.
- Explain an internal name the first time it appears ("`llmProxy`, the function that calls Anthropic").
- Say "not checked" or "unknown" when a source was unavailable. Missing data is never "healthy".
- Group signals by what the reader should do, not by which system you queried.
- Skip sections that would be empty, and skip "Coverage", "Snapshot", or methodology sections unless a gap changes the conclusion. In that case put it in the bottom line.

## Living reports and ledgers

A report is not a database. When you revise a recurring report such as a backlog or status board:

- Make the bottom line about the change since the last revision and what is blocked, such as "5 of 5 slots busy; 3 items waiting on an operator to reopen tasks."
- Show at most 25 table rows: active, blocked, and recently finished items. Put the full ledger in the owning system (a file, an export command, or a dashboard) and link to it.
- Never put owner UUIDs or task UUIDs in table cells. Use `TASK-n` references.

## Example

Before (hard to follow):

> **Embedr cloud health — 2026-10-19T23:46:25Z to 2026-10-20T02:46:25Z**
> Snapshot: Current [2026-10-19T23:46:25Z,2026-10-20T02:46:25Z); prior [...]. Coverage: GCP/Firebase, AWS logs/ECS/Lambda/CloudTrail, GitHub Actions (5 repos)... Counts: GCP flagged/errors/4xx/5xx 33/5/9/0 vs 13/0/2/0...

After:

> Title: Cloud health: quiet, four incidents still open
> Description: Three-hour production check, 23:46–02:46 UTC on 19–20 Oct.
>
> **Bottom line:** Production looks healthy and nothing new broke. Four existing incidents remain open, none with confirmed customer impact. Vercel runtime logs timed out, so they were not checked.
>
> **What changed**
> - GCP errors rose from 0 to 5, all from the slow usage writes already tracked in `INC-36`. No 5xx responses.
> - One signup analytics call returned 503 (`INC-30`); the previous window had none.
> - Builds, deploys, ECS services, and load-balancer targets match the previous window.
>
> **Next:** Builder restores Vercel runtime-log access so the next check covers it. No new incident.
>
> References: `INC-25`, `INC-30`, `INC-36`, `INC-40`, `REPORT-657`

## Publishing is linted

`aisevak reports publish` checks the current revision. `create` and `revise` return the same checks under `writingCheck` so you can fix problems early. If publish fails with `WRITING_LINT`, the message lists each problem. Revise the report and publish again. Do not pad, rename sections, or split the report to get around a rule; fix the writing.

Before publishing, remove every sentence that does not change the reader's understanding or next decision.

---
name: report-writing
description: Read before every `aisevak reports create`, `revise`, or `publish`. Write short, simple reports a busy person understands at a glance; publishing is linted for readability.
---

# Report writing

A person skimming the Activity feed should understand a report from its title and first few lines. They need to know what it is about, what it affects, and whether anyone has to do anything. Pick whatever layout makes that easiest: a short paragraph, a few bullets, a small table, or headings for a longer report.

## Keep it short and simple

- Lead with the point. Write the conclusion first; supporting detail comes after it, if at all.
- Make the title something a person would say out loud, and keep it to 80 characters or fewer. Put no timestamps or IDs in it.
- Use the description (200 characters or fewer) for scope, such as "Three-hour production check, 23:46–02:46 UTC". Do not repeat the title.
- Aim for under 250 words. More than 400 is flagged as too long.
- Leave out how you got the answer: the queries you ran, the sources you checked, your methodology. That belongs in the thread or run log. Mention a gap only when it changes the conclusion.
- Remove every sentence that does not change the reader's understanding or what they do next.

## Use plain words

- Write numbers as sentences. "Errors rose from 0 to 5" reads well; "33/5/9/0 vs 13/0/2/0" does not.
- Use short times, such as "02:11 UTC" or "in the last 3 hours".
- Refer to things by name or by a stable reference such as `INC-40` or `TASK-1033`. Never paste UUIDs, run IDs, or hashes.
- Explain an internal name the first time it appears, for example "`llmProxy`, the function that calls Anthropic".
- Say "not checked" or "unknown" when you don't know. Missing data never means healthy.

## Living reports

A report is not a database. When you revise a recurring report such as a backlog or a status board, lead with what changed and what is blocked. Show at most 25 table rows, covering the active, blocked, and recently changed items, and link the full list kept in the system that owns it.

## Readability checks

`create`, `revise`, and `publish` return readability findings under `writingCheck`. They cover the title, description, length, tables, and raw IDs. The write still goes through. When it lists problems, fix them in the next revision. Do not split or pad the report to get around a limit.

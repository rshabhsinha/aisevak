---
name: incident-writing
description: Read before every `aisevak incidents declare`, `update`, or `resolve`. Keep incident records short and simple so a reader sees what is wrong, what it affects, and what happens next; incident writes are linted for readability.
---

# Incident writing

Someone opening an incident wants to know, within seconds:

- what is wrong;
- what it affects, or that the impact is unconfirmed;
- where it stands now;
- what happens next, and who does it.

Answer those near the top, in whatever layout reads best. Each update is a fresh snapshot, not a log of the investigation.

## Keep it short and simple

- The title (80 characters or fewer) names the symptom in plain words, for example "Anthropic calls may fail: OpenRouter key missing". Don't use internal function names.
- The description (200 characters or fewer) is one line on why it matters.
- Aim for under 120 words per update. More than 250 is rejected.
- Give only the strongest evidence: one or two facts and a reference such as `REPORT-657`. Don't paste logs, stack traces, or every query you ran.
- Don't repeat earlier updates. Say what is different now.
- When you resolve an incident, say what was verified.

## Use plain words

- Say "unconfirmed" when impact is unknown. Missing telemetry never means no impact.
- Write numbers as sentences and use short times, such as "02:11 UTC". Don't paste UUIDs or slash-packed counts.
- Explain internal names the first time they appear.
- Use stable references in backticks: `INC-7`, `REPORT-105`, `TASK-34`.

## Incident writes are linted

`declare`, `update`, and `resolve` check readability before saving. They look at title and description length, update length, tables, and raw IDs. If a call fails with `WRITING_LINT`, nothing was recorded. The message lists each problem. Fix the writing and send it again.

---
name: incident-writing
description: Keep Aisevak incident records brief and operationally useful, with a clear status, customer impact, evidence, owner, and next step.
---

# Incident writing

Write incident updates so a reader can understand the situation in seconds.

- Start with `**Status:**` and say whether the incident is open, contained, monitoring, or resolved.
- State customer impact plainly. If impact is unconfirmed, say that directly; never turn missing telemetry into “no impact”.
- Include only the strongest evidence: the time window, one or two meaningful measurements, and the relevant report or run reference.
- End with `**Next:**` and one concrete action, owner, or acceptance check. Include an ETA only when it is known.
- Keep each update under 120 words. Use short paragraphs or three to five bullets; avoid incident-management jargon and repeated history.
- Distinguish current state from historical context. Say “still open because…” when the evidence does not yet meet the resolution check.
- Use stable references such as `INC-7`, `REPORT-105`, and `THREAD-12` in backticks. Do not paste raw logs or long stack traces.

An incident is ready to resolve only when its stated acceptance check is met and the update says what was verified.

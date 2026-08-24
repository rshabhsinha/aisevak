---
name: report-writing
description: Write short, plain-language Aisevak reports that make the current situation, impact, evidence, and next action obvious at a glance.
---

# Report writing

Write reports for a busy human, not for a log parser. The first two lines must answer: “What happened?” and “What should I care about?”

- Start with a short, human title. Put exact time windows and identifiers in a small `Window` or `References` line, not in the title.
- Begin with `**Bottom line:**` and state the outcome in one or two sentences. Say what is healthy, what is broken, and what is unknown.
- Use at most three short sections: `Bottom line`, `Evidence`, and `Next`. Prefer three to five bullets total. Keep the report under 180 words unless the user explicitly needs detail.
- Use concrete numbers only when they change the conclusion. Explain internal names the first time; keep product names, URLs, incident IDs, and error codes in backticks.
- Separate facts from interpretation. Say “not observed” or “not checked” instead of implying that an unavailable source was healthy.
- End with one clear next action, owner, or “no action needed”. Link related incidents with their stable references.
- Do not repeat the title, restate the prompt, narrate every query, or include boilerplate sections with no useful content.

Before publishing, remove sentences that do not change the reader’s understanding or next decision.

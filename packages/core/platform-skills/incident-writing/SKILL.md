---
name: incident-writing
description: Read before every `aisevak incidents declare`, `update`, or `resolve`. Keep incident records brief and operationally useful, with a clear status, customer impact, evidence, and next step; incident writes are linted and rejected when the shape is wrong.
---

# Incident writing

A reader opening an incident wants to know four things in ten seconds: is it still a problem, are customers hurt, what do we know, and who does what next. Each update is a fresh snapshot of those four things, not a log of the investigation.

## Shape

```markdown
**Status:** <Open | Contained | Monitoring | Resolved>, <severity>. <one sentence on where it stands.>

**Impact:** <who is affected, or "Unconfirmed." with why.>

**Evidence:** <one or two facts that support the status, with a reference such as `REPORT-657`.>

**Next:** <one action, its owner, and the check that closes the incident.>
```

- **Title** (max 80 characters): the symptom in plain words. "Anthropic calls may fail: OpenRouter key missing", not internal function names.
- **Description** (max 200 characters): one line that says why this matters.
- **Body**: the first line is `**Status:**`. Every update except a resolution has a `**Next:**` line. Aim for 120 words, never more than 250.

## Rules

- Say "Unconfirmed" when impact is unknown. Missing telemetry never means "no impact".
- Give only the strongest evidence: one or two measurements and a reference. Do not paste logs, stack traces, or every query you ran.
- Explain internal names the first time ("`reconcileNewsletterAuthUsers`, an hourly sync job").
- Do not repeat history from earlier updates. Readers can scroll. Say what is different now.
- Write numbers as sentences and use short times ("02:11 UTC"). No UUIDs or slash-packed counts.
- Use stable references in backticks: `INC-7`, `REPORT-105`, `THREAD-12`, `TASK-34`.

## Example

Before (hard to follow):

> **Status:** Open/medium. Builder traced the hourly `reconcileNewsletterAuthUsers` warning to module-load validation; that function binds only `SYNC_SECRET` and does not serve Anthropic. Source review found `OPENROUTER_KEY` bound to `llmProxy` and `getModelCatalog`. GCP secret state was not checked; no provider failures appeared in `REPORT-657`. **Impact:** Customer impact and production key state remain unconfirmed. The warning is a false positive for the hourly function, not proof... **Next:** An operator with repo push and GCP access publishes/deploys Builder's local fix (`fc783dd1`), verifies the `llmProxy` secret version, runs a production Anthropic canary, then observes three traffic-bearing hours...

After:

> **Status:** Open, medium. Probably a false alarm, but not yet confirmed.
>
> **Impact:** Unconfirmed. No Anthropic request failures were seen in the last check (`REPORT-657`).
>
> **Evidence:** The warning comes from an hourly sync job that never calls Anthropic. The function that does (`llmProxy`) has the key wired up in source. Nobody has checked the production secret yet.
>
> **Next:** Someone with GCP access deploys Builder's fix (`fc783dd1`) and confirms the `llmProxy` secret. Resolve after three hours with no missing-key warnings.

## Resolving

Resolve only when the acceptance check stated in `**Next:**` is met. The resolution note starts with `**Status:** Resolved.` and says what was verified, for example "Three hours of traffic with no missing-key warnings (`REPORT-661`)."

## Incident writes are linted

`declare`, `update`, and `resolve` check the Markdown before saving. If a call fails with `WRITING_LINT`, nothing was recorded. The message lists each problem; fix the update and send it again. Do not pad or rename sections to get around a rule.

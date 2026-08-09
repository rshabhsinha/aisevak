---
name: aisevak-cli
description: Use the Aisevak CLI when an isolated agent needs platform context or must coordinate through durable threads, tasks, schedules, reports, or incidents. Apply it to discover available agents and capabilities, inspect paginated resources lazily, delegate or route tracked work, schedule explicit future work, message another agent, and report completion or blockers back to the initiating thread.
---

# Aisevak CLI

Use the `aisevak` CLI as the interface to Aisevak's shared coordination state. It is already authenticated and available on `PATH` inside an agent run.

## Exercise judgment

- Do not call the CLI on every turn. Use it when shared platform state, another agent, or a durable artifact matters.
- Inspect narrowly. Start from the resource named in the prompt, use list filters and small limits, and follow cursors only when more results are relevant.
- Run `aisevak whoami` when identity or current task/thread context is unclear. Run `aisevak capabilities` before an uncertain mutation or to see installed skills.
- Treat CLI output as structured JSON. Preserve stable references such as `AGENT-Builder`, `THREAD-12`, `TASK-34`, `SCHEDULE-3`, `REPORT-5`, and `INC-2` in follow-up actions.
- Check command help or [references/commands.md](references/commands.md) when exact syntax is uncertain.

## Choose the coordination primitive

- Send or create a thread when a known agent should receive a focused request and return the result through a durable conversation.
- Create a task when work should be tracked as a platform work item. Omit `--agent` to route it to the Orchestrator; specify `--agent` only when the right specialist is clear.
- Create a schedule only when the request explicitly needs future or recurring execution. Choose the target agent deliberately, use an idempotency key, and avoid short or unbounded recurring intervals.
- Create a report for durable Markdown findings, analysis, plans, or handoff documents. Revise it instead of replacing history, then publish only when ready.
- Declare an incident for an operational problem that needs severity, updates, ownership, and explicit resolution. Do not use incidents for ordinary task failures.
- Keep local implementation details in the working context unless another agent or a durable record needs them.

## Inspect lazily

Prefer metadata and previews before full content:

```bash
aisevak show TASK-34
aisevak threads messages THREAD-12 --limit 10
aisevak content REPORT-5 --limit 20
aisevak content REPORT-5 --cursor '<nextCursor>' --limit 20
```

List resources with `--query`, `--status`, and a bounded `--limit`. Continue with the returned `nextCursor` only when necessary.

## Hand work to another agent

Discover the target if needed, then give the new thread a clear title, description, and purpose. Aisevak records the triggering agent, origin thread, callback agent, and completion command in the recipient's prompt.

```bash
aisevak agents list --query reviewer --limit 10
printf '%s\n' 'Review the parser change for correctness and list concrete issues with file references.' \
  | aisevak threads create \
      --title 'Review parser change' \
      --description 'Independent correctness review before completion' \
      --to Reviewer \
      --purpose-stdin
```

Use `--origin-thread` or `--origin-message` only when the current context does not already identify the origin. Use an idempotency key when retrying a create or send after an uncertain network result.

## Respond and finish

When another agent triggers you to do work, use the completion instruction in the received prompt. Send intermediate information only when it is useful; complete or block exactly once when the requested work reaches that state. Completion sends one final result to the triggering agent.

```bash
printf '%s\n' 'Implemented the parser fix and verified the focused regression tests.' \
  | aisevak threads complete THREAD-12 --summary-stdin

printf '%s\n' 'Blocked because the required signing credential is not available to this agent.' \
  | aisevak threads block THREAD-12 --reason-stdin
```

When an agent you triggered sends a completion or blocked response, treat it as a result notification. Do not complete or block the same thread and do not send an automatic acknowledgement. Continue your own work with the result.

If the triggered agent needs to do more work, send an explicit follow-up on the same thread:

```bash
printf '%s\n' 'Please also check the malformed-input case and report the outcome.' \
  | aisevak threads send THREAD-12 --body-stdin
```

This reactivates the thread and queues the follow-up to the triggered agent. It does not reopen a linked completed task; reopen the task explicitly when the tracked work item itself must resume.

## Handle Markdown safely

Prefer the `-stdin` form for bodies, purposes, summaries, reports, and incident updates. This preserves multiline Markdown and avoids shell quoting errors. Never place credentials or secret values in threads, tasks, reports, incidents, logs, or command arguments.

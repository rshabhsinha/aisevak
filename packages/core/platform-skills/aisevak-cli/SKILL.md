---
name: aisevak-cli
description: Use the Aisevak CLI when an isolated agent needs platform context, must coordinate through durable threads, tasks, schedules, reports, or incidents, or needs to publish a reusable skill. Apply it to discover available agents and capabilities, inspect paginated resources lazily, delegate or route tracked work, schedule explicit future work, message another agent, and report completion or blockers back to the initiating thread.
---

# Aisevak CLI

Use the `aisevak` CLI as the interface to Aisevak's shared coordination state. It is already authenticated and available on `PATH` inside an agent run.

## Exercise judgment

- Do not call the CLI on every turn. Use it when shared platform state, another agent, or a durable artifact matters.
- Inspect narrowly. Start from the resource named in the prompt, use list filters and small limits, and follow cursors only when more results are relevant.
- Run `aisevak whoami` when identity or current task/thread context is unclear. Run `aisevak capabilities` before an uncertain mutation or to see installed skills.
- Treat CLI output as structured JSON. Preserve stable references such as `AGENT-Builder`, `THREAD-12`, `TASK-34`, `SCHEDULE-3`, `REPORT-5`, and `INC-2` in follow-up actions.
- Check command help or [references/commands.md](references/commands.md) when exact syntax is uncertain.

## Install reusable skills

- Run `aisevak skills path` to inspect the skills resolved for this thread. Aisevak also exposes this isolated, regenerated view as `$AISEVAK_SKILLS_DIR`.
- Do not modify `$AISEVAK_SKILLS_DIR`; changes there are private to the thread and may be replaced before a later turn.
- To publish a reusable skill, author it in a separate directory under your private `$CODEX_HOME`, then run `aisevak skills install <directory>`. The authenticated API validates and copies it into the installed catalog followed by the Skills tab.
- Publishing requires `skills:write`, which is available to the Orchestrator by default. If it is unavailable, coordinate with the Orchestrator instead of editing shared storage directly.

## Choose the coordination primitive

- A task is the logical job. Every agent-created task needs a stable `--work-key`; retries with the same scope/key reuse the task, while a different immutable payload is a conflict. Human-created tasks receive a generated key when one is not supplied.
- A task owns exactly one coordination thread. Delegate specialist work with a keyed assignment inside that task. Assignments preserve the same coordination thread and provider session across follow-ups, review, rejection, provider failure, usage-limit recovery, and explicit retry.
- Create a child task only when the work is independently trackable and you can provide `--parent-task`; respect the task's fan-out and depth limits. Do not create a root task from inside an active task.
- Send a message on the existing task thread only for coordination that is not a separately tracked assignment.
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

Discover the target if needed, then create an assignment on the current task. Aisevak records the assignment, attempt, owner, delivery, and result and sends a live job envelope to the specialist.

```bash
aisevak agents list --query reviewer --limit 10
printf '%s\n' 'Review the parser change for correctness and list concrete issues with file references.' \
  | aisevak assignments create TASK-34 \
      --key parser-review-v1 \
      --to Reviewer \
      --instructions-stdin
```

Use the same assignment key for an idempotent retry. Never create a recovery, review, rejection, or retry thread for work that already belongs to an assignment. Use `assignments send` for follow-up, `assignments retry` for a new attempt, and complete or block the assignment when the specialist's part is terminal.

```bash
aisevak assignments list TASK-34
printf '%s\n' 'Please re-check the malformed-input case.' | aisevak assignments send ASSIGNMENT-7 --body-stdin
printf '%s\n' 'Implemented and verified the parser change.' | aisevak assignments complete ASSIGNMENT-7 --result-stdin
```

`threads create` is only for an explicitly detached, keyed coordination stream and requires the dedicated detached-thread capability. It is rejected from an active task even when an old skill or stored capability still says `threads:create`.

## Respond and finish

When another agent triggers an assignment, use the live envelope and assignment reference in the prompt. Send intermediate information only when useful; complete or block the assignment exactly once when that specialist work reaches a terminal state. Assignment completion reports to the task owner and does not complete the parent task or coordination thread.

```bash
printf '%s\n' 'Implemented the parser fix and verified the focused regression tests.' \
  | aisevak assignments complete ASSIGNMENT-7 --result-stdin

printf '%s\n' 'Blocked because the required signing credential is not available to this agent.' \
  | aisevak assignments block ASSIGNMENT-7 --result-stdin
```

When an agent you assigned sends a completion or blocked response, treat it as a result notification. Do not complete or block the parent task or coordination thread automatically. Continue the job using the assignment result; retry the same assignment when the policy permits.

If the assigned agent needs to do more work, send an explicit follow-up on the same assignment:

```bash
printf '%s\n' 'Please also check the malformed-input case and report the outcome.' \
  | aisevak assignments send ASSIGNMENT-7 --body-stdin
```

This queues the follow-up on the existing coordination thread and provider session. It does not create another coordination tree. Reopen the task only when the overall job itself must resume.

## Handle Markdown safely

Prefer the `-stdin` form for bodies, purposes, summaries, reports, and incident updates. This preserves multiline Markdown and avoids shell quoting errors. Never place credentials or secret values in threads, tasks, reports, incidents, logs, or command arguments.

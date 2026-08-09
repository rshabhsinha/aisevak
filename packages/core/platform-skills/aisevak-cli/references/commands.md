# Aisevak CLI command reference

All commands return JSON. Resource lists accept `--limit`, `--cursor`, `--status`, and `--query`. Use the `nextCursor` returned by a list or content response to request the next page.

## Identity and discovery

```text
aisevak whoami
aisevak capabilities
aisevak agents list [--query TEXT] [--limit N] [--cursor CURSOR]
aisevak agents show AGENT
aisevak skills path
```

`capabilities` also lists the skills resolved for the current agent, project, and task.
`skills path` returns the persistent directory where a reusable skill can be installed for discovery by the Skills tab.

## Generic resources

```text
aisevak show REF
aisevak content REF [--limit N] [--cursor CURSOR]
```

Use `show` for metadata and a bounded preview. Use `content` for paginated Markdown or message history.

## Threads and messages

```text
aisevak threads list [--status STATUS] [--query TEXT] [--limit N] [--cursor CURSOR]
aisevak threads show THREAD
aisevak threads messages THREAD [--limit N] [--cursor CURSOR]
aisevak threads create --title TITLE --description DESCRIPTION --to AGENT --purpose-stdin \
  [--project-id UUID] [--task TASK] [--origin-thread THREAD] [--origin-message MESSAGE] \
  [--idempotency-key KEY]
aisevak threads send THREAD [--to AGENT] --body-stdin [--reply-to MESSAGE] [--idempotency-key KEY]
aisevak threads complete THREAD --summary-stdin [--idempotency-key KEY]
aisevak threads block THREAD --reason-stdin [--idempotency-key KEY]
```

Addressing a message queues it for the recipient. Completing or blocking is reserved for the agent triggered on an active thread and sends one final result to the triggering agent. The triggering agent must treat that result as a notification and must not finalize the same thread in response. If more work is needed, `threads send` on the completed or blocked thread reactivates it and queues the follow-up to the triggered agent.

## Tasks

```text
aisevak tasks list [--status STATUS] [--query TEXT] [--limit N] [--cursor CURSOR]
aisevak tasks show TASK
aisevak tasks create --title TITLE --description DESCRIPTION --body-stdin \
  [--status STATUS] [--project-id UUID] [--agent AGENT] [--idempotency-key KEY]
aisevak tasks update TASK [--title TITLE] [--description DESCRIPTION] [--body-stdin] [--status STATUS]
aisevak tasks assign TASK --agent AGENT
aisevak tasks complete TASK [--summary-stdin]
aisevak tasks reopen TASK [--summary-stdin]
aisevak tasks comment TASK --body-stdin
aisevak tasks attention TASK --reason-stdin
```

Creating a task without `--agent` assigns it to the Orchestrator for routing. Each created task gets a linked coordination thread and a callback to the creating agent.

## Schedules

```text
aisevak schedules list [--status scheduled|paused|completed] [--query TEXT] [--limit N] [--cursor CURSOR]
aisevak schedules show SCHEDULE
aisevak schedules create --title TITLE --agent AGENT --at ISO-8601 --prompt-stdin \
  [--interval-seconds N] [--idempotency-key KEY]
aisevak schedules pause SCHEDULE
aisevak schedules resume SCHEDULE
aisevak schedules delete SCHEDULE
```

Omit `--interval-seconds` for a one-time run. A repeating schedule advances from the current time after downtime instead of replaying every missed interval. Creating, pausing, resuming, or deleting schedules requires `schedules:write`, which is available to the Orchestrator by default; other agents can inspect schedules.

## Reports

```text
aisevak reports list [--status STATUS] [--query TEXT] [--limit N] [--cursor CURSOR]
aisevak reports show REPORT
aisevak reports create --title TITLE --description DESCRIPTION --markdown-stdin \
  [--project-id UUID] [--thread THREAD]
aisevak reports revise REPORT --markdown-stdin
aisevak reports publish REPORT
```

Reports keep immutable Markdown revisions. A revision returns the report to draft status until it is published again.

## Incidents

```text
aisevak incidents list [--status STATUS] [--query TEXT] [--limit N] [--cursor CURSOR]
aisevak incidents show INC
aisevak incidents declare --title TITLE --description DESCRIPTION --severity low|medium|high|critical \
  --markdown-stdin [--project-id UUID] [--to AGENT]
aisevak incidents update INC --markdown-stdin
aisevak incidents resolve INC [--markdown-stdin]
```

Declaring an incident creates a linked coordination thread. Without `--to`, the Orchestrator becomes incident commander.

## Credentials

```text
aisevak credentials list
aisevak credentials get NAME
aisevak credentials add NAME [--description DESCRIPTION] --value-stdin
```

Fetch a credential only when required and never echo it into durable resources or logs. Whether credential operations are available depends on the current agent's capabilities.

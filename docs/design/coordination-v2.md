# Coordination v2: reliable, harness-agnostic agent messaging

Status: phases 1–3 are implemented: phase 1 in rshabhsinha/aisevak#46 (section 8), phase 2 in rshabhsinha/aisevak#48 (section 9), and phase 3 in its follow-up PR (section 10). Phases 4 and 5 are proposed. Where a section 3 proposal was built differently, sections 9 and 10 are authoritative.
Assumes rshabhsinha/aisevak#45 (successful worker runs only auto-complete standalone tasks; parent-task owners can reopen children) has merged.

## 1. Why

Investigating coordination thread `84a89858` showed that agents could not coordinate reliably:

| Symptom | Root cause in the code today |
| --- | --- |
| TASK-1005/1033/1034 closed milliseconds after an operator ping | A UI message on a task-bound agent thread runs as a **worker `task_run`** (`queueTaskBoundAgentThreadMessage` → `queueWorkerRun`), and `finalizeWorkerRunState` set the task to `completed` on any successful turn. (Narrowed by #45.) |
| Review assignments refused, reviewer callbacks "delivery failed" | Assignment creation and assignment delivery are gated on task status (`Cannot add an assignment to a completed task`, `claimAgentTurnInput` skips inputs whose assignment is terminal). Task status was being flipped by turn lifecycle, so delivery depended on an unrelated side effect. |
| Orchestrator could not reopen children | `reopenTask` was owner-only and needed `tasks:update`, which `effectiveCapabilities` strips from every worker. (Narrowed by #45.) |
| Reviewer got 404 on thread ids it was given | Two id namespaces: the UI and the job envelope show **`agent_threads.id`** (a provider session); every agent-tools route resolves `THREAD-n`/uuid only against **`coordination_threads`**. |
| ASSIGNMENT-70 lost its binding after a 09:48 runner restart | `recoverInterruptedCoordinationRuns` fails every presented delivery of a running coordination turn and `markAssignmentDeliveryTerminal` sets the assignment to `blocked`. Nothing tells the sender. |
| Skills forbid pinging | A ping on a task thread could start a second writer (a worker run) on the task. |
| The controller cannot tell if a worker is idle | There is no thread-state query; state is spread across `task_runs`, `dispatcher_runs`, `agent_turn_inputs`, `message_deliveries`, `task_assignments`. |

The goal is messaging that behaves like Claude Code subagents (`ListAgents` / `SendMessage`): any agent can find another, send it a message at any time, optionally wait for a reply, and trust that the message is either processed or that it will be told it was not, on every harness (Codex, Claude Code, Cursor, OpenCode, Devin).

## 2. State before v2 (baseline)

This section maps the system as it was before v2, at `main` after #45. It is kept as the baseline the design was measured against. Phases 1 and 2 changed several of the behaviours below:
* thread ids from the UI now resolve;
* messages carry a delivery state and failures notify the sender;
* runner restarts redeliver interrupted turns instead of blocking their assignments;
* worker turns left running are recovered;
* UI pings no longer change task status.

Sections 8 and 9 describe the code as it is now.

### 2.1 Entities (`packages/core/src/migrations.ts`)

| Table | Role | Key facts |
| --- | --- | --- |
| `agent_threads` | A provider session of one agent: cwd, runtime home, `provider_thread_id`, model. | Unique per `task_id` and per `(coordination_thread_id, agent_id)`. `ownership_generation` fences turns queued before an ownership change. Chat threads created from the UI have no coordination thread. |
| `coordination_threads` (`THREAD-n`) | A multi-agent conversation. One per task (`tasks.coordination_thread_id`), or detached and keyed by `(work_scope, work_key)`. | `primary_agent_id` (triggered agent), `callback_agent_id` (who gets the result), `status` active/completed/blocked. |
| `thread_participants` | Agents on a coordination thread with a role. | |
| `thread_messages` (`MESSAGE-n`) | Immutable messages; `message_type` (`message`, `handoff`, `assignment.created`, `assignment.completed`, `completion`, `blocked`, `task.reopened`, …). | Idempotent per `(sender_agent_id, idempotency_key)`. `parent_message_id` exists but is unused for correlation. |
| `message_deliveries` | One per `(message, recipient)`. This is the closest thing to an inbox item. | `queued → running → completed`, `retrying`, `failed`; `attempt_count` (max 3), `presented_at`, `available_at`. `completed` means the carrying turn ended successfully, not that the recipient acted on it. |
| `agent_turn_inputs` | Mid-turn input bound to one specific run (`task_run_id` xor `dispatcher_run_id`). | `queued → delivering → delivered/failed`. Unique per delivery. |
| `task_runs` | Worker turns on a task (`run_kind='worker'`). | On finish, `finalizeWorkerRunState` may change task and thread status. |
| `dispatcher_runs` | Orchestrator heartbeat turns, UI chat turns (`scope='thread'`), and **coordination delivery turns** (`scope='coordination'`, `message_delivery_id`). | `launch_attempted_at` decides restart retry. |
| `task_assignments` (`ASSIGNMENT-n`) | Keyed unit of specialist work inside a task. | `queued/running/completed/blocked/cancelled`, `active_delivery_id`, `attempt_count`. |
| `agent_tool_tokens` | Bearer token for the `aisevak` CLI, bound to run, agent, agent thread, coordination thread, assignment. | 24h expiry. |

### 2.2 Send path (`apps/api/src/coordination.ts`)

`threads send` / `assignments create|send|retry|complete|block` / `tasks assign` / `reopenTask` / `finalizeThread` all do `insertMessage` then `queueDelivery(client, managedRoot, threadId, messageId, recipientAgentId, assignmentId?)`:

1. Upsert `message_deliveries`.
2. Find or create the recipient's `agent_threads` row for this coordination thread (task owners reuse the task's agent thread; others get `thread-<thread>-<agent>` homes). If cwd/home/task binding changed, bump `ownership_generation` and cancel stale queued runs.
3. If the agent thread has a queued or running **coordination** dispatcher run, append an `agent_turn_inputs` row to it (`queueIncrementalCoordinationInput`), folding other queued coordination runs into it.
4. Otherwise insert a new `dispatcher_runs` row (`scope='coordination'`) with a full `coordinationPrompt` (or an incremental one when a provider session exists).

UI paths (`apps/api/src/server.ts`): `/api/agent-threads/:id/messages` → task-bound threads go to `queueWorkerRun` (worker) or `queueDispatcherMessage`; projectless threads to `appendIncrementalAgentTurnInput` or a `scope='thread'` dispatcher run. `/steer` injects into the active run only.

### 2.3 Runner (`apps/runner/src/index.ts`)

* **Single consumer per agent thread already holds.** `claimDispatcherRun` and `claimWorkerRun` refuse a candidate when any `task_runs`/`dispatcher_runs` row on the same `agent_thread_id` is `running`/`cancel_requested`, lock the agent thread `FOR UPDATE SKIP LOCKED`, and check `ownership_generation`. `acquireRunLaunchFence` re-checks at launch.
* **Mid-turn injection works on every harness.** `claimAgentTurnInput` is polled every 750 ms by both `appServerClient` (Codex `turn/steer`) and `acpClient` (ACP `session/prompt`, used for Claude Code, Cursor, OpenCode, Devin). `finishAgentTurnInput` settles the delivery.
* **Delivery completion** (`finishMessageDelivery`): success → `completed`; failure → retry up to 3 attempts unless the prompt was (maybe) presented to an established provider thread, ownership changed, or another run is active; terminal failure → `markAssignmentDeliveryTerminal` sets the assignment `blocked`/`cancelled`. `settleDeliveryByAssignment` quietly settles deliveries whose assignment is already terminal or superseded.
* **Restart recovery** (`recoverInterruptedCoordinationRuns`, `recoverInterruptedDispatcherRuns`, `recoverStaleAgentThreadRuns`): interrupted runs become `failed`/`cancelled`; never-presented deliveries are requeued (`requeueUnpresentedRunDelivery`), presented ones are failed and their assignment blocked.
* **Worker finalization** (`finalizeWorkerRunState`, after #45): success completes only standalone tasks; failure sets `needs_attention` and blocks the coordination thread.

### 2.4 Authority

`effectiveCapabilities` gives workers read/send plus `tasks:complete` and assignment complete/block; the orchestrator (`kind='dispatcher'`) additionally gets create/update/assign/manage/retry. `requireTaskOwner` = task owner or orchestrator. #45 adds parent-task owners for reopen.

### 2.5 Tool surface

`agentToolScript()` (`packages/cli/src/script.ts`) is written to `<runtime_home>/bin/aisevak` with a token file for every harness; the `aisevak-cli` platform skill tells agents how to use it. There is no MCP server, no `wait`, no status query, and no sender-visible delivery state beyond a raw `delivery_status` column on message listings.

## 3. Target model

The target list from the investigation, refined against the code.

### 3.1 Addressing: one resolver, two honest concepts

A coordination thread (a conversation with several participants) and an agent thread (one agent's provider session and mailbox in that conversation) are genuinely different: a review conversation has one `THREAD-n` and two agent threads. Merging the tables would be a large, risky migration for little gain. Instead:

* **Every agent-facing reference resolves through one function** (`resolveThreadRef`): `THREAD-n`, a bare number, a coordination thread uuid, an **agent thread uuid** (mapped to its coordination thread, or its task's), or `TASK-n` (the task's coordination thread). Ids the UI shows therefore always work.
* Agents address **conversations** (`THREAD-n`) and **agents** (`AGENT-name`); they never need provider session ids.
* Later (phase 5) every agent thread gets a coordination thread lazily when first addressed, and the UI shows `THREAD-n`, so the mapping is total.

### 3.2 Inbox: one ordered, idempotent, single-consumer queue per agent thread

`message_deliveries` becomes the inbox. Each row is bound at enqueue time to its consumer `agent_thread_id` and gets a per-consumer `seq`. The invariants:

1. `send()` appends; it never starts a turn directly.
2. A **wake step** in the runner looks for agent threads with pending inbox items: if the thread has an active turn, items are injected at the next turn boundary (`nextInput`, unchanged harness code); if idle, one turn is started that drains all pending items in `seq` order (batched into one prompt). This replaces one-dispatcher-run-per-message and the supersede/migrate machinery (`queueIncrementalCoordinationInput`, `migrateStaleCoordinationRuns`, `appendIncrementalAgentTurnInput`'s folding).
3. Never two concurrent turns on one agent thread (already enforced by the claim queries; kept).
4. UI messages to task-bound threads go through the same inbox (as a `user` sender) instead of `queueWorkerRun`, so a ping can never start a second writer or a worker finalization. *Built differently in phase 2:* pings stay worker turns, so git-worktree tasks keep their workspace, but with `trigger='message'`, which never changes task status. The separate wake step (point 2) moved to phase 5. See section 9.

With that, "pinging" is always safe: the worst case is one extra inbox item consumed at the next boundary.

### 3.3 Request/reply

`thread_messages` gains `request_key` (unique per sender and thread), `expects_reply`, `reply_by`, `in_reply_to_message_id`, and `request_state` (`open → replied | timed_out | cancelled`). `aisevak send --key K --expect-reply [--timeout 30m]` creates a request; `aisevak reply MESSAGE-n` answers it (sets `in_reply_to_message_id`, closes the request, notifies the requester). Assignments become typed requests: `task_assignments.request_message_id` links the assignment to its request, `assignments complete/block` is a reply, review callbacks are replies to the review request. Timeouts are enforced by the watchdog (3.9) and delivered to the requester as `request.timed_out` inbox items.

### 3.4 Task lifecycle decoupled from turns

Only explicit `tasks complete|block|reopen|cancel` (and the human UI) change task status. A turn ending never changes task status, except tasks with `completion_policy = 'on_first_success'`, which is the default for human-created standalone tasks so today's "run this task" behaviour is kept. Delivery never depends on task status: messages to a closed task's thread are delivered (and shown with a "task is completed" banner); only *creating new assignments* on a closed task requires an explicit reopen.

### 3.5 Sender-visible message state

Per recipient: `queued → presented → consumed → replied`, or `failed`/`expired`. Mapping from the existing columns (built in phase 1): `queued|retrying → queued`, `running → delivering` (or `presented` once `presented_at` is set), `completed → delivered`, `failed → failed`. Splitting `delivered` into consumed and replied is phase 3. A terminal failure is itself delivered to the sender as a `delivery.failed` inbox item that names the message, recipient, error, affected assignment, and the exact retry command. Settlements that are not failures from the sender's point of view are quiet: the assignment was already terminal, a retry superseded the delivery, or the turn was stopped on purpose.

### 3.6 Turn leases and restart redelivery

Runs get `runner_id`, `lease_expires_at`, and a heartbeat (every 15 s, lease 60 s). Recovery acts only on this runner's own previous turns, or on other runners' leases that expired more than 2 minutes ago, so two runners or a fast restart never steal a live turn. If a takeover happens anyway, the old runner stops its turn and its finalizers are fenced, so it settles nothing (section 9). For an interrupted turn, every inbox item it presented but did not consume is requeued with `attempt+1` and an "Your previous turn was interrupted by a platform restart while handling this message; check what you already did before redoing it" preamble. The assignment stays `running`; it is only blocked after `maxAssignmentAttempts`, and that blocking produces a `delivery.failed` notice. This fixes the ASSIGNMENT-70 class of bug. Tool calls are already idempotent through idempotency keys, which makes redelivery safe.

### 3.7 Queryable thread state

Per agent thread: `running` (an active turn), `queued` (pending inbox items or a queued turn), `blocked(reason)` (its task is blocked/needs attention or its assignment is blocked), `waiting_on(refs)` (open assignments or requests it created), else `idle`. Exposed per participant by `aisevak threads status THREAD-n` and per agent by `aisevak agents status AGENT-x` (phase 2).

### 3.8 Authority by task tree

`canActOnTask(context, task)`: the orchestrator, the task owner, or the owner of any ancestor task (recursive CTE bounded by `maxChildDepth`). Used for send-to-assignee, reopen, cancel, retry, and status changes on a subtree. Workers keep their narrow capability set; tree ownership grants the subtree-scoped operations without granting global `tasks:update`.

### 3.9 Deterministic watchdog

A runner loop step (no LLM) evaluates, per open task: owner agent thread idle **and** inbox empty **and** not waiting on anything **and** no activity for `idle_after` (default 10 min) → send the owner a `watchdog.nudge` inbox item ("TASK-n is open and nothing is running; continue, complete, or block it"). After N nudges without activity → escalate to the parent owner (or orchestrator) as `watchdog.escalation`. Also expires request timeouts (3.3) and lease-expired turns (3.6). All actions are idempotent per `(task, window)`.

### 3.10 One tool surface for every harness

The same HTTP API is exposed two ways:

* **CLI** (existing `aisevak` script): additive verbs `threads status`, `send`, `reply`, `inbox`, `wait`, `status`.
* **MCP server**: `aisevak mcp` (stdio JSON-RPC inside the same script) exposing `agents_list`, `threads_list`, `threads_search`, `send`, `reply`, `inbox`, `wait`, `status`. Harness wiring: Codex via `config.toml [mcp_servers.aisevak]` in the runtime home; Claude Code, Cursor, OpenCode and Devin via the ACP `session/new` `mcpServers` parameter. The CLI remains the fallback for any harness without MCP.

`wait` is implemented server-side as a bounded long poll (`GET /inbox?wait=60s`) so it works identically from a shell and from MCP, and it never blocks a turn longer than the harness's tool timeout.

### 3.11 Long-lived controller threads (campaigns)

Today each 30-minute library check creates a new orchestrator task with its own thread (TASK-1085, TASK-1086, TASK-1089, …), and each run parents the component children it dispatches under its own task. The job tree is spread across many short-lived parents (TASK-1034 under TASK-1030, TASK-1005 under TASK-1002, …). Three things follow from that: every run starts cold and rebuilds state from `libraryctl status`; children report to a run whose thread is already stopped (TASK-1086 showed `shutdown=stopped` mid-conversation, because the envelope's shutdown state follows the task's status); and a reopen or escalation has to find the right old parent.

The target is one long-lived controller thread per campaign. The platform holds the job state, and the conversation history is not treated as the record:

1. **One campaign task and thread** (for example "Component Library campaign 2026-08-30") stays open for the life of the campaign, and every component task is its child, so there is one tree to query. Because the task stays open, its envelope stays `shutdown=running`.
2. **Schedule ticks are inbox messages, not new tasks.** A schedule with a target thread (`schedules.thread_id`) appends a `schedule.tick` item to that thread's inbox. The single-consumer inbox (3.2) means a tick that arrives while the orchestrator is still working waits in the queue, so runs can never overlap. A tick is coalesced when an earlier tick from the same schedule is still unconsumed (idempotency key `schedule:<id>:pending`), so a long run does not leave a backlog of ticks. Schedules therefore get a second target, "deliver to an existing thread", next to today's "create a task": `POST /api/agent-tools/v1/schedules` accepts `thread` (`aisevak schedules create --thread THREAD-n`), and the runner's `enqueueDueSchedule` inserts a message and queues its delivery instead of creating a task and dispatcher run when `thread_id` is set. `overlap_policy` keeps its meaning for task-creating schedules; thread schedules always coalesce.
3. **Child events go to the parent's inbox.** Assignment completed or blocked (already sent to the task owner today), child task completed, blocked or reopened, and domain events such as "published" are routed to the **parent task owner's** thread rather than to whichever run created the child. The orchestrator reacts to events, and the 30-minute tick becomes a safety net rather than the only time anything moves.
4. **Keep the thread id and refresh the conversation.** After N turns, or when the provider reports a large context, the next turn starts a fresh provider session (`agent_threads.provider_thread_id` is reset; the mechanism already exists for ownership changes) with a generated brief: the campaign task, its open children and their `threads status`, and pending inbox items. The thread id, inbox and task tree are unchanged, so a fresh conversation loses nothing authoritative. Policy: `agent_threads.context_policy = {maxTurns, maxContextTokens}`.

Trade-offs:

* Context growth: handled by point 4.
* A single point of failure if the controller thread wedges: handled by turn leases (3.6) and the watchdog (3.9), which nudges and then escalates an open campaign with an idle controller.
* Migration of existing trees: #45 only gives the **immediate** parent's owner the right to reopen a child. Authority by ancestry (3.8) extends that to the owner of any ancestor, so the campaign owner can act on children wherever they hang and re-parenting becomes optional. A one-off migration can re-parent the open component tasks under the campaign task for a single, queryable tree; the existing parents are left in place for history.

## 4. Data model and migrations

All migrations are additive (`ADD COLUMN IF NOT EXISTS`, new tables), consistent with `additiveSql`.

Phase 1 (built):

```sql
-- NULL = a terminal failure the sender has not been told about yet.
-- Existing rows get now() once, so history does not produce notices.
ALTER TABLE message_deliveries ADD COLUMN IF NOT EXISTS failure_notified_at timestamptz DEFAULT now();
ALTER TABLE message_deliveries ALTER COLUMN failure_notified_at DROP DEFAULT;
CREATE INDEX IF NOT EXISTS message_deliveries_failure_notice_idx
ON message_deliveries(completed_at) WHERE status = 'failed' AND failure_notified_at IS NULL;
```

Phase 2 (built; the full statements are in `packages/core/src/migrations.ts`):

```sql
CREATE SEQUENCE IF NOT EXISTS message_delivery_inbox_seq;        -- global, so monotonic per agent thread
ALTER TABLE message_deliveries ADD COLUMN IF NOT EXISTS agent_thread_id uuid;  -- FK to agent_threads, ON DELETE SET NULL
ALTER TABLE message_deliveries ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE message_deliveries ADD COLUMN IF NOT EXISTS interrupted_count integer NOT NULL DEFAULT 0;
-- Pending rows are backfilled from their turn input or run; partial indexes on
-- (agent_thread_id, seq) and (recipient_agent_id, seq) cover pending deliveries.
ALTER TABLE task_runs       ADD COLUMN IF NOT EXISTS runner_id text;
ALTER TABLE task_runs       ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS runner_id text;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
```

`consumed_at` (presented and then finished successfully, as distinct from today's `completed`) is deferred to phase 3, together with `wait`.

Backfill: `agent_thread_id` from `agent_turn_inputs`/`dispatcher_runs.message_delivery_id`; `seq` from `created_at` order.

Phase 3 (built; see section 10 for differences, and `packages/core/src/migrations.ts` for the exact statements):

```sql
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS expects_reply boolean NOT NULL DEFAULT false;
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS reply_by timestamptz;
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS in_reply_to_message_id uuid REFERENCES thread_messages(id) ON DELETE SET NULL;
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS request_state text CHECK (request_state IN ('open', 'replied', 'timed_out', 'cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS thread_messages_request_key_unique
ON thread_messages(thread_id, sender_agent_id, request_key) WHERE request_key IS NOT NULL;
ALTER TABLE task_assignments ADD COLUMN IF NOT EXISTS request_message_id uuid REFERENCES thread_messages(id) ON DELETE SET NULL;
-- Added without a default, backfilled once (tasks with created_by = a person
-- become 'on_first_success', the rest 'explicit'), then DEFAULT 'explicit' NOT NULL.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_policy text;
ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS context_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS turns_since_refresh integer NOT NULL DEFAULT 0;
```

`schedules.thread_id` was not needed: `schedules.task_id` already makes a schedule tick into that task's thread (section 10).

Phase 4 (watchdog):

```sql
CREATE TABLE IF NOT EXISTS watchdog_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,            -- nudge | escalation | request_timeout | lease_expired
  window_key text NOT NULL,      -- idempotency per task and window
  message_id uuid REFERENCES thread_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, kind, window_key)
);
```

## 5. API / CLI / MCP surface

All routes live under `/api/agent-tools/v1` and use the existing bearer token.

| Capability | HTTP | CLI | MCP tool | Phase |
| --- | --- | --- | --- | --- |
| Resolve any thread id | all `threads/:ref` routes accept `THREAD-n`, uuid, agent-thread uuid, `TASK-n` | unchanged commands | — | 1 |
| Message delivery state | `GET threads/:ref/messages`, `GET resources/MESSAGE-n` (`delivery.state`) | `aisevak show MESSAGE-n` | — | 1 |
| Thread state | `GET threads/:ref/status` | `aisevak threads status THREAD-n` | `status` | 1 |
| Failure notices | `delivery.failed` messages | — (arrive as inbox items) | — | 1 |
| Agent state | `GET agents/:ref/status` | `aisevak agents status AGENT-x` | `status` | 2 |
| Inbox | `GET inbox[?thread=&recent=true&wait=60]` | `aisevak inbox [--thread THREAD] [--recent] [--wait 60]` | `inbox`, `wait` | 2 (wait: 3) |
| Send (any thread/agent) | `POST send {to, thread?, body, key?, expectReply?, timeoutSeconds?}` | `aisevak send --to AGENT [--thread THREAD-n] [--key K] [--expect-reply [--timeout SECONDS]] --body-stdin` | `send` | 3 |
| Reply | `POST messages/:ref/reply` | `aisevak reply MESSAGE-n --body-stdin` | `reply` | 3 |
| Wait for reply | `GET messages/:ref/reply?wait=60` (at most 120) | `aisevak wait MESSAGE-n [--timeout 60]` | `wait` | 3 |
| Move tasks | `POST tasks/:ref/reparent {parent}` | `aisevak tasks reparent TASK... --parent TASK` | — | 3 |
| Task limits | `POST tasks/:ref/policy` | `aisevak tasks policy TASK --max-active-children N` | — | 3 |
| Retarget schedule | `PATCH schedules/:ref {task, overlapPolicy}` | `aisevak schedules update SCHEDULE --task TASK\|none` | — | 3 |
| Conversation refresh | `POST threads/:ref/refresh {everyTurns, now}` | `aisevak threads refresh THREAD [--every N] [--now]` | — | 3 |
| Search threads | `GET threads?query=` (exists) | `aisevak threads list --query` (exists) | `threads_search` | 4 |

Existing commands (`threads send|complete|block`, `assignments *`, `tasks *`) keep their syntax and semantics; new verbs are additive. `aisevak send` is a thin alias over `threads send` plus addressing by agent.

## 6. Failure-mode analysis

| Failure | Today | Target |
| --- | --- | --- |
| Runner restarts during a turn | Presented deliveries failed, assignment blocked, sender not told | Built. Phase 1: the sender gets `delivery.failed` with the retry command. Phase 2: the delivery is requeued with an "interrupted" preamble in the same session, and the assignment stays running until the attempt limit. |
| Two runners / overlapping restart | Recovery runs at boot and can fail a turn another runner still owns | Built. Recovery takes over only this runner's own previous turns, or other runners' leases expired for more than 2 minutes. A runner whose turn was taken over stops it, and its fenced finalizers settle nothing. |
| Turn stopped on purpose (Stop, archive) | Delivery failed silently | Built. Delivery fails with no `delivery.failed` notice, so the sender is not invited to undo the stop. |
| Queued turn cancelled by an internal ownership change (for example, opening or relinking a task's chat) | Delivery failed silently; assignment left active | Built in phase 1: the sender gets a `delivery.failed` notice. This is deliberately not quiet, because nothing else settles the assignment. Proposed for phase 3: requeue the delivery onto the new owner instead. |
| Worker turn left `running` by a dead runner | Never recovered; blocked its agent thread forever | Built. Recovered at boot (own) or by a sweep (others'); task status is left alone. |
| Message to an agent with an active turn | Injected (Codex steer / ACP prompt) or queued run | Same; ordered by inbox `seq`. |
| Message to an idle agent | One dispatcher run per message, later folded | One turn drains all pending items. |
| Ping on a task thread | Could start a worker run that auto-closed the task | Inbox item; no worker finalization; task status untouched. |
| Recipient's thread archived | `assertThreadAcceptsInput` throws; send fails | Built in phase 1: the notice sweeper skips the notice (one attempt, recorded). Proposed for phase 3: the send succeeds and the delivery fails fast with `delivery.failed` to the sender. |
| Duplicate send (retry by agent) | Idempotency key on `(sender, key)` | Same, plus `request_key` for requests. |
| Delivery-failure notice itself fails | n/a | Never generates another notice (`delivery.failed` is excluded), so no loops. |
| Assignment completed, then turn fails | `settleDeliveryByAssignment` settles quietly | Same; quiet settlements are marked notified so they produce no notice. |
| Retry supersedes an older delivery | Older delivery failed quietly | Same, marked notified. |
| Worker never finishes, nothing running | Undetected | Watchdog nudge, then escalation. |
| Requester waits forever | No waiting primitive | `reply_by` timeout produces `request.timed_out`. |
| Ownership transfer while messages queued | `migrateStaleCoordinationRuns` moves them | Inbox rows are rebound to the new agent thread; `seq` preserved. |
| Harness without mid-turn input | n/a (all five support it) | Items wait for the next turn boundary; correctness does not depend on injection. |

## 7. Phased migration plan

Each phase is shippable alone and keeps the component-library workflows (orchestrator → populator → reviewer through tasks, assignments and threads) running unchanged.

1. **Addressing and visibility (built, #46).** `resolveThreadRef` for every `threads/:ref` route; normalized `delivery` state on messages; `MESSAGE-n` in `show`; `threads status`; `delivery.failed` notices from an API sweeper with quiet settlements marked; prompt framing for notices; skill update. No behaviour change for existing sends.
2. **Inbox and leases (built, #48).** Bind deliveries to agent threads with `seq`; leases and heartbeat; restart redelivery with an interrupted preamble; recovery of stuck worker turns; ping turns that never change task status; `inbox`/`agents status`; `AISEVAK_COORDINATION_LEGACY` for one release. Deviations are in section 9.
3. **Requests, lifecycle and campaigns (built).** `send`/`reply`/`wait`, assignments as requests, `completion_policy`, tree authority, child-task events, re-parenting, task limits, schedule retargeting, conversation refresh. Decisions taken: agent-created tasks use `explicit` completion, and existing open component tasks are re-parented under the campaign task with `tasks reparent`. Section 10 has details and the campaign runbook.
4. **MCP and watchdog.** `aisevak mcp`, harness wiring, watchdog nudges/escalations/timeouts; update the `aisevak-cli` skill to prefer `send --expect-reply` + `wait`. The skill already says, as of phase 2, that follow-up pings are safe.
5. **Cleanup.** Lazily give every agent thread a coordination thread; UI shows `THREAD-n`. Move coordination prompt building into a shared package so the runner can drain an inbox itself (the wake step from 3.2), then remove the dispatcher-run-per-message path, its supersede/migrate machinery, `AISEVAK_COORDINATION_LEGACY`, and legacy routes.

## 8. Phase 1 details

* `resolveThreadRef(queryable, ref)` in `coordination.ts`; used by `threads show|messages|send|complete|block|status`. Unknown or malformed refs return 404/400 with a hint instead of a uuid cast error.
* `deliveryState(row)` maps raw delivery columns to `{ state, attempts, error, updatedAt }` on every message resource; `delivery_status` stays for compatibility.
* `GET /api/agent-tools/v1/threads/:ref/status` returns the thread, its task, and per participant `{ agent, role, state, agentThreadId, pendingMessages, currentTurn, waitingOn, blockedReason, lastFailedDelivery }` with precedence `running > queued > blocked > waiting > idle`.
* `notifyFailedDeliveries(pool, managedRoot)` claims up to 20 failed, un-notified deliveries (`FOR UPDATE SKIP LOCKED`), and for each one whose message has an agent sender other than the recipient and is not itself a `delivery.failed` notice, inserts a `delivery.failed` message (parent = the failed message) to the sender on the same thread and queues it. Every claimed row is marked notified, inside a savepoint so one bad row cannot wedge the sweep. The API process runs it every 5 s.
* `settleDeliveryByAssignment` (runner) and `cancelPendingAssignmentDelivery` (API) set `failure_notified_at` on the deliveries they fail, because those are not failures from the sender's point of view. Since phase 2, so do the three places that fail a delivery because its turn was cancelled.
* The notice body opens with "Platform notice (not new work, not a reply)…", and `coordinationPrompt` adds the same framing for cold sessions. The body carries it because warm sessions only receive the incremental prompt.

## 9. Phase 2 as built

What shipped, and where it deliberately differs from sections 3.2 and 3.6:

* **Inbox binding.** `queueDelivery` binds every delivery to its consuming agent thread (`message_deliveries.agent_thread_id`) and gives it `seq` from the global `message_delivery_inbox_seq`, which is monotonic per thread. `claimAgentTurnInput` takes inputs in `seq` order. Pending rows are backfilled from their input or run.
* **Wake step: kept the existing carrier rather than replacing it.** On reading the runner, the "one turn drains the inbox" behaviour already holds. `queueDelivery` folds every queued coordination run of an agent thread into one run, with the other messages attached as turn inputs, and injects into a running coordination turn; the claim queries keep one turn per agent thread. A separate runner wake step would also have to build the full coordination prompt, which only the API can do today (the runner does not depend on the API package). Removing the per-message dispatcher-run machinery therefore moves to phase 5, once prompt building lives in a shared package.
* **Turn leases.** Claims stamp `runner_id` (`AISEVAK_RUNNER_ID`, default the hostname, so it is stable across restarts) and `lease_expires_at` (60 s). Set `AISEVAK_RUNNER_ID` explicitly when several runner processes share a host.
  * A heartbeat renews the leases every 15 s, but only for the turns this process is actually executing. A row left `running` by a job that died inside the process therefore expires and is recovered.
  * At boot, a runner recovers its own previous turns, unleased legacy turns, and expired leases.
  * Every 30 s it sweeps other runners' turns whose lease expired more than 2 minutes ago. The grace period means a brief database or network blip on the owning runner does not cause a takeover.
  * Sweeps do not run the boot-only repairs of crash windows between a run's terminal update and its delivery's, because those windows are normal while runners are live.
  * Recovery re-checks the lease predicate under the row lock.
  * If a takeover does happen while the old runner is still alive:
    * its `shouldCancel` sees the run is no longer its own, and stops the provider turn;
    * its finalizers are fenced on `status IN ('running','cancel_requested') AND runner_id = me`, so it settles nothing the recovery already settled.
* **Worker turns are now recovered at all.** Before this change, a `task_runs` row left `running` by a stopped runner was never terminalized, and it blocked every later turn on its agent thread. `recoverInterruptedWorkerRuns` fails or cancels it. The task's status is left alone.
* **Interrupted redelivery.** A coordination turn that was launched or presented and then interrupted is queued again (`redeliverInterruptedRun`) instead of failing and blocking its assignment. A turn that never launched its prompt stays on the plain retry path and its attempt cap. For a redelivery:
  * the new run has trigger `redelivery`, keeps the same provider session, and its prompt starts with the interrupted note;
  * messages the turn had already presented move to the new run with the same note;
  * `interrupted_count` caps this at the task's `maxAssignmentAttempts` (default 3), after which the old fail, block and `delivery.failed` notice path applies;
  * the assignment stays `running` throughout.
* **UI pings: still worker turns, but conversational.** Section 3.2 proposed routing them through the coordination path. Doing that would run git-worktree tasks' pings in the project checkout instead of the task's worktree, because coordination turns use the agent thread's cwd. Instead, messages from the UI (task, run and agent-thread message routes) create worker runs with `trigger='message'`. They still inject into a running turn or wait for the next one, as before, and `finalizeWorkerRunState` never changes task or coordination status for them. Only the task's own runs and explicit commands do.
* **New read surface.** `aisevak inbox [--thread] [--recent]` (`GET /inbox`) and `aisevak agents status AGENT` (`GET /agents/:ref/status`).
* **Quiet cancellations.** A delivery that fails because its turn was cancelled on purpose is marked as needing no `delivery.failed` notice, so the sender is not invited to undo the stop. This covers a user Stop, archiving the chat, and the runner seeing its running turn's ownership move. Queued runs cancelled by the API's internal ownership changes (`cancelStaleQueuedAgentThreadRuns`, `linkTaskRunsToThread`) still notify the sender, because nothing else settles their assignment. The notice body itself now says it is a platform notice and not new work. This matters because warm sessions receive only the incremental prompt, not `coordinationPrompt`'s framing.
* **Legacy flag.** `AISEVAK_COORDINATION_LEGACY=1` restores the pre-v2 behaviour for one release: recover everything at boot, no lease sweeps, fail and block interrupted deliveries, and finalize ping turns like task runs. Worker turns left `running` are still recovered at boot, because that is a bug fix rather than a behaviour change.
* **Tests against Postgres.** `tests/coordinationV2.db.test.ts` runs the phase 1 and phase 2 SQL against a real database when `AISEVAK_TEST_DATABASE_URL` is set, and is skipped otherwise.
* **Deferred:** `consumed_at` (`completed` still means the carrying turn ended successfully), `wait`, and binding inbox items for deliveries that a phase 1 `delivery.failed` sweep cannot queue.

## 10. Phase 3 as built

Decisions taken with the user before building:
* Agent-created tasks use `explicit` completion.
* Existing open component tasks are re-parented under the campaign task, rather than relying on ancestor authority alone.

**Requests and replies.**
* `send --expect-reply` stores the message as a request:
  * `message_type='request'`, `expects_reply`, `request_state='open'`;
  * an optional `reply_by` from `--timeout`;
  * an optional `request_key`, unique per thread and sender, so a resend with the same key returns the first message.
* The recipient's prompt (cold or incremental) ends with the exact `aisevak reply MESSAGE-n` command.
* `reply`:
  * only the recipient may reply to a request;
  * the reply carries `in_reply_to_message_id`, closes the request, and is delivered to the requester.
* `wait` is a bounded long poll on the API: it checks once a second, holds no connection between checks, and waits at most 120 s per call. `inbox --wait` works the same way. It waits for a message that arrives after the call started, because the message that started the caller's own turn stays pending while that turn runs. Both the cutoff and the check use the database clock, and the check is a separate count, so a long pending list can't hide a new message. It reports how many arrived.
* `expireRequests` runs with the delivery-failure sweep every 5 s. It marks overdue requests `timed_out` and sends the requester a `request.timed_out` platform notice.

**Assignments as requests.** The `assignment.created` message is a keyed request (`assignment:<id>`), recorded as `task_assignments.request_message_id`.
* `assignments complete|block` replies to it and closes it. The result goes to the task owner, as before. It also goes to whoever sent the request (an ancestor task's owner, or the orchestrator) when that is someone else.
* `assignments retry` reopens the request. The generic `reply` refuses an assignment request and points to `assignments complete|block`, so an assignment can't be closed by accident.

**Task lifecycle.**
* `tasks.completion_policy`:
  * The web app's task form sets `on_first_success`, so a person's "run this task" still completes on the first successful standalone run. The #45 guard stays: never a child task, never one with assignments or open children.
  * Every other task, including agent-created and scheduled-occurrence tasks, is `explicit`. For those, `finalizeWorkerRunState` changes neither task nor thread status, whether the run succeeded or failed.
* The one-time backfill classifies existing tasks by `created_by`.
* `AISEVAK_COORDINATION_LEGACY=1` restores the old finalization.

**Authority by task tree.**
* `taskAuthority()` walks the parent chain, up to 32 levels, and returns `orchestrator`, `owner` or `ancestor`.
* An ancestor owner can, without holding `tasks:update` globally:
  * complete the task;
  * reopen it, with `tasks:update` or `tasks:create-child`;
  * update it;
  * create, retry and send on its assignments.
* Completing a task through ancestor authority goes through `finalizeThread` with the primary-agent check bypassed.
* `tasks policy` still needs `tasks:update`, so a worker can't raise its own fan-out limits. `maxChildDepth` is capped at 32, the depth the tree walks cover.

**Child events.**
* `notifyParentOfChildEvent` posts `child.<status>` (completed, blocked, reopened, or any status set by `tasks update`) on the parent task's thread, addressed to the parent's owner.
* Queueing the event is best-effort, inside a savepoint. An archived or restoring parent session never blocks the child's own status change, and the event row stays on the parent thread.
* When the child thread's callback agent is the parent's owner, and the parent has a thread, the old completion delivery on the child thread is skipped. The event on the parent thread replaces it, so the controller hears about it in its long-lived session instead of a per-child one.

**Campaigns.**
* No `schedules.thread_id` was added. A schedule with `task_id` already ticks a `schedule` message into that task's thread, with the `skip` overlap policy dropping a tick while one is still in flight. `schedules update --task` retargets an existing schedule.
* The runner now binds schedule ticks to the inbox like other deliveries (`agent_thread_id`, `seq`).
* `tasks reparent` moves a task and its subtree:
  * it needs authority over the task, its current parent, and the new parent. Owning a child alone isn't enough to move it out of its controller's tree;
  * it rejects cycles, and refuses when the new parent's chain is deeper than the 32-level walk;
  * it records a safety event when the depth limit would be exceeded, and enforce mode rejects the move;
  * it does not apply the fan-out limit, because it moves existing work.
* `threads refresh` sets `context_policy.maxTurns` or `refreshNow` on the caller's own session. `--now` leaves an existing period alone, and `everyTurns: null` clears it.
  * After a successful turn, `noteTurnForRefresh` counts the turn. When the policy says so and nothing is queued or running on the thread, it clears `provider_thread_id` (and `task_sessions.codex_thread_id`) and stamps `lastRefreshAt`.
  * The next delivery then gets the full coordination prompt. It now says the conversation is fresh and that the task tree and thread are the record.
  * The context-size trigger from 3.11 is deferred: providers don't report context size consistently yet.

**Campaign runbook (component library):**
1. `aisevak tasks create --title "Component Library campaign …" --work-key campaign-… --agent Orchestrator --description … --body …`
2. `aisevak tasks policy TASK-c --max-active-children 200` (as the Orchestrator).
3. `aisevak schedules update SCHEDULE-n --task TASK-c` for the 30-minute check.
4. `aisevak tasks reparent <open component tasks> --parent TASK-c`. This needs authority over the old parents. The Orchestrator has authority over every task.
5. Create new component tasks with `--parent-task TASK-c`.
6. Optionally, `aisevak threads refresh THREAD-c --every 40` from the Orchestrator's session on the campaign thread.

**Not done in phase 3, deferred to phase 4 or 5:**
* the MCP server;
* watchdog nudges and escalations;
* requeueing deliveries cancelled by internal ownership changes onto the new owner;
* the context-size refresh trigger;
* splitting `delivered` into consumed and replied for plain messages.

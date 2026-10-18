# Provider event normalization: gap analysis and proposal

Status: **approved 2026-10-17**, see "Decisions" at the end.

Scope: the code that turns each harness's raw stdout into what aisevak stores in
`run_events` / `dispatcher_run_events` and renders in the thread view. That is:
`normalizeCodexEvent` (`packages/core/src/codex.ts`), `normalizeAcpEvent`
(`packages/core/src/acp.ts`), `normalizeHarnessLine` (`apps/runner/src/harnessRuntime.ts`),
`persistCodexLine` / `persistDispatcherCodexLine` (`apps/runner/src/index.ts`), and
`deriveThreadBlocks` (`apps/web/src/threadBlocks.ts`), the only renderer. `agentRunTimeline.ts`'s
deriver has no callers.

Evidence: code reading, plus the 2,577 events in the local dev database (Codex, OpenCode and Cursor
runs), the Codex app-server v2 protocol (openai/codex `app-server-protocol`), ACP schema v1.26, and
t3code's `packages/contracts/src/providerRuntime.ts`.

---

## 1. How it works today

```
provider stdout line ─▶ parseCodexJsonLine ─▶ normalizeCodexEvent | normalizeAcpEvent
                                              ─▶ {type, text, threadId, itemId, status, usage, raw}
                                              ─▶ INSERT run_events(event_type=type, text, payload=<that object>)
web: deriveThreadBlocks reads event_type + payload.raw.params.item.{id,type,...}
```

- For **Codex**, `type` is the JSON-RPC method and `raw` is the original message. The UI therefore
  reads Codex wire shapes directly.
- For **ACP** (Cursor, OpenCode, Devin, Claude Code), the normalizer **replaces `raw` with a
  fabricated Codex-shaped message** so the Codex-oriented UI can render it. In effect, the "common
  model" is the Codex wire format.

## 2. Gaps

### A. The model itself
1. **There is no common model.** `event_type` holds Codex method names for Codex, made-up Codex
   method names for ACP, and raw ACP `sessionUpdate` kinds (`usage_update`, `plan`,
   `available_commands_update`, …) for everything else. You cannot write one query or UI branch
   across providers.
2. **The original ACP payload is thrown away.** `raw` is rewritten, so ACP `kind`, `locations`,
   `content[type=diff]`, `rawOutput`, `messageId` and `_meta` are lost. The only copy left is the
   run's `raw_stdout` blob.
3. **Codex internals leak into the UI.** `threadBlocks.ts` digs through
   `payload.raw.params.item.aggregatedOutput`, `exit_code`/`exitCode`, `summary[]`, `content[]`,
   `changes[].diff`, and so on. Every new provider field means another UI special case.
4. **Thread-id extraction exists in three places** (`extractThreadId` in core, a copy in
   `appServerClient.ts`, and `extractAcpSessionId`), each with different fallbacks.

### B. Dropped or misclassified events

| # | Provider | What happens | Effect |
|---|---|---|---|
| 5 | ACP | Every `tool_call` becomes `command_execution`; `title` is used as the "command" | File edits, reads, searches and fetches all render as shell commands |
| 6 | ACP | `acpToolStatus` maps ACP's `in_progress` (and a missing status on `tool_call_update`) to `completed` | Running tools show as finished. **Bug** |
| 7 | ACP | `content[{type:"diff", path, oldText, newText}]` is ignored | Claude Code / Cursor edits show no diff |
| 8 | ACP | Assistant and reasoning chunks all get itemId `"assistant"` / `"reasoning"` | Separate messages in one run (before and after a tool call) merge into a single block |
| 9 | ACP | JSON-RPC **error responses** are stored as `unknown` (seen in DB: Cursor `session/new` → "Failed to initialize session services") | Provider failures are invisible in the thread |
| 10 | ACP | The `session/prompt` result `{stopReason, usage}` is stored as `unknown` | `refusal`, `max_tokens`, `max_turn_requests` and `cancelled` look like normal completions; usage is lost |
| 11 | ACP | `usage_update`, `notice`, `session_info_update`, `current_mode_update`, `compaction_update` pass through raw and are dropped by the UI | Context gauge, warnings and compaction are invisible |
| 12 | Codex | `turn/plan/updated` isn't recognized by the UI (it only matches `plan` / `turn_plan_updated` / `itemType=plan`) | **Codex todo plans never render** |
| 13 | Codex | `item/reasoning/summaryTextDelta` / `textDelta` carry no `item`, so the UI drops them | Codex reasoning doesn't stream; it only appears on `item/completed` |
| 14 | Codex | `item/commandExecution/outputDelta` / `item/fileChange/outputDelta` are dropped (no item type) | No live command output; only the final `aggregatedOutput` |
| 15 | Codex | `turn/diff/updated` is dropped | No turn-level diff |
| 16 | Codex | `error` (with `willRetry`, `codexErrorInfo`) and `warning` are dropped by the UI | Rate limits, context overflow and retries are silent until the turn fails |
| 17 | Codex | `mcpToolCall` / `dynamicToolCall` / `webSearch` titles come from `title`/`command`, which these items don't have | They render as untitled tool rows |
| 18 | both | JSON-RPC responses (`initialize`, `thread/start`, `session/new`, `set_model`) are stored as `unknown` (106 rows in the dev DB) | Noise; no way to tell them apart from real unknowns |

### C. Lifecycle and accounting
19. **Turns don't line up.** Codex has `turn/started`/`turn/completed` with ids, but the normalized
    event drops `turnId`. ACP has no turn events at all, so the UI closes ACP streaming blocks only
    when the run stops.
20. **Usage is never captured.** `normalizeCodexEvent` reads `params.usage`, but Codex sends
    `params.tokenUsage`, so `usage` is always empty. ACP usage arrives in two other shapes. Nothing
    renders usage.
21. **Errors and cancellation have four representations:** runner-inserted `turn.failed`, Codex
    `turn/completed{turn.status:"failed"|"interrupted"}`, Codex `error`, and ACP stopReason (dropped).
    The UI only knows the first two.
22. **Replay is ad hoc.** `aisevakReplay` is spliced into the raw line and copied into the fake raw.
    It works, but it should be an envelope field.

## 3. Proposal: `RuntimeEvent` v2

A small canonical event union modeled on t3code's `ProviderRuntimeEvent`, trimmed to what aisevak
uses. Provider adapters produce it; the UI reads only it.

### Envelope (stored as `payload`; `event_type` = `type`)
```ts
interface RuntimeEvent {
  v: 2;
  type: RuntimeEventType;
  provider: ProviderDriver;           // codex | cursor | opencode | devin | claude
  threadId?: string;                  // provider thread / ACP session id
  turnId?: string;                    // Codex turn id; ACP: synthesized per prompt
  itemId?: string;                    // stable within a turn
  replay?: true;                      // emitted while reloading a session
  text?: string;                      // also copied to the `text` column
  // exactly one of these, by type:
  item?: ItemPayload; delta?: DeltaPayload; turn?: TurnPayload; plan?: PlanPayload;
  diff?: { unifiedDiff: string }; usage?: UsageSnapshot; error?: ErrorPayload;
  notice?: { level: "info" | "warning" | "error"; message: string; detail?: string };
  raw: { source: "codex.app-server" | "acp.jsonrpc" | "aisevak"; method?: string; payload: unknown };
}
```
`raw.payload` is always the **unmodified** provider message, so nothing is lost and the UI never
needs to read it.

### Event types
| type | payload | Codex source | ACP source |
|---|---|---|---|
| `session.configured` | `raw` only | `initialize`/`thread/start` responses, `thread/settings/updated`, mcp/account/remote-control noise | `initialize`/`session/new`/`set_*` responses, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update` |
| `thread.started` | — | `thread/started` | `session/new`/`session/load` result |
| `turn.started` | `turn{}` | `turn/started` | — (implicit; `turnId` is still stamped) |
| `turn.completed` | `turn{state: completed\|failed\|interrupted\|cancelled, stopReason?, errorMessage?, errorCode?, durationMs?}` | `turn/completed` | `session/prompt` result (`end_turn`→completed, `cancelled`→cancelled, `refusal`/`max_tokens`/`max_turn_requests`→failed with stopReason) |
| `item.started` / `item.updated` / `item.completed` | `item{itemType, status, title?, detail?, command?, exitCode?, output?, changes?: [{path, kind, diff}], toolName?, input?}` | `item/started`, `item/completed`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress` | `tool_call`, `tool_call_update` (status in_progress→updated, completed/failed→completed) |
| `content.delta` | `delta{stream: assistant\|reasoning\|reasoning_summary\|command_output\|file_change_output\|plan, text}` | `item/agentMessage/delta`, `item/reasoning/*Delta`, `item/*/outputDelta`, `item/plan/delta` | `agent_message_chunk`, `agent_thought_chunk` |
| `turn.plan.updated` | `plan{explanation?, entries:[{step, status: pending\|in_progress\|completed}]}` | `turn/plan/updated` | `plan` |
| `turn.diff.updated` | `diff{unifiedDiff}` | `turn/diff/updated` | — |
| `usage.updated` | `usage{usedTokens?, maxTokens?, inputTokens?, cachedInputTokens?, outputTokens?, reasoningTokens?, totalTokens?, costUsd?, scope: "context"\|"turn"}` | `thread/tokenUsage/updated` | `usage_update` (context) and the prompt result's `usage` (turn; emitted inside `turn.completed`) |
| `request.opened` | `item`-like `{requestType, title}` | approval requests (auto-approved) | `session/request_permission` (auto-approved) |
| `runtime.warning` | `notice` | `warning`, `configWarning`, `error{willRetry:true}` | `notice{severity: warning}` |
| `runtime.error` | `error{message, code?, class?}` | `error{willRetry:false}` | JSON-RPC error responses, `notice{severity: error}` |
| `user.message` | `text` | `item/*` `userMessage` (dropped from UI; aisevak already records the prompt) | `user_message_chunk` (replay) |
| `parse.error` | `text` | malformed line | malformed line |
| `provider.event` | `raw` only | anything unmapped | anything unmapped |

Canonical `itemType`: `assistant_message | reasoning | command_execution | file_change |
file_read | search | web_fetch | mcp_tool_call | dynamic_tool_call | subagent | web_search |
image_view | context_compaction | other`. ACP `kind` mapping: execute→command_execution;
edit/delete/move→file_change (with diffs from `content[type=diff]`); read→file_read;
search→search; fetch→web_fetch; think→reasoning; other→`dynamic_tool_call`, using Claude Code's
`_meta.claudeCode.toolName` when present (`Task`/`Agent` → subagent, `TodoWrite` → also emits a plan).

Aisevak-inserted rows (`thread.message-sent`, `task.comment`, and the runner's `turn.failed`) keep
their current types. `turn.failed` is treated as `turn.completed{state:"failed"}`.

### Adapters
- `packages/core/src/runtime/events.ts`: types and small helpers. Pure TypeScript with no Node
  imports, so the web can import it.
- `packages/core/src/runtime/codexAdapter.ts`: a pure function, one Codex message → one
  `RuntimeEvent`.
- `packages/core/src/runtime/acpAdapter.ts`: `createAcpAdapter({provider, sessionId})` with
  `.normalize(line)`. It is **stateful per run** because ACP has no turn or message ids:
  - It synthesizes `turnId`: a counter that bumps after each prompt result.
  - It synthesizes assistant/reasoning `itemId`s: `t{n}:assistant:{k}`, where `k` bumps whenever
    a tool call or plan interrupts the text stream; it uses ACP `messageId` when the harness sends one.
  - It remembers each tool call's `kind`/`title`/`toolName` so partial `tool_call_update`s stay
    classified.
  - Per-provider quirks (Claude Code `_meta`, OpenCode usage on the prompt result, Cursor/Devin
    error shapes) are small hooks inside it, not separate modules.
- `normalizeHarnessLine(driver, line)` is replaced by `createRuntimeNormalizer(driver, sessionId)`,
  created once per turn in the runner. `persistCodexLine` takes the resulting event. **One input
  line produces at most one stored row**, so seq handling and the delivery and acpClient logic are
  unchanged.
- `normalizeAcpEvent` / `normalizeCodexEvent` / `NormalizedCodexEvent` are removed (no legacy rows
  are rendered, so nothing needs the old shape).

### Old rows
Events already in the database (`payload` without `v: 2`) go through an
`upgradeLegacyEvent(row) → RuntimeEvent` shim. The shim reuses the Codex adapter for Codex rows and
reads the fabricated Codex shape for old ACP rows. The UI has a single code path, and existing
threads keep rendering. There is no data migration.

### UI (`threadBlocks.ts`)
`deriveThreadBlocks` is rewritten to switch on `RuntimeEvent.type`. Blocks keep their existing
`kind`s, so `chat-timeline.tsx` barely changes. New things that become visible:
- live command output
- streamed Codex reasoning
- Codex plans
- file diffs from ACP and Codex (the existing `FileDiff`)
- correctly typed tool rows with titles for mcp, web-search and read tools
- warnings and provider errors, as `system` / `error` blocks
- refusal / max-tokens / cancelled turn endings
- a small per-turn usage line (tokens and context %) under the turn

The dead `agentRunTimeline.ts` deriver is removed; `formatElapsed` and the types are kept.

### Tests
- `packages/core/src/runtime/fixtures/<provider>/*.jsonl` holds captured raw lines, trimmed and with
  content anonymized. Codex, OpenCode and Cursor fixtures are taken from real runs in the dev DB;
  Claude Code and Devin fixtures are taken from the ACP schema and the harness `_meta` shapes,
  because those binaries aren't installed here.
- Next to each fixture, `*.expected.json` holds the normalized events, compared by one table-driven
  vitest.
- A second test per fixture (`tests/threadTimeline.test.ts`) feeds the events through
  `deriveThreadBlocks` and snapshots the blocks in `tests/__fixtures__/`.
- The legacy-row shim gets fixtures taken from current dev-DB payloads.

### Order of work (one PR, small commits)
1. Event types plus the Codex adapter, with fixtures.
2. The ACP adapter, with fixtures for each harness.
3. Runner wiring: a normalizer per turn, persisting the v2 payload.
4. The legacy shim, the UI rewrite, block snapshot tests, and removal of the dead deriver.

### Out of scope
Changing the delivery or turn-control logic in `acpClient.ts` / `appServerClient.ts`; API endpoints
(they pass rows through unchanged); a separate raw-event log table (`raw.payload` covers it for now);
interactive approvals (aisevak auto-approves).

### Decisions (signed off 2026-10-17)
1. **No legacy shim.** Only v2 payloads are rendered. Rows written before this change are not
   converted and may render degraded or not at all. That was accepted, so the "Old rows" section
   above is void.
2. **One row per input line.** ACP turn starts are implicit: events carry a synthesized `turnId`,
   and the prompt result closes the turn.
3. **The web app depends on `@aisevak/core`** and imports only the pure `runtime/events` module.
4. **UI additions, all built from aicss.dev components** (vendored like the existing ones): live tool
   output (aicss CodeBlock), streamed reasoning (ThinkingReasoning), diffs and plans (FileDiff,
   TaskList), errors and warnings, and per-turn token usage.

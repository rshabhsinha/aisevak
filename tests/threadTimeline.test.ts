import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeNormalizer } from "../packages/core/src/runtime/normalizer.js";
import type { RuntimeProvider } from "../packages/core/src/runtime/events.js";
import { deriveThreadBlocks, splitUnifiedDiff, type ThreadBlock, type ThreadEvent } from "../apps/web/src/threadBlocks.js";

let idCounter = 0;

/** Run raw provider lines through the real normalizer, as the runner does. */
function providerEvents(
  provider: RuntimeProvider,
  lines: unknown[],
  opts: { runId?: string; createdAt?: (index: number) => string; startSeq?: number } = {}
): ThreadEvent[] {
  const normalizer = createRuntimeNormalizer(provider);
  return lines.flatMap((line, index) => {
    const event = normalizer.normalize(typeof line === "string" ? line : JSON.stringify(line));
    if (!event) return [];
    idCounter += 1;
    return [
      {
        id: `e${idCounter}`,
        seq: (opts.startSeq ?? 0) + index,
        event_type: event.type,
        text: event.text ?? null,
        payload: event,
        created_at: opts.createdAt?.(index) ?? `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
        run_id: opts.runId ?? "run-1"
      }
    ];
  });
}

function aisevakEvent(eventType: string, payload: Record<string, unknown>, opts: { seq?: number; createdAt?: string; runId?: string } = {}): ThreadEvent {
  idCounter += 1;
  return {
    id: `a${idCounter}`,
    seq: opts.seq ?? -1,
    event_type: eventType,
    text: typeof payload.text === "string" ? payload.text : null,
    payload: { type: eventType, ...payload },
    created_at: opts.createdAt ?? "2026-01-01T00:00:00Z",
    run_id: opts.runId ?? "run-1"
  };
}

const update = (sessionUpdate: string, fields: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "ses_1", update: { sessionUpdate, ...fields } }
});
const chunk = (text: string) => update("agent_message_chunk", { content: { type: "text", text } });
const thought = (text: string) => update("agent_thought_chunk", { content: { type: "text", text } });
const codex = (method: string, params: Record<string, unknown>) => ({ method, params: { threadId: "thr", turnId: "t1", ...params } });

const kinds = (blocks: ThreadBlock[]) => blocks.map((block) => block.kind);
/** The blocks inside turns, without the per-turn endings. */
const steps = (blocks: ThreadBlock[]) => blocks.filter((block) => block.kind !== "turn-end");

describe("deriveThreadBlocks", () => {
  it("orders streamed deltas by seq even when created_at is not monotonic", () => {
    const events = providerEvents(
      "codex",
      [
        codex("item/agentMessage/delta", { itemId: "m", delta: "Hello" }),
        codex("item/agentMessage/delta", { itemId: "m", delta: " world" })
      ],
      { createdAt: (index) => (index === 0 ? "2026-01-01T00:00:09Z" : "2026-01-01T00:00:01Z") }
    );
    expect(steps(deriveThreadBlocks({ run: null, events: events.reverse() }))).toMatchObject([{ kind: "assistant", text: "Hello world" }]);
  });

  it("uses the run prompt only when no user message event exists", () => {
    const run = { id: "run-1", status: "succeeded", prompt: "Do it" };
    expect(deriveThreadBlocks({ run, events: [] })).toMatchObject([{ kind: "user", text: "Do it" }]);
    expect(
      deriveThreadBlocks({ run, events: [aisevakEvent("thread.message-sent", { role: "user", text: "Typed" })] })
    ).toMatchObject([{ kind: "user", text: "Typed" }]);
  });

  it("splits ACP assistant text around a tool call into two messages", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("claude", [
        chunk("Checking."),
        update("tool_call", { toolCallId: "t1", title: "ls", kind: "execute", status: "completed" }),
        chunk("Done.")
      ])
    });
    expect(steps(blocks)).toMatchObject([
      { kind: "assistant", text: "Checking.", streaming: false },
      { kind: "tools", entries: [{ title: "ls", status: "completed", icon: "terminal" }] },
      { kind: "assistant", text: "Done." }
    ]);
  });

  it("keeps an in-progress ACP tool running until it completes", () => {
    const lines = [
      update("tool_call", { toolCallId: "t1", title: "Run tests", kind: "execute", status: "pending" }),
      update("tool_call_update", { toolCallId: "t1", status: "in_progress" })
    ];
    const running = deriveThreadBlocks({ run: null, events: providerEvents("opencode", lines) });
    expect(steps(running)).toMatchObject([{ kind: "tools", entries: [{ status: "running" }] }]);
    const done = deriveThreadBlocks({
      run: null,
      events: providerEvents("opencode", [...lines, update("tool_call_update", { toolCallId: "t1", status: "failed" })])
    });
    expect(steps(done)).toMatchObject([{ kind: "tools", entries: [{ status: "failed" }] }]);
  });

  it("streams Codex command output, then keeps the final aggregated output and exit code", () => {
    const started = codex("item/started", { item: { id: "c1", type: "commandExecution", command: "pnpm test", status: "inProgress" } });
    const delta = codex("item/commandExecution/outputDelta", { itemId: "c1", delta: "running…\n" });
    const live = deriveThreadBlocks({ run: null, events: providerEvents("codex", [started, delta]) });
    expect(steps(live)).toMatchObject([{ kind: "tools", entries: [{ status: "running", output: "running…\n", command: "pnpm test" }] }]);
    const completed = codex("item/completed", {
      item: { id: "c1", type: "commandExecution", command: "pnpm test", status: "completed", exitCode: 2, aggregatedOutput: "FAIL\n" }
    });
    const done = deriveThreadBlocks({ run: null, events: providerEvents("codex", [started, delta, completed]) });
    expect(steps(done)).toMatchObject([{ kind: "tools", entries: [{ status: "failed", output: "FAIL\n", exitCode: 2 }] }]);
  });

  it("streams Codex reasoning summaries and renders Codex plans", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("codex", [
        codex("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Step " }),
        codex("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "one" }),
        codex("turn/plan/updated", { plan: [{ step: "A", status: "completed" }, { step: "B", status: "inProgress" }] })
      ])
    });
    expect(steps(blocks)).toMatchObject([
      { kind: "thinking", text: "Step one" },
      { kind: "plan", items: [{ title: "A", status: "completed" }, { title: "B", status: "running" }] }
    ]);
  });

  it("shows file diffs for Codex hunks and ACP old/new text", () => {
    const codexBlocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("codex", [
        codex("item/completed", { item: { id: "f1", type: "fileChange", status: "completed", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-x\n+y\n" }] } })
      ])
    });
    expect(steps(codexBlocks)).toMatchObject([
      { kind: "tools", entries: [{ icon: "edit", diffs: [{ path: "a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n" }] }] }
    ]);
    const acpBlocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("claude", [
        update("tool_call", { toolCallId: "e1", title: "Edit `a.ts`", kind: "edit", status: "completed", content: [{ type: "diff", path: "a.ts", oldText: "x\n", newText: "y\n" }] })
      ])
    });
    expect(steps(acpBlocks)).toMatchObject([
      { kind: "tools", entries: [{ title: "Edit a.ts", diffs: [{ path: "a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y" }] }] }
    ]);
  });

  it("reports provider errors, refusals and cancellations", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("cursor", [
        { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "Internal error", data: { message: "Failed to initialize session services" } } },
        { jsonrpc: "2.0", id: 4, result: { stopReason: "refusal" } },
        { jsonrpc: "2.0", id: 5, result: { stopReason: "cancelled" } }
      ])
    });
    // The refusal closes the turn; the later cancellation produced nothing new,
    // so it folds into that ending and the more serious state wins.
    expect(blocks).toMatchObject([
      { kind: "error", label: "Provider error", detail: "Failed to initialize session services" },
      { kind: "turn-end", state: "failed", detail: "The model refused to continue" }
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("renders runner-inserted turn failures", () => {
    expect(deriveThreadBlocks({ run: null, events: [aisevakEvent("turn.failed", { text: "Ownership changed" }, { seq: 4 })] })).toMatchObject([
      { kind: "turn-end", state: "failed", detail: "Ownership changed" }
    ]);
  });

  it("folds a runner failure into the provider's own failed ending", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        ...providerEvents("codex", [
          codex("error", { error: { message: "Context window exceeded" }, willRetry: false }),
          codex("turn/completed", { turn: { id: "t1", status: "failed", error: { message: "Context window exceeded" } } })
        ]),
        aisevakEvent("turn.failed", { text: "Run failed" }, { seq: 9, createdAt: "2026-01-01T00:00:05Z" })
      ]
    });
    expect(kinds(blocks)).toEqual(["turn-end"]);
    expect(blocks[0]).toMatchObject({ state: "failed", detail: "Run failed" });
  });

  it("shows retryable errors as warnings, not failures", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("codex", [codex("error", { error: { message: "Rate limited", codexErrorInfo: "rateLimitExceeded" }, willRetry: true })])
    });
    expect(steps(blocks)).toMatchObject([{ kind: "notice", level: "warning", text: "Rate limited", detail: "rateLimitExceeded" }]);
  });

  it("folds output after a turn's completion into that ending instead of adding an empty turn", () => {
    const blocks = deriveThreadBlocks({
      run: { id: "run-1", status: "succeeded" },
      events: providerEvents("codex", [
        codex("item/completed", { item: { id: "m", type: "agentMessage", text: "Done." } }),
        codex("turn/completed", { turn: { id: "t1", status: "completed" } }),
        codex("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } }),
        codex("turn/completed", { turn: { id: "t1", status: "interrupted" } }),
        { method: "some/unknown/notification", params: {} }
      ])
    });
    expect(kinds(blocks)).toEqual(["assistant", "turn-end"]);
    expect(blocks[1]).toMatchObject({ state: "interrupted" });
  });

  it("keeps the live turn open when a steering message is pending", () => {
    const blocks = deriveThreadBlocks({
      run: { id: "run-1", status: "running", started_at: "2026-01-01T00:00:00Z" },
      events: providerEvents("codex", [codex("item/started", { item: { id: "c1", type: "commandExecution", command: "pnpm test", status: "inProgress" } })]),
      pendingMessages: [{ id: "p1", text: "also lint", createdAt: "2026-01-01T00:00:05Z" }]
    });
    expect(kinds(blocks)).toEqual(["tools", "user", "working"]);
  });

  it("summarizes usage on the turn's ending", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("opencode", [
        chunk("pong"),
        update("usage_update", { used: 50_000, size: 200_000 }),
        { jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn", usage: { inputTokens: 6675, outputTokens: 21 } } }
      ])
    });
    expect(blocks).toMatchObject([
      { kind: "assistant", text: "pong", streaming: false },
      { kind: "turn-end", state: "completed", usage: { contextUsedTokens: 50_000, contextMaxTokens: 200_000, inputTokens: 6675, outputTokens: 21 } }
    ]);
  });

  it("drops configuration noise, replayed history and pre-v2 rows", () => {
    const replay = { ...chunk("old reply"), aisevakReplay: true };
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        ...providerEvents("opencode", [
          { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
          update("available_commands_update", { availableCommands: [] }),
          replay,
          chunk("new reply")
        ]),
        { id: "legacy", seq: 99, event_type: "item/agentMessage/delta", text: "legacy", payload: { type: "item/agentMessage/delta", raw: {} }, run_id: "run-1" }
      ]
    });
    expect(steps(blocks)).toMatchObject([{ kind: "assistant", text: "new reply" }]);
    expect(steps(blocks)).toHaveLength(1);
  });

  it("keeps each run's messages separate even when ACP item ids repeat", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        ...providerEvents("devin", [chunk("first")], { runId: "run-a", createdAt: () => "2026-01-01T00:00:01Z" }),
        ...providerEvents("devin", [chunk("second")], { runId: "run-b", createdAt: () => "2026-01-01T00:00:05Z" })
      ]
    });
    expect(steps(blocks)).toMatchObject([
      { kind: "assistant", text: "first" },
      { kind: "assistant", text: "second" }
    ]);
  });

  it("keeps each burst of reasoning in its own thinking block", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: providerEvents("opencode", [thought("First"), thought(" thought"), update("tool_call", { toolCallId: "t", title: "x", kind: "read", status: "completed" }), thought("Second")])
    });
    expect(steps(blocks)).toMatchObject([
      { kind: "thinking", text: "First thought", streaming: false },
      { kind: "tools", entries: [{ icon: "read" }] },
      { kind: "thinking", text: "Second" }
    ]);
  });

  it("appends a working row while the run is active and keeps streaming open", () => {
    const blocks = deriveThreadBlocks({
      run: { id: "run-1", status: "running", started_at: "2026-01-01T00:00:00Z" },
      events: providerEvents("claude", [chunk("Thinking out loud")])
    });
    expect(kinds(blocks)).toEqual(["assistant", "working"]);
    expect(blocks[0]).toMatchObject({ streaming: true });
  });

  it("places steering messages after earlier output in submission order", () => {
    const steer = (text: string, createdAt: string) => aisevakEvent("thread.message-sent", { role: "user", text, steer: true }, { seq: 0, createdAt });
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        ...providerEvents("codex", [codex("item/agentMessage/delta", { itemId: "m", delta: "earlier" })], { startSeq: 1, createdAt: () => "2026-01-01T00:00:01Z" }),
        steer("first steer", "2026-01-01T00:00:02Z"),
        steer("second steer", "2026-01-01T00:00:03Z")
      ]
    });
    expect(steps(blocks)).toMatchObject([
      { kind: "assistant", text: "earlier" },
      { kind: "user", text: "first steer" },
      { kind: "user", text: "second steer" }
    ]);
  });

  it("splits a multi-file turn diff", () => {
    expect(splitUnifiedDiff("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n")).toEqual([
      { path: "x", diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" },
      { path: "y", diff: "--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d" }
    ]);
  });
});

// Every provider fixture rendered end to end: raw lines → normalizer → blocks.
describe("provider fixtures render", () => {
  const fixturesDir = join(import.meta.dirname, "../packages/core/src/runtime/fixtures");
  const names = readdirSync(fixturesDir).filter((file) => file.endsWith(".jsonl")).map((file) => file.replace(/\.jsonl$/, ""));

  it.each(names)("%s", async (name) => {
    const lines = readFileSync(join(fixturesDir, `${name}.jsonl`), "utf8").split("\n").filter((line) => line.trim());
    const blocks = deriveThreadBlocks({ run: null, events: providerEvents(name.split("-")[0] as RuntimeProvider, lines) });
    // Block ids embed counters; snapshot the content.
    const content = blocks.map(({ id: _id, createdAt: _createdAt, ...block }) =>
      block.kind === "tools" ? { ...block, entries: block.entries.map(({ createdAt: _entryCreatedAt, outputEventId: _outputEventId, ...entry }) => entry) } : block
    );
    await expect(`${JSON.stringify(content, null, 2)}\n`).toMatchFileSnapshot(`./__fixtures__/${name}.blocks.json`);
  });
});

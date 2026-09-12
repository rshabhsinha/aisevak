import { describe, expect, it } from "vitest";
import { deriveThreadBlocks, type ThreadBlock, type ThreadEvent } from "./threadBlocks";

let seqCounter = 0;
function event(
  eventType: string,
  opts: { text?: string; payload?: unknown; createdAt?: string; seq?: number } = {}
): ThreadEvent {
  seqCounter += 1;
  return {
    id: `e${opts.seq ?? seqCounter}`,
    seq: opts.seq ?? seqCounter,
    event_type: eventType,
    text: opts.text ?? null,
    payload: opts.payload ?? null,
    created_at: opts.createdAt
  };
}

function acpDelta(text: string, opts: { seq?: number; createdAt?: string; itemId?: string } = {}) {
  return event("item/agentMessage/delta", {
    text,
    seq: opts.seq,
    createdAt: opts.createdAt,
    payload: {
      raw: {
        method: "item/agentMessage/delta",
        params: { item: { id: opts.itemId ?? "assistant", type: "agentMessage", text }, delta: text }
      }
    }
  });
}

function acpCompletedItem(
  text: string,
  itemType: string,
  opts: { seq?: number; createdAt?: string; itemId?: string } = {}
) {
  return event("item/completed", {
    text,
    seq: opts.seq,
    createdAt: opts.createdAt,
    payload: {
      raw: {
        method: "item/completed",
        params: { item: { id: opts.itemId ?? "item-1", type: itemType, text } }
      }
    }
  });
}

function blockKinds(blocks: ThreadBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

function assistantTexts(blocks: ThreadBlock[]): string[] {
  return blocks
    .filter((block): block is Extract<ThreadBlock, { kind: "assistant" }> => block.kind === "assistant")
    .map((block) => block.text);
}

describe("deriveThreadBlocks", () => {
  it("orders streamed deltas by seq even when created_at is not monotonic", () => {
    // Regression: Devin deltas persisted by async batches get out-of-order
    // created_at values; sorting by them scrambled the rendered message.
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        acpDelta("I'm", { seq: 1, createdAt: "2026-01-01T00:00:00.335Z" }),
        acpDelta(" powered", { seq: 2, createdAt: "2026-01-01T00:00:00.336Z" }),
        acpDelta(" by", { seq: 3, createdAt: "2026-01-01T00:00:00.343Z" }),
        acpDelta(" **", { seq: 4, createdAt: "2026-01-01T00:00:00.387Z" }),
        acpDelta("SW", { seq: 5, createdAt: "2026-01-01T00:00:00.379Z" }),
        acpDelta("E", { seq: 6, createdAt: "2026-01-01T00:00:00.401Z" }),
        acpDelta("-", { seq: 7, createdAt: "2026-01-01T00:00:00.398Z" }),
        acpDelta("2", { seq: 8, createdAt: "2026-01-01T00:00:00.379Z" }),
        acpDelta(" Medium", { seq: 9, createdAt: "2026-01-01T00:00:00.347Z" }),
        acpDelta("**", { seq: 10, createdAt: "2026-01-01T00:00:00.351Z" })
      ]
    });
    expect(assistantTexts(blocks)).toEqual(["I'm powered by **SWE-2 Medium**"]);
  });

  it("renders a codex turn: prompt fallback, thinking, tools, message", () => {
    const blocks = deriveThreadBlocks({
      run: { id: "r1", status: "succeeded", prompt: "fix the bug", queued_at: "2026-01-01T00:00:00Z" },
      events: [
        acpCompletedItem("Investigating the failure", "reasoning", { itemId: "r-1" }),
        event("item/completed", {
          payload: {
            raw: {
              method: "item/completed",
              params: {
                item: {
                  id: "cmd-1",
                  type: "command_execution",
                  command: "pnpm test",
                  status: "completed",
                  exit_code: 0,
                  aggregated_output: "all green"
                }
              }
            }
          }
        }),
        acpCompletedItem("Fixed the bug.", "agent_message", { itemId: "msg-1" }),
        event("turn/completed", { payload: { raw: { params: { turn: { status: "completed" } } } } })
      ]
    });
    expect(blockKinds(blocks)).toEqual(["user", "thinking", "tools", "assistant"]);
    const tools = blocks.find((b) => b.kind === "tools");
    expect(tools && tools.kind === "tools" ? tools.entries[0]?.command : null).toBe("pnpm test");
    expect(assistantTexts(blocks)).toEqual(["Fixed the bug."]);
  });

  it("keeps user message events instead of the prompt fallback", () => {
    const blocks = deriveThreadBlocks({
      run: { id: "r1", status: "succeeded", prompt: "hi" },
      events: [
        event("thread.message-sent", { text: "hi", seq: -1 }),
        acpDelta("hello", { seq: 2 })
      ]
    });
    expect(blocks[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(blocks.filter((b) => b.kind === "user")).toHaveLength(1);
  });

  it("groups contiguous ACP tool calls into one tools block", () => {
    const toolCall = (id: string, title: string, status: string) =>
      event(status === "completed" ? "item/completed" : "item/started", {
        text: title,
        payload: {
          raw: {
            method: "item/completed",
            params: {
              item: {
                id,
                type: "command_execution",
                command: title,
                status,
                aggregated_output: "ok"
              }
            }
          }
        }
      });
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        toolCall("t1", "ls -la", "in_progress"),
        toolCall("t1", "ls -la", "completed"),
        toolCall("t2", "cat a.ts", "completed")
      ]
    });
    expect(blockKinds(blocks)).toEqual(["tools"]);
    const tools = blocks[0] as Extract<ThreadBlock, { kind: "tools" }>;
    expect(tools.entries.map((entry) => entry.id)).toEqual(["t1", "t2"]);
  });

  it("maps ACP plan updates to a single plan block", () => {
    const plan = (entries: unknown) =>
      event("plan", {
        payload: {
          raw: { method: "session/update", params: { update: { sessionUpdate: "plan", entries } } }
        }
      });
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        plan([{ content: "step one", status: "pending" }]),
        plan([
          { content: "step one", status: "completed" },
          { content: "step two", status: "in_progress" }
        ])
      ]
    });
    expect(blockKinds(blocks)).toEqual(["plan"]);
    const planBlock = blocks[0] as Extract<ThreadBlock, { kind: "plan" }>;
    expect(planBlock.items.map((item) => item.status)).toEqual([
      "completed",
      "running"
    ]);
  });

  it("marks assistant text non-streaming on turn completion and appends working row while active", () => {
    const active = deriveThreadBlocks({
      run: { id: "r1", status: "running", started_at: "2026-01-01T00:00:00Z" },
      events: [acpDelta("typing")]
    });
    expect(active[active.length - 1]?.kind).toBe("working");
    const done = deriveThreadBlocks({
      run: { id: "r1", status: "succeeded", started_at: "2026-01-01T00:00:00Z" },
      events: [
        acpDelta("final"),
        event("turn/completed", { payload: { raw: { params: { turn: { status: "completed" } } } } })
      ]
    });
    const msg = done.find((b) => b.kind === "assistant");
    expect(msg && msg.kind === "assistant" ? msg.streaming : true).toBe(false);
    expect(done.some((b) => b.kind === "working")).toBe(false);
  });

  it("separates each run's deltas into its own assistant message", () => {
    // Regression: a thread merges events from multiple runs; seq/itemId are
    // only unique per run, so Devin turns (all itemId="assistant") interleaved
    // into one scrambled message, and user messages (all seq=-1) reordered.
    const run = (id: string, deltas: string[], base: string): ThreadEvent[] => [
      {
        ...event("thread.message-sent", { text: `msg-${id}`, createdAt: `${base}.000Z` }),
        seq: -1,
        dispatcher_run_id: id
      },
      ...deltas.map((delta, i) => ({
        ...acpDelta(delta, { seq: i + 1, createdAt: `${base}.0${i + 1}0Z` }),
        dispatcher_run_id: id
      })),
      {
        ...event("turn/completed", {
          payload: { raw: { params: { turn: { status: "completed" } } } },
          createdAt: `${base}.900Z`
        }),
        seq: 99,
        dispatcher_run_id: id
      }
    ];
    const blocks = deriveThreadBlocks({
      run: null,
      events: [
        ...run("run-a", ["I'm powered by ", "**SWE-2 Medium**"], "2026-01-01T00:00:10"),
        ...run("run-b", ["Those lines are ", "a job envelope"], "2026-01-01T00:01:10")
      ]
    });
    expect(blockKinds(blocks)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(assistantTexts(blocks)).toEqual([
      "I'm powered by **SWE-2 Medium**",
      "Those lines are a job envelope"
    ]);
    const users = blocks.filter((b) => b.kind === "user").map((b) => (b as { text: string }).text);
    expect(users).toEqual(["msg-run-a", "msg-run-b"]);
  });

  it("renders turn failures as error blocks", () => {
    const blocks = deriveThreadBlocks({
      run: null,
      events: [event("turn.failed", { text: "rate limited" })]
    });
    expect(blocks[0]).toMatchObject({ kind: "error", label: "Turn failed", detail: "rate limited" });
  });

  it("drops provider noise events", () => {
    const blocks = deriveThreadBlocks({
      run: { id: "r1", status: "succeeded", prompt: "hi" },
      events: [
        event("user_message_chunk", { text: "Live job envelope: ..." }),
        event("config_option_update"),
        event("current_mode_update"),
        event("available_commands_update"),
        event("session_info_update", { text: "envelope" }),
        event("usage_update"),
        event("_cognition.ai/turn_stats"),
        event("unknown")
      ]
    });
    expect(blockKinds(blocks)).toEqual(["user"]);
  });
});

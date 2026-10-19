import { describe, expect, it } from "vitest";
import { appendAttachmentBlock, splitAttachmentBlock } from "./messageAttachments";
import { unwrapShellCommand, type ThreadBlock, type ThreadToolCall } from "./threadBlocks";
import { currentActivity, groupTimeline, summarizeTools } from "./threadTurns";

const at = "2026-01-01T00:00:00Z";
const tool = (icon: ThreadToolCall["icon"], title: string, extra: Partial<ThreadToolCall> = {}): ThreadToolCall => ({
  id: `${icon}:${title}`,
  title,
  icon,
  status: "completed",
  createdAt: at,
  ...extra
});

describe("groupTimeline", () => {
  it("folds a turn's work under its closing answer", () => {
    const blocks: ThreadBlock[] = [
      { kind: "user", id: "u", text: "Fix it", createdAt: at },
      { kind: "thinking", id: "th", text: "hmm", createdAt: at, streaming: false },
      { kind: "assistant", id: "a1", itemId: "a1", text: "Looking.", createdAt: at, streaming: false },
      { kind: "tools", id: "t", entries: [tool("terminal", "pnpm test")], createdAt: at },
      { kind: "assistant", id: "a2", itemId: "a2", text: "Fixed.", createdAt: at, streaming: false },
      { kind: "diff", id: "d", diffs: [{ path: "a.ts", diff: "+x" }], createdAt: at },
      { kind: "turn-end", id: "e", state: "completed", createdAt: at, completedAt: "2026-01-01T00:01:00Z" }
    ];
    const [user, turn] = groupTimeline(blocks);
    expect(user).toMatchObject({ type: "user" });
    expect(turn).toMatchObject({ type: "turn", answer: { id: "a2" }, end: { id: "e" } });
    if (turn?.type !== "turn") throw new Error("expected a turn");
    expect(turn.steps.map((step) => step.id)).toEqual(["th", "a1", "t"]);
    expect(turn.outcomes.map((step) => step.id)).toEqual(["d"]);
  });

  it("has no answer when the agent kept working after its last message", () => {
    const [turn] = groupTimeline([
      { kind: "assistant", id: "a", itemId: "a", text: "Starting.", createdAt: at, streaming: false },
      { kind: "tools", id: "t", entries: [tool("read", "a.ts")], createdAt: at },
      { kind: "error", id: "x", label: "Provider error", detail: "boom", createdAt: at },
      { kind: "turn-end", id: "e", state: "failed", detail: "boom", createdAt: at, completedAt: at }
    ]);
    if (turn?.type !== "turn") throw new Error("expected a turn");
    expect(turn.answer).toBeNull();
    expect(turn.steps.map((step) => step.id)).toEqual(["a", "t"]);
    expect(turn.outcomes.map((step) => step.id)).toEqual(["x"]);
  });

  it("keeps a live turn fully expanded with the working marker", () => {
    const [turn] = groupTimeline([
      { kind: "assistant", id: "a", itemId: "a", text: "Done soon", createdAt: at, streaming: false },
      { kind: "working", id: "w", createdAt: at }
    ]);
    expect(turn).toMatchObject({ type: "turn", live: { id: "w" }, answer: null });
  });

  it("splits a turn around a steering message", () => {
    const items = groupTimeline([
      { kind: "assistant", id: "a", itemId: "a", text: "one", createdAt: at, streaming: false },
      { kind: "user", id: "u", text: "steer", createdAt: at },
      { kind: "assistant", id: "b", itemId: "b", text: "two", createdAt: at, streaming: false },
      { kind: "turn-end", id: "e", state: "completed", createdAt: at, completedAt: at }
    ]);
    expect(items.map((item) => item.type)).toEqual(["turn", "user", "turn"]);
    // The work before the steer has no ending yet, so it stays open on the rail.
    expect(items[0]).toMatchObject({ type: "turn", end: null, answer: null, steps: [{ id: "a" }] });
  });
});

describe("tool digests", () => {
  it("summarizes a run of tools by activity", () => {
    expect(
      summarizeTools([
        tool("terminal", "a"),
        tool("terminal", "b"),
        tool("edit", "Edit x", { diffs: [{ path: "x.ts", diff: "" }] }),
        tool("edit", "Edit x again", { diffs: [{ path: "x.ts", diff: "" }] }),
        tool("read", "y.ts")
      ])
    ).toBe("Ran 2 commands, edited 1 file, read 1 file");
  });

  it("names the running tool for the live row", () => {
    expect(
      currentActivity([{ kind: "tools", id: "t", entries: [tool("terminal", "x", { status: "running", command: "pnpm test" })], createdAt: at }])
    ).toBe("Running pnpm test");
  });
});

describe("unwrapShellCommand", () => {
  it("drops the login-shell wrapper harnesses add", () => {
    expect(unwrapShellCommand(`/bin/zsh -lc "pnpm test --filter \\"web\\""`)).toBe(`pnpm test --filter "web"`);
    expect(unwrapShellCommand(`bash -lc 'echo it'\\''s'`)).toBe(`echo it's`);
    expect(unwrapShellCommand("pnpm test")).toBe("pnpm test");
  });
});

describe("message attachments", () => {
  it("round-trips the attachment block", () => {
    const files = [
      { id: "9b2e", name: "shot.png", mimeType: "image/png", size: 120, path: "/srv/aisevak/attachments/9b2e/shot.png" },
      { id: "77aa", name: "my log (1).txt", mimeType: "text/plain", size: 9, path: "/srv/aisevak/attachments/77aa/my log (1).txt" }
    ];
    const text = appendAttachmentBlock("Why does this fail?", files);
    expect(text).toContain("<attachments>\n- /srv/aisevak/attachments/9b2e/shot.png (image/png, 120 bytes, id 9b2e)");
    expect(splitAttachmentBlock(text)).toEqual({ text: "Why does this fail?", attachments: files });
  });

  it("allows an attachment-only message and leaves plain text alone", () => {
    const only = appendAttachmentBlock("", [{ id: "a", name: "f.pdf", mimeType: "application/pdf", size: 1, path: "/x/f.pdf" }]);
    expect(splitAttachmentBlock(only).text).toBe("");
    expect(splitAttachmentBlock("just <attachments> talk")).toEqual({ text: "just <attachments> talk", attachments: [] });
  });
});

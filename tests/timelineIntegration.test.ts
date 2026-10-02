import { expect, it } from "vitest";
import { normalizeAcpEvent } from "../packages/core/src/acp.js";
import { deriveThreadBlocks, type ThreadEvent } from "../apps/web/src/threadBlocks.js";
let seq = 0;

it("preserves replay and incremental reasoning through real ACP normalization", () => {
  const update = (kind: string, text: string, replay = false): ThreadEvent => {
    const normalized = normalizeAcpEvent({ aisevakReplay: replay, method: "session/update", params: {
      update: { sessionUpdate: kind, content: { type: "text", text } }
    } });
    return { id: String(++seq), seq, event_type: normalized.type, text: normalized.text, payload: normalized };
  };
  const blocks = deriveThreadBlocks({ run: null, events: [
    update("agent_message_chunk", "Old reply", true),
    update("agent_thought_chunk", "First"), update("agent_thought_delta", " "), update("agent_thought_delta", "thought"),
    update("agent_message_chunk", "New reply")
  ] });
  expect(blocks).toMatchObject([{ kind: "thinking", text: "First thought" }, { kind: "assistant", text: "New reply" }]);
});

it("renders Codex reasoning content arrays when the summary is empty", () => {
  const blocks = deriveThreadBlocks({ run: null, events: [{ id: "r", seq: 1, event_type: "item/completed", payload: {
    raw: { params: { item: { id: "r", type: "reasoning", summary: [], content: ["Detailed reasoning"] } } }
  } }] });
  expect(blocks).toMatchObject([{ kind: "thinking", text: "Detailed reasoning" }]);
});

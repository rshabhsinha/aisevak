import { describe, expect, it } from "vitest";
import { createRuntimeNormalizer } from "./normalizer.js";
import { unifiedDiff } from "./util.js";

describe("unifiedDiff", () => {
  it("splits distant edits into separate hunks with three lines of context", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[1] = "changed 2";
    after[17] = "changed 18";
    expect(unifiedDiff("/srv/a.txt", `${before.join("\n")}\n`, `${after.join("\n")}\n`)).toBe(
      [
        "--- a/srv/a.txt",
        "+++ b/srv/a.txt",
        "@@ -1,5 +1,5 @@",
        " line 1",
        "-line 2",
        "+changed 2",
        " line 3",
        " line 4",
        " line 5",
        "@@ -15,6 +15,6 @@",
        " line 15",
        " line 16",
        " line 17",
        "-line 18",
        "+changed 18",
        " line 19",
        " line 20"
      ].join("\n")
    );
  });

  it("diffs a new file against /dev/null", () => {
    expect(unifiedDiff("notes.md", null, "a\nb\n")).toBe("--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+a\n+b");
  });

  it("returns only headers when nothing changed", () => {
    expect(unifiedDiff("x", "same\n", "same\n")).toBe("--- a/x\n+++ b/x");
  });

  it("handles large edits without overflowing the stack and skips giant ones", () => {
    const lines = (count: number) => `${Array.from({ length: count }, (_, i) => `line ${i}`).join("\n")}\n`;
    const added = unifiedDiff("big.txt", null, lines(15_000));
    expect(added?.split("\n")).toHaveLength(15_003);
    expect(unifiedDiff("huge.txt", null, lines(200_000))).toBeUndefined();
    expect(unifiedDiff("shrunk.txt", lines(1_000_000), "a\n")).toBeUndefined();
  });

  it("normalizes an ACP edit of a very large file without throwing", () => {
    const newText = Array.from({ length: 200_000 }, (_, i) => `row ${i}`).join("\n");
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses_1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write data.csv", kind: "edit", status: "completed", content: [{ type: "diff", path: "/srv/data.csv", oldText: null, newText }] } }
    });
    const event = createRuntimeNormalizer("claude").normalize(line);
    expect(event?.type).toBe("item.completed");
  });
});

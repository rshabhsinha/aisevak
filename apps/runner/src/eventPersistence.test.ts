import { normalizeCodexEvent, redactSecrets, type DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { persistCodexLine, persistDispatcherCodexLine } from "./index.js";
import { decodePostgresJson, decodePostgresText, POSTGRES_TEXT_ESCAPE_PREFIX } from "./postgresText.js";

function recordingPool(): { pool: DbPool; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const assertRepresentable = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes("\u0000") || Buffer.from(value, "utf8").toString("utf8") !== value) {
        throw new Error("PG text/JSONB rejected an invalid Unicode string");
      }
    } else if (Array.isArray(value)) value.forEach(assertRepresentable);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        assertRepresentable(key);
        assertRepresentable(item);
      }
    }
  };
  return {
    pool: {
      async query(sql: string, params: unknown[] = []) {
        assertRepresentable(params);
        queries.push({ sql, params });
        return { rows: [] };
      }
    } as unknown as DbPool,
    queries
  };
}

describe("normalized provider event storage", () => {
  it.each(["worker", "dispatcher"] as const)("losslessly stores redacted NUL/surrogate events for %s", async (kind) => {
    const { pool, queries } = recordingPool();
    const secret = "fixture-only-secret";
    const raw = {
      method: "item/completed",
      params: {
        item: { type: "commandExecution", aggregatedOutput: `binary\u0000${secret}\ud800` },
        nested: { ["key\u0000"]: ["\u0000", String.raw`\u0000`, POSTGRES_TEXT_ESCAPE_PREFIX] }
      }
    };
    // This is the existing caller boundary: redact provider text BEFORE parse
    // and storage. The codec must not reintroduce any credential material.
    const line = redactSecrets(JSON.stringify(raw), [secret]);
    if (kind === "worker") {
      await persistCodexLine(pool, { id: "run-1", task_session_id: "session-1", agent_thread_id: null }, line, 7);
    } else {
      await persistDispatcherCodexLine(pool, { id: "run-1" }, line, 7);
    }
    const stored = queries.at(-1)!;
    const normalized = normalizeCodexEvent(JSON.parse(line));
    expect(stored.sql).toContain(kind === "worker" ? "INSERT INTO run_events" : "INSERT INTO dispatcher_run_events");
    expect(stored.params.slice(0, 3)).toEqual(["run-1", 7, "item/completed"]);
    expect(decodePostgresText(stored.params[3] as string)).toBe(normalized.text);
    expect(decodePostgresJson(stored.params[4])).toEqual(normalized);
    expect(JSON.stringify(stored.params)).not.toContain(secret);
    expect(JSON.stringify(stored.params)).toContain("[REDACTED]");
  });

  it("preserves the ordinary event payload and ordering identifiers", async () => {
    const { pool, queries } = recordingPool();
    const raw = { method: "item/agentMessage/delta", params: { delta: "normal 日本語 😀" } };
    await persistDispatcherCodexLine(pool, { id: "run-1" }, JSON.stringify(raw), 42);
    expect(queries[0]?.params).toEqual(["run-1", 42, raw.method, raw.params.delta, normalizeCodexEvent(raw)]);
  });

  it("stores a malformed/non-JSON provider line with NUL as an explicit parse error", async () => {
    const { pool, queries } = recordingPool();
    const line = "non-JSON tool output\u0000\udc00";
    await persistDispatcherCodexLine(pool, { id: "run-1" }, line, 2);
    expect(queries[0]?.params[2]).toBe("parse.error");
    expect(decodePostgresJson(queries[0]?.params[4])).toEqual({
      ...normalizeCodexEvent({ type: "parse.error", rawLine: line })
    });
  });
});

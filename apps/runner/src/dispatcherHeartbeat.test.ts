import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { getDispatcherAgent } from "./index.js";

describe("dispatcher heartbeat session", () => {
  it("only resumes a successful heartbeat thread from the same Codex home", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return {
          rows: [{ id: "dispatcher-id", model: "gpt-test", instructions: "route work", thread_id: "thread-id" }]
        };
      }
    } as unknown as DbPool;

    const dispatcher = await getDispatcherAgent(pool, "/managed/codex-homes/dispatcher-heartbeat");

    expect(dispatcher.threadId).toBe("thread-id");
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("scope = 'heartbeat'");
    expect(queries[0]?.sql).toContain("status = 'succeeded'");
    expect(queries[0]?.sql).toContain("codex_home = $1");
    expect(queries[0]?.params).toEqual(["/managed/codex-homes/dispatcher-heartbeat"]);
  });
});

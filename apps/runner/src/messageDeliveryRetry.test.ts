import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { finishMessageDelivery } from "./index.js";

function retryPool(options: { failInsert?: boolean } = {}): {
  pool: DbPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (options.failInsert && sql.includes("INSERT INTO dispatcher_runs")) {
        throw new Error("injected insert failure");
      }
      return { rows: [] };
    },
    release() {}
  };
  return {
    pool: {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return { rows: [{ attempt_count: 1 }] };
      },
      async connect() {
        return client;
      }
    } as unknown as DbPool,
    queries
  };
}

describe("message delivery retry", () => {
  it("marks the delivery retrying and enqueues its replacement in one transaction", async () => {
    const { pool, queries } = retryPool();

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "temporary failure"
    );

    expect(queries.map((query) => query.sql.trim())).toEqual([
      expect.stringContaining("SELECT attempt_count"),
      "BEGIN",
      expect.stringContaining("UPDATE message_deliveries"),
      expect.stringContaining("INSERT INTO dispatcher_runs"),
      "COMMIT"
    ]);
  });

  it("rolls back the delivery update when replacement enqueueing fails", async () => {
    const { pool, queries } = retryPool({ failInsert: true });

    await expect(
      finishMessageDelivery(
        pool,
        { id: "dispatcher-run", message_delivery_id: "delivery" },
        "failed",
        "temporary failure"
      )
    ).rejects.toThrow("injected insert failure");

    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
  });
});

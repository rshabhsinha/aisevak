import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { finishMessageDelivery } from "./index.js";

interface RetryPoolOptions {
  attemptCount?: number;
  failInsert?: boolean;
  overlappingRun?: boolean;
  presentedAt?: Date | null;
  providerThreadId?: string | null;
}

function retryPool(options: RetryPoolOptions = {}): {
  pool: DbPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let deliveryStatus = "running";
  let retryQueued = options.overlappingRun ?? false;
  const query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("SELECT delivery.status")) {
      return {
        rows: [
          {
            status: deliveryStatus,
            attempt_count: options.attemptCount ?? 1,
            presented_at:
              options.presentedAt === undefined
                ? new Date("2026-08-11T00:00:00Z")
                : options.presentedAt,
            provider_thread_id: options.providerThreadId ?? null
          }
        ]
      };
    }
    if (sql.includes("INSERT INTO dispatcher_runs")) {
      if (options.failInsert) throw new Error("injected insert failure");
      if (retryQueued) return { rows: [] };
      retryQueued = true;
      return { rows: [{ id: "retry-run" }] };
    }
    if (sql.includes("SET status = 'retrying'")) deliveryStatus = "retrying";
    if (sql.includes("SET status = 'failed'")) deliveryStatus = "failed";
    if (sql.includes("SET status = 'completed'")) deliveryStatus = "completed";
    return { rows: [] };
  };
  const client = {
    query,
    release() {}
  };
  return {
    pool: {
      query,
      async connect() {
        return client;
      }
    } as unknown as DbPool,
    queries
  };
}

describe("message delivery retry", () => {
  it("enqueues a retry before marking a delivery retrying when no provider thread exists", async () => {
    const { pool, queries } = retryPool();

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "temporary failure"
    );

    expect(queries.map((query) => query.sql.trim())).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE OF delivery"),
      expect.stringContaining("INSERT INTO dispatcher_runs"),
      expect.stringContaining("SET status = 'retrying'"),
      "COMMIT"
    ]);
  });

  it("fails a presented delivery instead of replaying it on an established provider thread", async () => {
    const { pool, queries } = retryPool({ providerThreadId: "provider-thread" });

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "app-server exited before turn completed with code 0"
    );

    expect(queries.some((query) => query.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    const failure = queries.find((query) => query.sql.includes("SET status = 'failed'"));
    expect(failure?.params).toEqual([
      "delivery",
      "Automatic delivery retry suppressed: the coordination message was already presented to an established provider thread. Original error: app-server exited before turn completed with code 0"
    ]);
  });

  it("keeps a pre-presentation retry when the provider thread is known", async () => {
    const { pool, queries } = retryPool({
      presentedAt: null,
      providerThreadId: "provider-thread"
    });

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "setup failure"
    );

    expect(queries.filter((query) => query.sql.includes("INSERT INTO dispatcher_runs"))).toHaveLength(1);
    expect(queries.some((query) => query.sql.includes("SET status = 'retrying'"))).toBe(true);
  });

  it("fails closed when turn/start was sent but its acceptance is unknown", async () => {
    const { pool, queries } = retryPool({
      presentedAt: null,
      providerThreadId: "provider-thread"
    });

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "app-server exited before replying to turn/start",
      true
    );

    expect(queries.some((query) => query.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(queries.find((query) => query.sql.includes("SET status = 'failed'"))?.params).toEqual([
      "delivery",
      "Automatic delivery retry suppressed: turn/start was sent to an established provider thread and may have presented the coordination message. Original error: app-server exited before replying to turn/start"
    ]);
  });

  it("does not enqueue a second retry when finalization is repeated", async () => {
    const { pool, queries } = retryPool();
    const job = { id: "dispatcher-run", message_delivery_id: "delivery" };

    await finishMessageDelivery(pool, job, "failed", "temporary failure");
    await finishMessageDelivery(pool, job, "failed", "temporary failure");

    expect(queries.filter((query) => query.sql.includes("INSERT INTO dispatcher_runs"))).toHaveLength(1);
    expect(queries.filter((query) => query.sql.trim() === "COMMIT")).toHaveLength(2);
  });

  it("fails closed instead of overlapping an already queued retry", async () => {
    const { pool, queries } = retryPool({ overlappingRun: true });

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "temporary failure"
    );

    const insert = queries.find((query) => query.sql.includes("INSERT INTO dispatcher_runs"));
    expect(insert?.sql).toContain("NOT EXISTS");
    expect(insert?.sql).toContain("'queued', 'running', 'cancel_requested'");
    const failure = queries.find((query) => query.sql.includes("SET status = 'failed'"));
    expect(failure?.params).toEqual([
      "delivery",
      "Automatic delivery retry suppressed: the source run was unavailable or another run for this coordination message was already queued or active. Original error: temporary failure"
    ]);
    expect(
      queries.some(
        (query) =>
          query.sql.includes("UPDATE dispatcher_runs") &&
          query.sql.includes("SET status = 'cancelled'") &&
          query.sql.includes("status = 'queued'")
      )
    ).toBe(true);
  });

  it("marks the delivery failed after a replacement enqueue rollback", async () => {
    const { pool, queries } = retryPool({ failInsert: true });

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "temporary failure"
    );

    expect(queries.at(-2)?.sql).toBe("ROLLBACK");
    expect(queries.at(-1)?.sql).toContain("SET status = 'failed'");
    expect(queries.at(-1)?.sql).toContain("status = 'running'");
    expect(queries.at(-1)?.params).toEqual([
      "delivery",
      "Could not enqueue delivery retry: injected insert failure. Original error: temporary failure"
    ]);
  });

  it("stops retrying after the third presentation", async () => {
    const { pool, queries } = retryPool({ attemptCount: 3 });

    await finishMessageDelivery(
      pool,
      { id: "dispatcher-run", message_delivery_id: "delivery" },
      "failed",
      "third failure"
    );

    expect(queries.some((query) => query.sql.includes("INSERT INTO dispatcher_runs"))).toBe(false);
    expect(queries.find((query) => query.sql.includes("SET status = 'failed'"))?.params).toEqual([
      "delivery",
      "third failure"
    ]);
  });
});

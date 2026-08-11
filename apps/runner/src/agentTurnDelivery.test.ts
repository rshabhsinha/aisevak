import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { claimAgentTurnInput, finishAgentTurnInput } from "./index.js";

describe("incremental agent turn delivery", () => {
  it("claims a delivery once and records terminal success durably", async () => {
    const queries: string[] = [];
    let claimed = false;
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SET status = 'delivering'")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: "input-id", message: "follow-up", message_delivery_id: "delivery-id" }] };
      }
      if (sql.includes("SET status = 'running'") && sql.includes("RETURNING id")) {
        return { rows: [{ id: "delivery-id" }] };
      }
      if (sql.includes("SET status = $2") && sql.includes("RETURNING message_delivery_id")) {
        return { rows: [{ message_delivery_id: "delivery-id" }] };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = {
      query,
      async connect() {
        return client;
      }
    } as unknown as DbPool;

    await expect(claimAgentTurnInput(pool, "dispatcher", "run-id")).resolves.toMatchObject({
      id: "input-id",
      message: "follow-up",
      messageDeliveryId: "delivery-id"
    });
    await expect(claimAgentTurnInput(pool, "dispatcher", "run-id")).resolves.toBeNull();
    await finishAgentTurnInput(pool, {
      id: "input-id",
      message: "follow-up",
      messageDeliveryId: "delivery-id"
    });

    expect(queries.filter((sql) => sql.includes("SET status = 'running'") && sql.includes("message_deliveries"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("SET status = 'completed'") && sql.includes("message_deliveries"))).toHaveLength(1);
    expect(queries.some((sql) => sql.includes("status = 'queued' OR status = 'cancel_requested'"))).toBe(true);
  });

  it("marks a failed incremental delivery and cancels duplicate queued runs", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SET status = $2") && sql.includes("RETURNING message_delivery_id")) {
        return { rows: [{ message_delivery_id: "delivery-id" }] };
      }
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = {
      query,
      async connect() {
        return client;
      }
    } as unknown as DbPool;

    await finishAgentTurnInput(
      pool,
      { id: "input-id", message: "follow-up", messageDeliveryId: "delivery-id" },
      "provider rejected input"
    );

    expect(queries.some((sql) => sql.includes("SET status = 'failed'") && sql.includes("message_deliveries"))).toBe(true);
    expect(queries.some((sql) => sql.includes("status = 'queued' OR status = 'cancel_requested'"))).toBe(true);
  });
});

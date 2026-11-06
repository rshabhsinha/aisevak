import { describe, expect, it } from "vitest";
import { createPool, withTransaction } from "./db.js";

// Use a disposable database, as with the other PostgreSQL integration tests.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("database timeouts", () => {
  it("sets a server-side statement timeout on every new connection", async () => {
    const pool = createPool(databaseUrl);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        const result = await client.query("SHOW statement_timeout");
        expect(result.rows[0].statement_timeout).toBe("30s");
        const idle = await client.query("SHOW idle_in_transaction_session_timeout");
        expect(idle.rows[0].idle_in_transaction_session_timeout).toBe("1min");
      }
    } finally {
      clients.forEach((client) => client.release());
      await pool.end();
    }
  });

  it("survives the server ending a checked-out session and keeps the pool usable", async () => {
    const pool = createPool(databaseUrl, { max: 2 });
    const admin = createPool(databaseUrl, { max: 1 });
    try {
      const client = await pool.connect();
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await client.query("BEGIN");
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(client.query("SELECT 1")).rejects.toThrow();
      client.release(true);
      const result = await pool.query("SELECT 1 AS value");
      expect(result.rows[0].value).toBe(1);
    } finally {
      await pool.end();
      await admin.end();
    }
  });

  it("cancels slow SQL and rolls back so the pool remains usable", async () => {
    const pool = createPool(databaseUrl, { max: 1, statement_timeout: 100 });
    try {
      await expect(withTransaction(pool, async (client) => {
        await client.query("SELECT pg_sleep(10)");
      })).rejects.toMatchObject({ code: "57014" });
      const result = await pool.query("SELECT 1 AS value");
      expect(result.rows[0].value).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("bounds the wait for a saturated pool and recovers after release", async () => {
    const pool = createPool(databaseUrl, { max: 1 });
    const client = await pool.connect();
    try {
      await expect(pool.connect()).rejects.toThrow(/timeout/i);
      expect(pool.waitingCount).toBe(0);
    } finally {
      client.release();
    }
    try {
      const result = await pool.query("SELECT 1 AS value");
      expect(result.rows[0].value).toBe(1);
    } finally {
      await pool.end();
    }
  }, 15_000);
});

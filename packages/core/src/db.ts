import pg from "pg";

export type DbPool = pg.Pool;

export function createPool(
  connectionString = process.env.DATABASE_URL,
  options: pg.PoolConfig = {}
): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new pg.Pool({
    // Cancel work in PostgreSQL itself so a timed-out request releases its
    // database connection. A client-only query timeout leaves SQL running.
    statement_timeout: 30_000,
    // A transaction left open by a stalled request must not hold its client
    // and row locks indefinitely. Work that legitimately holds a transaction
    // across slow non-database steps opts out with SET LOCAL.
    idle_in_transaction_session_timeout: 60_000,
    // Bound both connection setup and the wait for a free pool client.
    connectionTimeoutMillis: 5_000,
    ...options,
    connectionString
  });
  // The server can end a session at any time (restart, pg_terminate_backend).
  // pg emits that as an 'error' event, which would crash the process when no
  // listener is attached: pg-pool only listens while a client is idle. The
  // affected query still rejects, and the pool discards the broken client.
  pool.on("error", (error) => {
    console.error(`database connection error: ${error.message}`);
  });
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error(`database client error: ${error.message}`);
    });
  });
  return pool;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

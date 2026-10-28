import pg from "pg";

export type DbPool = pg.Pool;

export function createPool(
  connectionString = process.env.DATABASE_URL,
  options: pg.PoolConfig = {}
): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  return new pg.Pool({
    // Cancel work in PostgreSQL itself so a timed-out request releases its
    // database connection. A client-only query timeout leaves SQL running.
    statement_timeout: 30_000,
    // Bound both connection setup and the wait for a free pool client.
    connectionTimeoutMillis: 5_000,
    ...options,
    connectionString
  });
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

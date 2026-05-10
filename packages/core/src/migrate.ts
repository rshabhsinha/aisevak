import { createPool } from "./db.js";
import { runMigrations } from "./migrations.js";

const pool = createPool();

try {
  await runMigrations(pool);
  console.log("Database migrations complete");
} finally {
  await pool.end();
}

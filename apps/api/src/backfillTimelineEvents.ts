/**
 * One-off backfill that shrinks stored timeline events written before the
 * runtime limits existed: replayed session history is deleted, and remaining
 * normalized payloads get the same bounds new events are stored with (inline
 * images summarized, tool output and raw provider messages capped).
 *
 *   pnpm -F @aisevak/api backfill:timeline-events -- --dry-run
 *   pnpm -F @aisevak/api backfill:timeline-events -- --batch 100 --after <uuid> --table run_events
 *
 * Rows are only ever deleted or rewritten in place, batch by batch, so the
 * script can be stopped and resumed from the last id it printed.
 */
import { boundRuntimeEvent, createPool, displayText, withTransaction, type DbPool, type RuntimeEvent } from "@aisevak/core";
import { fileURLToPath } from "node:url";

export const BACKFILL_TABLES = ["run_events", "dispatcher_run_events"] as const;
export type BackfillTable = (typeof BACKFILL_TABLES)[number];

/**
 * Rows stored (compressed) at or under this size are not read unless replayed.
 * Postgres compresses large payloads, so a repetitive 300 KB log can be stored
 * in a few KB: the bar is low, and anything under it is cheap to keep anyway.
 */
const MIN_CANDIDATE_STORED_BYTES = 2 * 1024;
/** Output under this many characters is never re-rendered from JSON. */
const MIN_RERENDER_OUTPUT_CHARS = 16 * 1024;

export type BackfillAction =
  | { action: "keep" }
  | { action: "delete" }
  | { action: "update"; payload: RuntimeEvent };

type JsonRecord = Record<string, unknown>;

/** Decide what happens to one stored payload. Pure: the script and tests share it. */
export function backfillPayload(payload: unknown): BackfillAction {
  const record = recordValue(payload);
  // Legacy (pre-v2) rows and rows aisevak writes itself keep their shape.
  if (!record || record.v !== 2 || typeof record.type !== "string") return { action: "keep" };
  if (record.replay === true) return { action: "delete" };
  if (carriesAccounting(record)) return { action: "keep" };
  const event = record as unknown as RuntimeEvent;
  const output = event.item?.output;
  const readable = typeof output === "string" ? readableOutput(output) : output;
  const withReadableOutput = readable === output ? event : { ...event, item: { ...event.item!, output: readable } };
  const bounded = boundRuntimeEvent(withReadableOutput);
  return bounded === event ? { action: "keep" } : { action: "update", payload: bounded };
}

/**
 * Usage analytics and rate-limit lookups read these rows' raw provider
 * messages (apps/api/src/usageAnalytics.ts, usageLimits.ts); never touch them.
 */
function carriesAccounting(record: JsonRecord): boolean {
  if (record.type === "usage.updated" || record.type === "turn.completed") return true;
  const raw = recordValue(record.raw);
  const message = recordValue(raw?.payload);
  const method = raw?.method ?? message?.method;
  if (method === "account/rateLimits/updated" || method === "thread/tokenUsage/updated") return true;
  return Boolean(recordValue(recordValue(message?.result)?.usage));
}

/** Tool results stored as pretty-printed JSON content blocks (inline base64 images) → display text. */
function readableOutput(output: string): string {
  if (output.length <= MIN_RERENDER_OUTPUT_CHARS || !/^\s*[[{]/.test(output)) return output;
  try {
    return displayText(JSON.parse(output)) ?? output;
  } catch {
    return output;
  }
}

export interface BackfillOptions {
  dryRun: boolean;
  batchSize: number;
  after: string | null;
  tables: readonly BackfillTable[];
  log?: (line: string) => void;
}

export interface BackfillTotals {
  scanned: number;
  deleted: number;
  updated: number;
  bytesBefore: number;
  bytesAfter: number;
}

export async function backfillTimelineEvents(pool: DbPool, options: BackfillOptions): Promise<Record<BackfillTable, BackfillTotals>> {
  const log = options.log ?? ((line: string) => console.log(line));
  const results = {} as Record<BackfillTable, BackfillTotals>;
  for (const table of options.tables) {
    const totals: BackfillTotals = { scanned: 0, deleted: 0, updated: 0, bytesBefore: 0, bytesAfter: 0 };
    let after = options.after;
    for (;;) {
      // Candidates only: replayed rows, and rows big enough to be worth
      // rewriting. pg_column_size reads the stored size without detoasting,
      // so small rows are filtered before their payload is read.
      const batch = await pool.query<{ id: string; payload: unknown; bytes: number }>(
        `SELECT id, payload, octet_length(payload::text) AS bytes
         FROM ${table}
         WHERE ($1::uuid IS NULL OR id > $1)
           AND (pg_column_size(payload) > $3 OR payload->>'replay' = 'true')
         ORDER BY id
         LIMIT $2`,
        [after, options.batchSize, MIN_CANDIDATE_STORED_BYTES]
      );
      if (batch.rows.length === 0) break;
      const deletes: string[] = [];
      const updates: Array<{ id: string; payload: RuntimeEvent }> = [];
      for (const row of batch.rows) {
        totals.scanned += 1;
        const bytes = Number(row.bytes);
        const decision = backfillPayload(row.payload);
        if (decision.action === "delete") {
          deletes.push(row.id);
          totals.bytesBefore += bytes;
        } else if (decision.action === "update") {
          updates.push({ id: row.id, payload: decision.payload });
          totals.bytesBefore += bytes;
          totals.bytesAfter += Buffer.byteLength(JSON.stringify(decision.payload));
        }
      }
      if (!options.dryRun && (deletes.length || updates.length)) {
        await withTransaction(pool, async (client) => {
          if (deletes.length) await client.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [deletes]);
          for (const update of updates) {
            await client.query(`UPDATE ${table} SET payload = $2 WHERE id = $1`, [update.id, update.payload]);
          }
        });
      }
      totals.deleted += deletes.length;
      totals.updated += updates.length;
      after = batch.rows.at(-1)!.id;
      log(
        `${table}: scanned ${totals.scanned}, ${options.dryRun ? "would delete" : "deleted"} ${totals.deleted}, ` +
          `${options.dryRun ? "would rewrite" : "rewrote"} ${totals.updated}, ` +
          `${formatMb(totals.bytesBefore - totals.bytesAfter)} saved so far; resume with --table ${table} --after ${after}`
      );
    }
    results[table] = totals;
    log(
      `${table} done: ${totals.deleted} ${options.dryRun ? "to delete" : "deleted"}, ${totals.updated} ${options.dryRun ? "to rewrite" : "rewritten"}, ` +
        `${formatMb(totals.bytesBefore)} → ${formatMb(totals.bytesAfter)} of JSON${options.dryRun ? " (dry run, nothing changed)" : ""}`
    );
  }
  return results;
}

export function parseBackfillArgs(argv: readonly string[]): BackfillOptions {
  const options: BackfillOptions = { dryRun: false, batchSize: 200, after: null, tables: BACKFILL_TABLES };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--") continue;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--batch") {
      options.batchSize = Number(value());
      if (!Number.isInteger(options.batchSize) || options.batchSize < 1) throw new Error("--batch must be a positive integer");
    } else if (arg === "--after") options.after = value();
    else if (arg === "--table") {
      const table = value();
      if (!BACKFILL_TABLES.includes(table as BackfillTable)) throw new Error(`--table must be one of ${BACKFILL_TABLES.join(", ")}`);
      options.tables = [table as BackfillTable];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseBackfillArgs(process.argv.slice(2));
  const pool = createPool();
  backfillTimelineEvents(pool, options)
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}

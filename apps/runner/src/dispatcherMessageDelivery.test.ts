import type { DbPool } from "@aisevak/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppServerTurnOptions, AppServerTurnResult } from "./appServerClient.js";

const runtimeRoot = await mkdtemp(join(tmpdir(), "aisevak-dispatcher-delivery-test-"));
const hostAuthPath = join(runtimeRoot, "host-auth.json");
const previousHostAuthPath = process.env.CODEX_HOST_AUTH_JSON;
await writeFile(hostAuthPath, JSON.stringify({ OPENAI_API_KEY: "runner-test-api-key" }));
process.env.CODEX_HOST_AUTH_JSON = hostAuthPath;

const { processOneDispatcherRun } = await import("./index.js");

afterAll(async () => {
  if (previousHostAuthPath === undefined) delete process.env.CODEX_HOST_AUTH_JSON;
  else process.env.CODEX_HOST_AUTH_JSON = previousHostAuthPath;
  await rm(runtimeRoot, { recursive: true, force: true });
});

describe("dispatcher message delivery", () => {
  it("retries an established-thread failure that happens before turn/start", async () => {
    const codexHome = join(runtimeRoot, "codex-home");
    const { pool, queries, deliveryStatus } = dispatcherPool(codexHome);
    const failBeforeTurnStart = async (
      options: AppServerTurnOptions
    ): Promise<AppServerTurnResult> => {
      expect(options.threadId).toBe("provider-thread");
      return {
        status: "failed",
        threadId: "provider-thread",
        turnId: null,
        rawStdout: "",
        rawStderr: "",
        exitCode: null,
        error: "thread setup failed",
        promptMayHaveBeenPresented: false
      };
    };

    await processOneDispatcherRun(pool, failBeforeTurnStart);

    const claim = queries.find((query) =>
      query.sql.includes("SET status = 'running', attempt_count = attempt_count + 1")
    );
    expect(claim?.sql).not.toContain("presented_at");
    expect(queries.some((query) => query.sql.includes("SET presented_at"))).toBe(false);
    expect(
      queries.filter((query) => query.sql.includes("INSERT INTO dispatcher_runs"))
    ).toHaveLength(1);
    expect(deliveryStatus()).toBe("retrying");
  });

  it("does not pick a queued run after its delivery has failed", async () => {
    let picked = false;
    const query = async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("SELECT candidate.id") && sql.includes("FROM dispatcher_runs candidate")) {
        expect(sql).toContain("delivery.status IN ('queued', 'retrying')");
        return { rows: [] };
      }
      picked = true;
      return { rows: [] };
    };
    const client = { query, release() {} };
    const pool = { query, async connect() { return client; } } as unknown as DbPool;

    await processOneDispatcherRun(pool, async () => {
      throw new Error("a failed delivery run must not be picked");
    });

    expect(picked).toBe(false);
  });
});

function dispatcherPool(codexHome: string): {
  pool: DbPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
  deliveryStatus: () => string;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let status = "pending";
  let attemptCount = 0;
  const query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("SELECT candidate.id") && sql.includes("FROM dispatcher_runs candidate")) {
      return { rows: [{ id: "dispatcher-run", agent_thread_id: "agent-thread" }] };
    }
    if (sql.includes("UPDATE dispatcher_runs") && sql.includes("RETURNING id")) {
      return { rows: [{ id: "dispatcher-run" }] };
    }
    if (sql.includes("SELECT dispatcher_runs.id")) {
      return {
        rows: [
          {
            id: "dispatcher-run",
            scope: "coordination",
            agent_thread_id: "agent-thread",
            message_delivery_id: "delivery",
            task_id: null,
            prompt: "coordination message",
            model: "gpt-test",
            model_options: [],
            cwd: runtimeRoot,
            codex_home: codexHome,
            codex_thread_id: "provider-thread",
            skills_snapshot: [],
            agent_id: "agent",
            agent_kind: "worker",
            agent_name: "Builder",
            agent_description: "Builds",
            agent_instructions: "",
            coordination_thread_id: "coordination-thread"
          }
        ]
      };
    }
    if (sql.includes("SET status = 'running', attempt_count = attempt_count + 1")) {
      status = "running";
      attemptCount += 1;
      return { rows: [] };
    }
    if (sql.includes("SELECT encrypted_value FROM secrets")) return { rows: [] };
    if (sql.includes("SELECT delivery.status")) {
      return {
        rows: [
          {
            status,
            attempt_count: attemptCount,
            presented_at: null,
            provider_thread_id: "provider-thread"
          }
        ]
      };
    }
    if (sql.includes("INSERT INTO dispatcher_runs")) return { rows: [{ id: "retry-run" }] };
    if (sql.includes("UPDATE message_deliveries") && sql.includes("SET status = 'retrying'")) {
      status = "retrying";
    }
    if (sql.includes("UPDATE message_deliveries") && sql.includes("SET status = 'failed'")) {
      status = "failed";
    }
    return { rows: [] };
  };
  const client = { query, release() {} };
  return {
    pool: {
      query,
      async connect() {
        return client;
      }
    } as unknown as DbPool,
    queries,
    deliveryStatus: () => status
  };
}

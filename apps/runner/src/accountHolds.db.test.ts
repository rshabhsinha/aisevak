import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.MANAGED_ROOT = `/tmp/aisevak-account-holds-test-${process.pid}`; });
import { createPool, ensureConcurrentIndexes, runMigrations, type DbPool } from "@aisevak/core";
import { heldProviderAccounts } from "./accountHolds.js";
import { claimDispatcherRun, claimWorkerRun, enqueueDueSchedule } from "./index.js";

// Runs when AISEVAK_TEST_DATABASE_URL points at a disposable database.
const databaseUrl = process.env.AISEVAK_TEST_DATABASE_URL;
const SECRET_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
// Accounts of this test only, so its limits never hold another test's work.
const LIMITED = "codex-holds-limited";
const FREE = "codex-holds-free";
// Older than anything other tests queue, so the claims below reach these runs first.
const LONG_AGO_MINUTES = 5_000_000;

describe.skipIf(!databaseUrl)("runs on an account at its usage limit", () => {
  let pool: DbPool;
  beforeAll(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool);
    await ensureConcurrentIndexes(pool);
    await pool.query(
      `INSERT INTO provider_instances (id, driver, display_name, enabled)
       VALUES ($1, 'codex', 'Codex', true), ($2, 'codex', 'Codex', true) ON CONFLICT (id) DO NOTHING`,
      [LIMITED, FREE]
    );
  });
  afterAll(async () => { await pool?.end(); });
  afterEach(async () => {
    const accounts = [LIMITED, FREE];
    await pool.query("DELETE FROM provider_account_limits WHERE provider_instance_id = ANY($1)", [accounts]);
    for (const table of ["dispatcher_runs", "task_runs"]) {
      await pool.query(
        `UPDATE ${table} SET status = 'cancelled', finished_at = now()
         WHERE status IN ('queued', 'running')
           AND agent_thread_id IN (SELECT id FROM agent_threads WHERE provider_instance_id = ANY($1))`,
        [accounts]
      );
    }
    await pool.query(
      "UPDATE schedules SET enabled = false WHERE agent_id IN (SELECT id FROM agents WHERE provider_instance_id = ANY($1))",
      [accounts]
    );
  });

  async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    return (await pool.query(sql, params)).rows[0] as T;
  }

  async function agentOn(account: string): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO agents (name, description, model, instructions, provider_instance_id)
       VALUES ($1, 'a', 'gpt-test', 'x', $2) RETURNING id`,
      [`Holds-${randomUUID().slice(0, 8)}`, account]
    );
    return row.id;
  }

  async function threadOn(account: string, agentId: string, taskId: string | null = null): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO agent_threads (agent_id, task_id, provider_instance_id, model, title, cwd, runtime_home)
       VALUES ($1, $2, $3, 'gpt-test', 't', '/tmp', $4) RETURNING id`,
      [agentId, taskId, account, `/tmp/${randomUUID()}`]
    );
    return row.id;
  }

  async function taskFor(agentId: string): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO tasks (title, agent_id, status, work_scope, work_key, work_fingerprint)
       VALUES ('Work', $1, 'open', 'test', $2, 'f') RETURNING id`,
      [agentId, `holds-${randomUUID()}`]
    );
    return row.id;
  }

  async function queueDispatcherRun(threadId: string, minutesAgo: number): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO dispatcher_runs (agent_thread_id, scope, status, cwd, codex_home, model, prompt, queued_at, workspace_mode)
       VALUES ($1, 'coordination', 'queued', '/tmp', '/tmp', 'gpt-test', 'p', now() - ($2 * interval '1 minute'), 'projectless')
       RETURNING id`,
      [threadId, minutesAgo]
    );
    return row.id;
  }

  async function queueWorkerRun(taskId: string, threadId: string, minutesAgo: number): Promise<string> {
    const session = await one<{ id: string }>(
      "INSERT INTO task_sessions (task_id, agent_snapshot, codex_home) VALUES ($1, '{}'::jsonb, '/tmp') RETURNING id",
      [taskId]
    );
    const row = await one<{ id: string }>(
      `INSERT INTO task_runs (task_id, task_session_id, agent_thread_id, run_kind, status, cwd, model, prompt, workspace_mode, queued_at)
       VALUES ($1, $2, $3, 'worker', 'queued', '/tmp', 'gpt-test', 'p', 'projectless', now() - ($4 * interval '1 minute'))
       RETURNING id`,
      [taskId, session.id, threadId, minutesAgo]
    );
    return row.id;
  }

  const limit = (account: string, minutes: number) =>
    pool.query(
      `INSERT INTO provider_account_limits (provider_instance_id, limited_until, reason)
       VALUES ($1, now() + ($2 * interval '1 minute'), 'usage limit reached')`,
      [account, minutes]
    );
  const held = async () => [...(await heldProviderAccounts(pool, SECRET_KEY)).keys()];

  it("leaves a held account's coordination turn queued and starts the others", async () => {
    const heldRun = await queueDispatcherRun(await threadOn(LIMITED, await agentOn(LIMITED)), LONG_AGO_MINUTES + 10);
    const freeRun = await queueDispatcherRun(await threadOn(FREE, await agentOn(FREE)), LONG_AGO_MINUTES + 5);
    await limit(LIMITED, 60);

    expect((await claimDispatcherRun(pool, await held()))?.id).toBe(freeRun);
    expect((await claimDispatcherRun(pool, await held()))?.id).not.toBe(heldRun);
    expect((await one<{ status: string }>("SELECT status FROM dispatcher_runs WHERE id = $1", [heldRun])).status).toBe("queued");

    // Once the limit has passed, the held turn starts on its own.
    await pool.query(
      "UPDATE provider_account_limits SET limited_until = now() - interval '1 second' WHERE provider_instance_id = $1",
      [LIMITED]
    );
    const claimed = await claimDispatcherRun(pool, await held());
    expect(claimed?.id).toBe(heldRun);
    expect(claimed?.started_at).toBeInstanceOf(Date);
  });

  it("leaves a held account's worker turn queued", async () => {
    const limitedAgent = await agentOn(LIMITED);
    const freeAgent = await agentOn(FREE);
    const limitedTask = await taskFor(limitedAgent);
    const freeTask = await taskFor(freeAgent);
    const heldRun = await queueWorkerRun(limitedTask, await threadOn(LIMITED, limitedAgent, limitedTask), LONG_AGO_MINUTES + 10);
    const freeRun = await queueWorkerRun(freeTask, await threadOn(FREE, freeAgent, freeTask), LONG_AGO_MINUTES + 5);
    await limit(LIMITED, 60);

    expect((await claimWorkerRun(pool, await held()))?.id).toBe(freeRun);
    expect((await claimWorkerRun(pool, await held()))?.id).not.toBe(heldRun);
    expect((await one<{ status: string }>("SELECT status FROM task_runs WHERE id = $1", [heldRun])).status).toBe("queued");
  });

  it("moves a schedule tick for a held agent to the reset instead of running it", async () => {
    const agentId = await agentOn(LIMITED);
    const schedule = await one<{ id: string }>(
      `INSERT INTO schedules (title, prompt, agent_id, schedule_kind, next_run_at, interval_seconds)
       VALUES ('Loop', 'check', $1, 'interval', now() - interval '100 years', 600) RETURNING id`,
      [agentId]
    );
    await limit(LIMITED, 90);

    await enqueueDueSchedule(pool);

    const row = await one<{ next_run_at: Date; limited_until: Date; runs: number; ticks: number }>(
      `SELECT schedules.next_run_at, account_limit.limited_until,
              (SELECT count(*)::int FROM dispatcher_runs
                 WHERE agent_thread_id IN (SELECT id FROM agent_threads WHERE agent_id = $2)) AS runs,
              (SELECT count(*)::int FROM schedule_runs WHERE schedule_id = schedules.id) AS ticks
       FROM schedules, provider_account_limits account_limit
       WHERE schedules.id = $1 AND account_limit.provider_instance_id = $3`,
      [schedule.id, agentId, LIMITED]
    );
    expect(row.runs).toBe(0);
    expect(row.ticks).toBe(0);
    expect(row.next_run_at.getTime()).toBe(row.limited_until.getTime());
  });
});

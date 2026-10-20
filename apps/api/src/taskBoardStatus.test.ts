import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_STATUS_JOINS } from "./server.js";

// Runs the board status SQL against real Postgres. Temporary tables shadow
// the real ones for this connection only, so any database works and nothing
// persists. Set TEST_DATABASE_URL to run it.
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("task board status", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE tasks (id int PRIMARY KEY, status text NOT NULL, parent_task_id int, completion_policy text NOT NULL DEFAULT 'on_first_success');
      CREATE TEMP TABLE task_runs (task_id int, run_kind text NOT NULL DEFAULT 'worker', status text, created_at timestamptz, id serial);
      CREATE TEMP TABLE dispatcher_runs (task_id int, status text, created_at timestamptz);
      CREATE TEMP TABLE task_assignments (task_id int, status text);
    `);
  });

  afterAll(async () => {
    await client?.end();
  });

  async function boardStatus(setup: {
    status?: string;
    completionPolicy?: "explicit" | "on_first_success";
    worker?: Array<[string, number]>;
    dispatcher?: Array<[string, number]>;
    assignments?: string[];
    childStatuses?: string[];
  }): Promise<string> {
    await client.query("TRUNCATE tasks, task_runs, dispatcher_runs, task_assignments");
    await client.query("INSERT INTO tasks (id, status, completion_policy) VALUES (1, $1, $2)", [setup.status ?? "open", setup.completionPolicy ?? "on_first_success"]);
    for (const [index, childStatus] of (setup.childStatuses ?? []).entries()) {
      await client.query("INSERT INTO tasks (id, status, parent_task_id) VALUES ($1, $2, 1)", [100 + index, childStatus]);
    }
    // Run ages are minutes ago, so a smaller number is more recent.
    for (const [status, minutesAgo] of setup.worker ?? []) {
      await client.query("INSERT INTO task_runs (task_id, status, created_at) VALUES (1, $1, now() - make_interval(mins => $2))", [status, minutesAgo]);
    }
    for (const [status, minutesAgo] of setup.dispatcher ?? []) {
      await client.query("INSERT INTO dispatcher_runs (task_id, status, created_at) VALUES (1, $1, now() - make_interval(mins => $2))", [status, minutesAgo]);
    }
    for (const status of setup.assignments ?? []) {
      await client.query("INSERT INTO task_assignments (task_id, status) VALUES (1, $1)", [status]);
    }
    const result = await client.query<{ status: string }>(`SELECT board.status FROM tasks ${TASK_STATUS_JOINS} WHERE tasks.id = 1`);
    return result.rows[0]!.status;
  }

  it("uses the task's own status when it has never run", async () => {
    expect(await boardStatus({})).toBe("open");
  });

  it("shows an active dispatcher run as running over an older worker outcome", async () => {
    expect(await boardStatus({ worker: [["succeeded", 10]], dispatcher: [["running", 1]] })).toBe("running");
  });

  it("moves a finished scheduled occurrence out of Todo", async () => {
    expect(await boardStatus({ dispatcher: [["succeeded", 1]] })).toBe("succeeded");
    expect(await boardStatus({ dispatcher: [["failed", 1]] })).toBe("failed");
  });

  it("lets a newer dispatcher outcome replace an older worker outcome", async () => {
    expect(await boardStatus({ worker: [["succeeded", 10]], dispatcher: [["failed", 1]] })).toBe("failed");
  });

  it("lets a newer worker outcome replace an older dispatcher outcome", async () => {
    expect(await boardStatus({ worker: [["failed", 1]], dispatcher: [["succeeded", 10]] })).toBe("failed");
  });

  it("keeps an orchestrator open while assignments or children are in flight", async () => {
    expect(await boardStatus({ dispatcher: [["succeeded", 1]], assignments: ["queued"] })).toBe("open");
    expect(await boardStatus({ dispatcher: [["succeeded", 1]], childStatuses: ["open"] })).toBe("open");
    expect(await boardStatus({ dispatcher: [["succeeded", 1]], assignments: ["completed"], childStatuses: ["completed"] })).toBe("succeeded");
  });

  it("keeps an open explicit-completion task out of Completed after a successful run", async () => {
    expect(await boardStatus({ completionPolicy: "explicit", worker: [["succeeded", 1]] })).toBe("open");
    expect(await boardStatus({ completionPolicy: "explicit", worker: [["failed", 1]] })).toBe("failed");
    expect(await boardStatus({ completionPolicy: "explicit", status: "completed", worker: [["succeeded", 1]] })).toBe("succeeded");
    expect(await boardStatus({ completionPolicy: "on_first_success", worker: [["succeeded", 1]] })).toBe("succeeded");
  });

  it("keeps a finalized task status over a dispatcher outcome", async () => {
    expect(await boardStatus({ status: "completed", dispatcher: [["failed", 1]] })).toBe("completed");
  });
});

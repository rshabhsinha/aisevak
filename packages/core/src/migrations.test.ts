import { describe, expect, it } from "vitest";
import { additiveSql } from "./migrations.js";

describe("run snapshot migration", () => {
  it("correlates task snapshots to their own task and project", () => {
    const start = additiveSql.indexOf("UPDATE task_runs");
    const end = additiveSql.indexOf("UPDATE dispatcher_runs", start);
    const sql = additiveSql.slice(start, end);

    expect(sql).toContain("FROM tasks\nJOIN projects ON projects.id = tasks.project_id");
    expect(sql).toContain("task_runs.task_id = tasks.id");
    expect(sql).toContain("workspace_source = CASE");
    expect(sql).not.toContain("FROM tasks\nJOIN projects ON projects.id = tasks.project_id\nWHERE task_runs.workspace_key = ''");
  });

  it("backfills linked, task-scoped, and projectless dispatcher snapshots", () => {
    const start = additiveSql.indexOf("UPDATE dispatcher_runs");
    const end = additiveSql.indexOf("CREATE INDEX IF NOT EXISTS task_runs_agent_thread_status_idx", start);
    const sql = additiveSql.slice(start, end);

    expect(sql).toContain("agent_threads.id = dispatcher_runs.agent_thread_id");
    expect(sql).toContain("tasks.id = dispatcher_runs.task_id");
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain("'unknown'");
    expect(sql).toContain("''");
    expect(sql).not.toMatch(/FROM dispatcher_runs[\s\S]*LEFT JOIN tasks ON tasks\.id = dispatcher_runs\.task_id/);
  });
});

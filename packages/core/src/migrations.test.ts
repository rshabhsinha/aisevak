import { describe, expect, it } from "vitest";
import { additiveSql } from "./migrations.js";

describe("run snapshot migration", () => {
  it("correlates task snapshots to their own task and project", () => {
    const start = additiveSql.indexOf("WITH task_workspace_projects");
    const end = additiveSql.indexOf("WITH dispatcher_workspace_projects", start);
    const sql = additiveSql.slice(start, end);

    expect(sql).toContain("FROM task_runs\n  LEFT JOIN projects");
    expect(sql).toContain("tasks.id = task_runs.task_id");
    expect(sql).toContain("projects.local_path = task_runs.cwd");
    expect(sql).toContain("workspace_source = CASE");
    expect(sql).toContain("count(DISTINCT projects.id) = 1");
    expect(sql).not.toContain("tasks.project_id");
  });

  it("backfills linked, task-scoped, and projectless dispatcher snapshots", () => {
    const start = additiveSql.indexOf("WITH dispatcher_workspace_projects");
    const end = additiveSql.indexOf("CREATE INDEX IF NOT EXISTS task_runs_agent_thread_status_idx", start);
    const sql = additiveSql.slice(start, end);

    expect(sql).toContain("FROM dispatcher_runs\n  LEFT JOIN projects");
    expect(sql).toContain("projects.local_path = dispatcher_runs.cwd");
    expect(sql).not.toContain("agent_threads.project_id");
    expect(sql).not.toContain("tasks.project_id");
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain("'unknown'");
    expect(sql).toContain("''");
    expect(sql).not.toMatch(/FROM dispatcher_runs[\s\S]*LEFT JOIN tasks ON tasks\.id = dispatcher_runs\.task_id/);
  });

  it("does not rewrite existing model selections during startup", () => {
    expect(additiveSql).not.toContain("20260822_luna_max_everywhere");
    expect(additiveSql).not.toContain("UPDATE agent_threads\n    SET model = 'gpt-5.6-luna'");
  });

  it("adds additive keyed jobs, assignments, and safety event storage", () => {
    expect(additiveSql).toContain("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_scope text");
    expect(additiveSql).toContain("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_key text");
    expect(additiveSql).toContain("legacy:' || id::text");
    expect(additiveSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS tasks_work_identity_unique");
    expect(additiveSql).toContain("CREATE TABLE IF NOT EXISTS task_assignments");
    expect(additiveSql).toContain("UNIQUE (task_id, assignment_key)");
    expect(additiveSql).toContain("CREATE TABLE IF NOT EXISTS job_safety_events");
    expect(additiveSql).toContain("ALTER TABLE schedules ADD COLUMN IF NOT EXISTS overlap_policy text NOT NULL DEFAULT 'skip'");
  });

  it("creates assignment foreign keys only after the assignment table exists", () => {
    expect(additiveSql.indexOf("CREATE TABLE IF NOT EXISTS task_assignments")).toBeLessThan(
      additiveSql.indexOf("agent_tool_tokens_assignment_id_fkey")
    );
    expect(additiveSql.indexOf("ALTER TABLE message_deliveries ADD COLUMN IF NOT EXISTS assignment_id uuid")).toBeLessThan(
      additiveSql.indexOf("message_deliveries_assignment_id_fkey")
    );
  });
});

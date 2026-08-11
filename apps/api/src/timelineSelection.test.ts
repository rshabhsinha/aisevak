import type { DbPool } from "@aisevak/core";
import { describe, expect, it } from "vitest";
import { getTaskSessionTimeline, selectPreferredTimelineRun } from "./server.js";

describe("agent thread timeline selection", () => {
  it("keeps active metadata paired with the active status", () => {
    const selected = selectPreferredTimelineRun([
      {
        id: "queued-newer",
        status: "queued",
        kind: "worker" as const,
        trigger: "manual",
        model: "model-a",
        agent_name: "Builder",
        queued_at: "2026-08-11T01:02:00.000Z",
        created_at: "2026-08-11T01:02:00.000Z"
      },
      {
        id: "running-older",
        status: "running",
        kind: "dispatcher" as const,
        trigger: "message",
        model: "model-b",
        agent_name: "Reviewer",
        queued_at: "2026-08-11T01:01:00.000Z",
        started_at: "2026-08-11T01:01:30.000Z",
        created_at: "2026-08-11T01:01:00.000Z"
      }
    ]);

    expect(selected).toMatchObject({ id: "running-older", status: "running", model: "model-b" });
  });

  it("aggregates worker and dispatcher events by immutable thread id after task transfer", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("task_runs_and_dispatches")) {
          return {
            rows: [
              {
                id: "worker-run",
                kind: "worker",
                trigger: "manual",
                status: "succeeded",
                model: "model-a",
                task_id: "old-task",
                agent_name: "Builder",
                prompt: "old task turn",
                queued_at: "2026-08-11T01:00:00.000Z",
                finished_at: "2026-08-11T01:01:00.000Z"
              },
              {
                id: "dispatcher-run",
                kind: "dispatcher",
                trigger: "message",
                status: "running",
                model: "model-b",
                task_id: "new-task",
                agent_name: "Reviewer",
                prompt: "new task turn",
                queued_at: "2026-08-11T01:02:00.000Z",
                started_at: "2026-08-11T01:03:00.000Z"
              }
            ]
          };
        }
        if (sql.includes("task_events")) {
          return {
            rows: [
              {
                id: "worker-event",
                run_id: "worker-run",
                dispatcher_run_id: null,
                seq: 1,
                event_type: "worker.done",
                text: "worker event",
                payload: {},
                created_at: "2026-08-11T01:01:00.000Z"
              },
              {
                id: "dispatcher-event",
                run_id: null,
                dispatcher_run_id: "dispatcher-run",
                seq: 1,
                event_type: "dispatcher.update",
                text: "dispatcher event",
                payload: {},
                created_at: "2026-08-11T01:03:00.000Z"
              }
            ]
          };
        }
        if (sql.includes("FROM task_comments")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }
    } as unknown as DbPool;

    const timeline = await getTaskSessionTimeline(pool, null, "thread-id", false);

    expect(timeline.run).toMatchObject({ id: "dispatcher-run", status: "running", model: "model-b" });
    expect(timeline.events.map((event) => event.id)).toEqual([
      "user-message:worker-run",
      "worker-event",
      "user-message:dispatcher-run",
      "dispatcher-event"
    ]);
    expect(queries.every((query) => query.params?.[0] === null || query.params?.[1] === "thread-id")).toBe(true);
    expect(queries[0]?.sql).toContain("agent_thread_id = $2");
    expect(queries[1]?.sql).toContain("agent_turn_inputs.agent_thread_id = $2");
  });
});

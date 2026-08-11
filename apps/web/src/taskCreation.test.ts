import { describe, expect, it, vi } from "vitest";
import { createTaskAndQueueRun, type TaskApiRequest } from "./taskCreation.js";

describe("task creation", () => {
  it("queues the new task immediately after creating it", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/api/tasks") return { task: { id: "task-id", title: "Route me" } };
      return { run: { id: "run-id" } };
    }) as unknown as TaskApiRequest;

    const result = await createTaskAndQueueRun(request, { title: "Route me" });

    expect(result).toEqual({
      task: { id: "task-id", title: "Route me" },
      enqueueError: null
    });
    expect(request).toHaveBeenNthCalledWith(1, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "Route me" })
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/tasks/task-id/runs", { method: "POST" });
  });

  it("does not queue a run when task creation fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("create failed");
    }) as unknown as TaskApiRequest;

    await expect(createTaskAndQueueRun(request, { title: "Route me" })).rejects.toThrow("create failed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns the committed task when run enqueueing fails", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/api/tasks") return { task: { id: "task-id", title: "Keep me" } };
      throw new Error("A project is required to start this task");
    }) as unknown as TaskApiRequest;

    const result = await createTaskAndQueueRun(request, { title: "Keep me" });

    expect(result.task).toEqual({ id: "task-id", title: "Keep me" });
    expect(result.enqueueError).toEqual(new Error("A project is required to start this task"));
    expect(request).toHaveBeenCalledTimes(2);
  });
});

export type TaskApiRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export interface TaskCreationResult<Task> {
  task: Task;
  enqueueError: Error | null;
}

export async function createTaskAndQueueRun<Task extends { id: string }>(
  request: TaskApiRequest,
  payload: Record<string, unknown>
): Promise<TaskCreationResult<Task>> {
  const { task } = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  try {
    await request(`/api/tasks/${task.id}/runs`, { method: "POST" });
    return { task, enqueueError: null };
  } catch (error) {
    return {
      task,
      enqueueError: error instanceof Error ? error : new Error("Failed to start the task")
    };
  }
}

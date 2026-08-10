export type TaskApiRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export async function createTaskAndQueueRun<Task extends { id: string }>(
  request: TaskApiRequest,
  payload: Record<string, unknown>
): Promise<Task> {
  const { task } = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await request(`/api/tasks/${task.id}/runs`, { method: "POST" });
  return task;
}

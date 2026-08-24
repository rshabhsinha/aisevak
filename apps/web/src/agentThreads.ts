export function mergeRefreshedAgentThreads<T extends { id: string }>(
  current: T[],
  refreshed: T[]
): T[] {
  const byId = new Map<string, T>();
  for (const thread of refreshed) byId.set(thread.id, thread);
  for (const thread of current) {
    if (!byId.has(thread.id)) byId.set(thread.id, thread);
  }
  return sortAgentThreads([...byId.values()]);
}

export function updateAgentThreadInPlace<T extends { id: string }>(current: T[], updated: T): T[] {
  const next = current.filter((thread) => thread.id !== updated.id);
  next.push(updated);
  return sortAgentThreads(next);
}

export function sortAgentThreads<T extends { id: string }>(threads: T[]): T[] {
  return [...threads].sort((left, right) => {
    const leftTime = Date.parse(String((left as { last_activity_at?: unknown }).last_activity_at ?? ""));
    const rightTime = Date.parse(String((right as { last_activity_at?: unknown }).last_activity_at ?? ""));
    const leftHasTime = Number.isFinite(leftTime);
    const rightHasTime = Number.isFinite(rightTime);
    if (leftHasTime && rightHasTime && leftTime !== rightTime) return rightTime - leftTime;
    if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1;
    if (leftHasTime && left.id !== right.id) return right.id.localeCompare(left.id);
    return 0;
  });
}

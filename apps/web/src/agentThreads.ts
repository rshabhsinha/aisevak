export function mergeRefreshedAgentThreads<T extends { id: string }>(
  current: T[],
  refreshed: T[]
): T[] {
  const refreshedIds = new Set(refreshed.map((thread) => thread.id));
  return [...refreshed, ...current.filter((thread) => !refreshedIds.has(thread.id))];
}

export function updateAgentThreadInPlace<T extends { id: string }>(current: T[], updated: T): T[] {
  const index = current.findIndex((thread) => thread.id === updated.id);
  if (index < 0) return [updated, ...current];
  return current.map((thread, threadIndex) => (threadIndex === index ? updated : thread));
}

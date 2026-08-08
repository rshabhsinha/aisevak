export function mergeRefreshedAgentThreads<T extends { id: string }>(
  current: T[],
  refreshed: T[]
): T[] {
  const refreshedIds = new Set(refreshed.map((thread) => thread.id));
  return [...refreshed, ...current.filter((thread) => !refreshedIds.has(thread.id))];
}

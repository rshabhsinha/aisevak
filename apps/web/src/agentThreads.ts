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

export type SidebarThreadGroupId = "running" | "attention" | "today" | "yesterday" | "earlier";

export const SIDEBAR_THREAD_GROUP_LABELS: Record<SidebarThreadGroupId, string> = {
  running: "Running",
  attention: "Needs you",
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier"
};

// Splits the sorted thread list into the sidebar's sections: live work first,
// then failures nobody has opened yet, then everything else by day. Each
// section keeps the input order (most recent activity first).
export function groupSidebarThreads<T extends { last_activity_at: string }>(
  threads: T[],
  options: { now: Date; isRunning: (thread: T) => boolean; needsAttention: (thread: T) => boolean }
): Array<{ id: SidebarThreadGroupId; threads: T[] }> {
  const groups: Record<SidebarThreadGroupId, T[]> = { running: [], attention: [], today: [], yesterday: [], earlier: [] };
  const startOfToday = new Date(options.now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday.getTime() - 24 * 60 * 60 * 1000;
  for (const thread of threads) {
    if (options.isRunning(thread)) groups.running.push(thread);
    else if (options.needsAttention(thread)) groups.attention.push(thread);
    else {
      const time = Date.parse(thread.last_activity_at);
      if (!Number.isFinite(time) || time >= startOfToday.getTime()) groups.today.push(thread);
      else if (time >= startOfYesterday) groups.yesterday.push(thread);
      else groups.earlier.push(thread);
    }
  }
  return (Object.keys(groups) as SidebarThreadGroupId[])
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, threads: groups[id] }));
}

/**
 * Per-browser record of the last activity the viewer saw on each thread, so
 * the sidebar can mark threads that moved while they were looking elsewhere.
 * `since` covers threads with no entry: activity before it counts as seen,
 * so a first visit does not light up the whole list.
 */
export interface ThreadSeenState {
  since: string;
  seen: Record<string, string>;
}

const THREAD_SEEN_KEY = "aisevak.threadSeen.v1";
const THREAD_SEEN_LIMIT = 500;

export function loadThreadSeenState(now = new Date()): ThreadSeenState {
  try {
    const raw = window.localStorage.getItem(THREAD_SEEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThreadSeenState>;
      if (typeof parsed.since === "string" && parsed.seen && typeof parsed.seen === "object") {
        return { since: parsed.since, seen: parsed.seen };
      }
    }
  } catch {
    // Storage blocked or corrupt: start fresh below.
  }
  const state = { since: now.toISOString(), seen: {} };
  saveThreadSeenState(state);
  return state;
}

export function saveThreadSeenState(state: ThreadSeenState): void {
  try {
    window.localStorage.setItem(THREAD_SEEN_KEY, JSON.stringify(state));
  } catch {
    // Unread markers are a convenience; losing them is fine.
  }
}

export function markThreadSeen(state: ThreadSeenState, threadId: string, activityAt: string): ThreadSeenState {
  if (state.seen[threadId] === activityAt) return state;
  const entries = Object.entries({ ...state.seen, [threadId]: activityAt })
    .sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]))
    .slice(0, THREAD_SEEN_LIMIT);
  return { since: state.since, seen: Object.fromEntries(entries) };
}

export function isThreadUnread(state: ThreadSeenState, thread: { id: string; last_activity_at: string }): boolean {
  const activity = Date.parse(thread.last_activity_at);
  const seen = Date.parse(state.seen[thread.id] ?? state.since);
  return Number.isFinite(activity) && Number.isFinite(seen) && activity > seen;
}

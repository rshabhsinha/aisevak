/** One `GET /api/agent-threads/:id` response, full or incremental. */
export interface ThreadTimelineResponse<E extends { id: string }> {
  events: E[];
  /** Rows that change after insert (steer delivery status) or are synthesized; always the complete set. */
  liveEvents?: E[];
  mode?: "full" | "delta";
  cursor?: string | null;
  eventsTruncated?: boolean;
}

/** The client's copy of one thread's timeline, advanced by each poll. */
export interface ThreadTimelineCache<E extends { id: string }> {
  threadId: string;
  cursor: string | null;
  events: E[];
  liveEvents: E[];
  truncated: boolean;
}

/**
 * Fold a response into the cached timeline. A delta carries only rows created
 * since the cursor (plus some overlap), merged by id; a full response, or one
 * for a different thread, replaces the cache.
 */
export function applyThreadTimelineResponse<E extends { id: string }>(
  cache: ThreadTimelineCache<E> | null,
  threadId: string,
  response: ThreadTimelineResponse<E>
): ThreadTimelineCache<E> {
  const liveEvents = response.liveEvents ?? [];
  if (response.mode !== "delta" || !cache || cache.threadId !== threadId) {
    return {
      threadId,
      cursor: response.cursor ?? null,
      events: response.events,
      liveEvents,
      truncated: Boolean(response.eventsTruncated)
    };
  }
  const byId = new Map(cache.events.map((event) => [event.id, event]));
  for (const event of response.events) byId.set(event.id, event);
  return {
    threadId,
    cursor: response.cursor ?? cache.cursor,
    events: byId.size === cache.events.length && response.events.length === 0 ? cache.events : [...byId.values()],
    liveEvents,
    truncated: cache.truncated
  };
}

export function threadTimelineEvents<E extends { id: string }>(cache: ThreadTimelineCache<E>): E[] {
  return cache.liveEvents.length ? [...cache.events, ...cache.liveEvents] : cache.events;
}

/** Query string continuing from the cache, when it belongs to this thread. */
export function threadTimelineQuery(cache: ThreadTimelineCache<{ id: string }> | null, threadId: string): string {
  return cache?.threadId === threadId && cache.cursor ? `?after=${encodeURIComponent(cache.cursor)}` : "";
}

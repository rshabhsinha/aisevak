export interface ThreadLoadGuard {
  select(threadId: string | null): void;
  begin(threadId: string): () => boolean;
}

export function createThreadLoadGuard(): ThreadLoadGuard {
  let selectedThreadId: string | null = null;
  let revision = 0;

  return {
    select(threadId) {
      selectedThreadId = threadId;
      revision += 1;
    },
    begin(threadId) {
      const requestRevision = ++revision;
      return () => selectedThreadId === threadId && revision === requestRevision;
    }
  };
}

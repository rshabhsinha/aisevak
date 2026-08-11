export interface ThreadLoadGuard {
  select(threadId: string | null): void;
  begin(threadId: string): () => boolean;
}

export function createThreadLoadGuard(initialThreadId: string | null = null): ThreadLoadGuard {
  let selectedThreadId: string | null = initialThreadId;
  let revision = 0;

  return {
    select(threadId) {
      selectedThreadId = threadId;
      revision += 1;
    },
    begin(threadId) {
      if (selectedThreadId !== threadId) return () => false;
      const requestRevision = ++revision;
      return () => selectedThreadId === threadId && revision === requestRevision;
    }
  };
}

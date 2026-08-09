export interface AgentDeletionCandidate {
  kind: string;
  name: string;
}

export interface AgentDeletionUsage {
  taskCount: number;
  threadCount: number;
  otherEnabledDispatcherCount: number;
}

export function agentDeletionBlockReason(
  agent: AgentDeletionCandidate,
  usage: AgentDeletionUsage
): string | null {
  const references = [
    usage.taskCount > 0 ? `${usage.taskCount} task${usage.taskCount === 1 ? "" : "s"}` : null,
    usage.threadCount > 0 ? `${usage.threadCount} thread${usage.threadCount === 1 ? "" : "s"}` : null
  ].filter(Boolean);

  if (references.length > 0) {
    return `Cannot delete ${agent.name} because it is used by ${references.join(" and ")}. Reassign those first.`;
  }
  if (agent.kind === "dispatcher" && usage.otherEnabledDispatcherCount === 0) {
    return `Cannot delete ${agent.name} because it is the last enabled Orchestrator.`;
  }
  return null;
}

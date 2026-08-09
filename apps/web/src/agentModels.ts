export const DEFAULT_AGENT_MODEL = "gpt-5.6-luna";

export function reconcileSelectedAgent<T extends { id: string }>(
  selected: T | null,
  agents: T[]
): T | null {
  if (!selected) return agents[0] ?? null;
  if (!selected.id) return selected;
  return agents.find((agent) => agent.id === selected.id) ?? agents[0] ?? null;
}

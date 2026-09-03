/**
 * Agent ids are the durable identity for an avatar. Names are only a preview
 * fallback while a new agent is still unsaved.
 */
export function agentAvatarSeed(agentId: string, agentName: string): string {
  return agentId.trim() || agentName.trim() || "new-agent";
}

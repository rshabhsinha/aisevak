export interface AgentAvatarCell {
  x: number;
  y: number;
}

export interface AgentAvatarDescriptor {
  background: string;
  color: string;
  cells: AgentAvatarCell[];
}

const AVATAR_COLORS = [
  "#ef4444",
  "#f97316",
  "#d97706",
  "#65a30d",
  "#16a34a",
  "#0d9488",
  "#0891b2",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#a855f7",
  "#db2777"
];

function hashSeed(seed: string, salt: number): number {
  let hash = (2166136261 ^ salt) >>> 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/**
 * Produces a stable, ExtraChess-style pixel identicon for an agent.
 * Agent ids are unique and are used as the seed, so an agent keeps the same
 * profile picture everywhere without relying on a remote avatar service.
 */
export function describeAgentAvatar(agentId: string): AgentAvatarDescriptor {
  const seed = agentId || "unsaved-agent";
  const colorHash = hashSeed(seed, 0x9e3779b9);
  const backgroundHash = hashSeed(seed, 0x85ebca6b);
  const cells: AgentAvatarCell[] = [];

  // Build one half of a 5x5 bitmap and mirror it, like DiceBear identicons.
  for (let y = 0; y < 5; y += 1) {
    const rowHash = hashSeed(seed, 0xc2b2ae35 ^ y);
    for (let x = 0; x < 3; x += 1) {
      if (((rowHash >>> (x * 7)) & 1) === 0) continue;
      cells.push({ x, y });
      if (x !== 2) cells.push({ x: 4 - x, y });
    }
  }

  // Avoid an empty mark for the rare all-zero bitmap.
  if (cells.length === 0) cells.push({ x: 2, y: 2 });

  return {
    color: AVATAR_COLORS[colorHash % AVATAR_COLORS.length]!,
    background: `hsl(${backgroundHash % 360} 28% 92%)`,
    cells
  };
}

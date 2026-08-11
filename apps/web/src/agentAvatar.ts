export interface AgentAvatarCell {
  x: number;
  y: number;
}

export interface AgentAvatarDescriptor {
  background: string;
  color: string;
  cells: AgentAvatarCell[];
  size: number;
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

function uuidBits(agentId: string): number[] | null {
  const normalized = agentId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) return null;

  return [...normalized].flatMap((character) => {
    const nibble = Number.parseInt(character, 16);
    return [3, 2, 1, 0].map((shift) => (nibble >>> shift) & 1);
  });
}

/**
 * Produces a stable, ExtraChess-style pixel identicon for an agent.
 * Every bit of a UUID is encoded into a mirrored 16x16 bitmap. Because the
 * mapping is lossless, two distinct persisted agent ids cannot render the
 * same profile picture. No remote avatar service is required.
 */
export function describeAgentAvatar(agentId: string): AgentAvatarDescriptor {
  const seed = agentId || "unsaved-agent";
  const colorHash = hashSeed(seed, 0x9e3779b9);
  const backgroundHash = hashSeed(seed, 0x85ebca6b);
  const cells: AgentAvatarCell[] = [];
  const bits = uuidBits(agentId);
  const size = bits ? 16 : 5;

  if (bits) {
    // Encode 128 UUID bits down the left half, then mirror the bitmap.
    for (let index = 0; index < bits.length; index += 1) {
      if (bits[index] === 0) continue;
      const x = index % 8;
      const y = Math.floor(index / 8);
      cells.push({ x, y }, { x: 15 - x, y });
    }
  } else {
    // Unsaved agent drafts do not have a UUID yet, so render a stable preview.
    for (let y = 0; y < 5; y += 1) {
      const rowHash = hashSeed(seed, 0xc2b2ae35 ^ y);
      for (let x = 0; x < 3; x += 1) {
        if (((rowHash >>> (x * 7)) & 1) === 0) continue;
        cells.push({ x, y });
        if (x !== 2) cells.push({ x: 4 - x, y });
      }
    }
  }

  if (cells.length === 0) cells.push({ x: 2, y: 2 });

  return {
    color: AVATAR_COLORS[colorHash % AVATAR_COLORS.length]!,
    background: `hsl(${backgroundHash % 360} 28% 92%)`,
    cells,
    size
  };
}

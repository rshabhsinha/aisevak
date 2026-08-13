export interface AgentAvatarCell {
  x: number;
  y: number;
}

export interface AgentAvatarDescriptor {
  background: string;
  cells: AgentAvatarCell[];
  color: string;
  size: number;
}

// Sparse 5x5 glyphs inspired by the ExtraChess identicon set. Each number is
// one row of the portrait, encoded left-to-right as a five-bit mask.
const PORTRAIT_PATTERNS = [
  [0b00100, 0b00100, 0b11111, 0b00100, 0b00100],
  [0b01000, 0b01000, 0b11111, 0b01000, 0b01000],
  [0b10101, 0b10101, 0b00100, 0b00100, 0b00100],
  [0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
  [0b00100, 0b01010, 0b10001, 0b01010, 0b00100],
  [0b10001, 0b01010, 0b10001, 0b01010, 0b00100],
  [0b10101, 0b00100, 0b01110, 0b00100, 0b10101],
  [0b00001, 0b00010, 0b00100, 0b01000, 0b10000],
  [0b10000, 0b01000, 0b00100, 0b00010, 0b00001],
  [0b01010, 0b10001, 0b10001, 0b01010, 0b00100],
  [0b00100, 0b01110, 0b10101, 0b00100, 0b00100],
  [0b00100, 0b00100, 0b10101, 0b01110, 0b00100],
  [0b01110, 0b10001, 0b10000, 0b10001, 0b01110],
  [0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  [0b10001, 0b01010, 0b00100, 0b00100, 0b00100],
  [0b10001, 0b10001, 0b01010, 0b01010, 0b00100]
] as const;

function hashSeed(seed: string, salt: number): number {
  let hash = (2166136261 ^ salt) >>> 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function seedBytes(agentId: string): number[] {
  const seed = agentId || "unsaved-agent";
  const bytes: number[] = [];
  for (let salt = 0; salt < 4; salt += 1) {
    const hash = hashSeed(seed, 0x9e3779b9 ^ Math.imul(salt + 1, 0x85ebca6b));
    bytes.push(hash >>> 24, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff);
  }
  return bytes;
}

function vividColor(first: number, second: number, third: number): string {
  const hue = ((((first << 8) | second) * 360) / 65_536).toFixed(3);
  const saturation = 58 + (third >>> 4);
  const lightness = 40 + (third & 0x0f);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function softBackground(first: number, second: number, third: number): string {
  const hue = ((((first << 8) | second) * 360) / 65_536).toFixed(3);
  const saturation = 16 + (third >>> 4);
  const lightness = (88 + (third & 0x0f) * 0.35).toFixed(2);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function portraitCells(pattern: number): AgentAvatarCell[] {
  const cells: AgentAvatarCell[] = [];
  const rows = PORTRAIT_PATTERNS[pattern >>> 4]!;

  for (let y = 0; y < rows.length; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      if (((rows[y]! >>> (4 - x)) & 1) === 1) cells.push({ x, y });
    }
  }

  return cells;
}

/**
 * Produces a stable, sparse profile picture in the style used by ExtraChess:
 * a simple 5x5 monochrome glyph on a soft background.
 *
 * The complete agent id is mixed into the glyph, foreground, and background,
 * keeping profiles distinct without turning the portrait into a dense bitmap.
 */
export function describeAgentAvatar(agentId: string): AgentAvatarDescriptor {
  const bytes = seedBytes(agentId);

  return {
    background: softBackground(bytes[3]!, bytes[4]!, bytes[5]!),
    cells: portraitCells(bytes[6]!),
    color: vividColor(bytes[0]!, bytes[1]!, bytes[2]!),
    size: 5
  };
}

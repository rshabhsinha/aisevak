import { describe, expect, it } from "vitest";
import { describeAgentAvatar } from "./agentAvatar.js";

function relativeLuminance(color: string): number {
  const match = color.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
  if (!match) throw new Error(`Unexpected avatar color: ${color}`);

  const hue = Number(match[1]);
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const intermediate = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) [red, green] = [chroma, intermediate];
  else if (hue < 120) [red, green] = [intermediate, chroma];
  else if (hue < 180) [green, blue] = [chroma, intermediate];
  else if (hue < 240) [green, blue] = [intermediate, chroma];
  else if (hue < 300) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];

  return [red + offset, green + offset, blue + offset]
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    )
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("describeAgentAvatar", () => {
  it("keeps an agent profile picture stable", () => {
    expect(describeAgentAvatar("19e42bed-9f15-4054-9198-5df7f59f1cee")).toEqual(
      describeAgentAvatar("19e42bed-9f15-4054-9198-5df7f59f1cee")
    );
  });

  it("gives different agents unique profile pictures", () => {
    const agentIds = [
      "19e42bed-9f15-4054-9198-5df7f59f1cee",
      "2655765f-5178-4cb5-8c35-a0b683f022b1",
      "ce7bc614-0f95-444c-b411-f1f7cf223926",
      "ed2a9e68-dc98-46c8-9773-0f53756129d4"
    ];
    const pictures = agentIds.map((agentId) => JSON.stringify(describeAgentAvatar(agentId)));

    expect(new Set(pictures).size).toBe(agentIds.length);
  });

  it("stays sparse and ExtraChess-sized", () => {
    const avatar = describeAgentAvatar("19e42bed-9f15-4054-9198-5df7f59f1cee");

    expect(avatar.size).toBe(5);
    expect(avatar.cells.length).toBeGreaterThanOrEqual(5);
    expect(avatar.cells.length).toBeLessThanOrEqual(11);
  });

  it("keeps every sampled glyph legible against its background", () => {
    const agentIds = [
      "674f86dc-8cbc-4ae8-8f16-f00ce0d906cc",
      ...Array.from(
        { length: 512 },
        (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
      )
    ];

    for (const agentId of agentIds) {
      const avatar = describeAgentAvatar(agentId);
      expect(contrastRatio(avatar.color, avatar.background), agentId).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not collide for ids that shared the old lossy hash", () => {
    const first = describeAgentAvatar("00000000-0000-4000-8000-000000001902");
    const second = describeAgentAvatar("00000000-0000-4000-8000-000000002356");

    expect(first).not.toEqual(second);
    expect(first.size).toBe(5);
    expect(second.size).toBe(5);
  });

  it("mixes the complete UUID into each persisted picture", () => {
    const base = "00112233-4455-4677-8899-aabbccddeeff";
    const pictures = Array.from({ length: 32 }, (_, nibbleIndex) => {
      const normalized = base.replace(/-/g, "");
      const replacement = normalized[nibbleIndex] === "f" ? "e" : "f";
      const changed = `${normalized.slice(0, nibbleIndex)}${replacement}${normalized.slice(nibbleIndex + 1)}`;
      return JSON.stringify(describeAgentAvatar(changed));
    });

    expect(new Set([JSON.stringify(describeAgentAvatar(base)), ...pictures]).size).toBe(33);
  });
});

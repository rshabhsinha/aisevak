import { describe, expect, it } from "vitest";
import {
  POSTGRES_TEXT_ESCAPE_PREFIX,
  decodePostgresJson,
  decodePostgresText,
  encodePostgresJson,
  encodePostgresText
} from "./postgresText.js";

describe("PostgreSQL lossless text encoding", () => {
  it.each(["", "ordinary text", "日本語 😀\n\t", String.raw`literal \u0000 and \\ backslashes`])(
    "leaves ordinary Unicode and escaped text unchanged (%j)",
    (value) => {
      expect(encodePostgresText(value)).toBe(value);
      expect(decodePostgresText(value)).toBe(value);
    }
  );

  it.each([
    "before\u0000after",
    "\u0000\n\t\r\"\\",
    "high\ud800end",
    "low\udcffend",
    "\ud800\ud800\udc00\udcff",
    POSTGRES_TEXT_ESCAPE_PREFIX,
    POSTGRES_TEXT_ESCAPE_PREFIX + String.raw`\u0000`,
    POSTGRES_TEXT_ESCAPE_PREFIX + "\u0000"
  ])("round-trips exceptional UTF-16 text exactly (%j)", (value) => {
    const stored = encodePostgresText(value);
    expect(stored.startsWith(POSTGRES_TEXT_ESCAPE_PREFIX)).toBe(true);
    expect(stored).not.toContain("\u0000");
    expect(decodePostgresText(stored)).toBe(value);
    expect(decodePostgresText(JSON.parse(JSON.stringify(stored)) as string)).toBe(value);
    // PG sends/receives valid UTF-8: no lone surrogates may survive encoding.
    expect(Buffer.from(stored, "utf8").toString("utf8")).toBe(stored);
  });

  it("distinguishes NUL, literal escapes, and literal encoding prefixes", () => {
    const values = ["\u0000", String.raw`\u0000`, POSTGRES_TEXT_ESCAPE_PREFIX + String.raw`\u0000`];
    const stored = values.map(encodePostgresText);
    expect(new Set(stored).size).toBe(values.length);
    expect(stored.map(decodePostgresText)).toEqual(values);
  });

  it("recursively encodes keys and values without mutation or prototype pollution", () => {
    const raw = JSON.parse(String.raw`{"__proto__":{"polluted":true},"bad\u0000key":{"nested":["nul\u0000",{"lone\ud800":"\udfff"},null,0,false]}}`);
    raw[POSTGRES_TEXT_ESCAPE_PREFIX + String.raw`bad\u0000key`] = "literal marker";
    const original = JSON.stringify(raw);
    const stored = encodePostgresJson(raw);
    const wireRoundTrip = JSON.parse(JSON.stringify(stored));
    expect(decodePostgresJson(wireRoundTrip)).toEqual(raw);
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(JSON.stringify(raw)).toBe(original);
    expect(stored).not.toBe(raw);

    const assertRepresentable = (value: unknown): void => {
      if (typeof value === "string") {
        expect(value).not.toContain("\u0000");
        expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
      } else if (Array.isArray(value)) value.forEach(assertRepresentable);
      else if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          assertRepresentable(key);
          assertRepresentable(item);
        }
      }
    };
    assertRepresentable(wireRoundTrip);
  });
});

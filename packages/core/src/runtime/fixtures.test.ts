import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeProvider } from "./events.js";
import { createRuntimeNormalizer } from "./normalizer.js";

// Each fixtures/<provider>-<case>.jsonl holds raw harness stdout lines (shapes
// captured from real runs, content anonymized). Its .expected.json is the
// reviewed normalized output. Regenerate with UPDATE_RUNTIME_FIXTURES=1 and
// review the diff.
const fixturesDir = join(import.meta.dirname, "fixtures");
const update = process.env.UPDATE_RUNTIME_FIXTURES === "1";

export function normalizeFixture(name: string): RuntimeEvent[] {
  const provider = name.split("-")[0] as RuntimeProvider;
  const normalizer = createRuntimeNormalizer(provider);
  return readFileSync(join(fixturesDir, `${name}.jsonl`), "utf8")
    .split("\n")
    .flatMap((line) => {
      const event = normalizer.normalize(line);
      return event ? [event] : [];
    });
}

/** The raw payload is the input line itself; leave it out of the expected file. */
function withoutRawPayload(event: RuntimeEvent): unknown {
  const { payload: _payload, ...raw } = event.raw;
  return { ...event, raw };
}

describe("runtime event fixtures", () => {
  const names = readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.replace(/\.jsonl$/, ""));

  it.each(names)("%s", (name) => {
    const events = normalizeFixture(name);
    const lines = readFileSync(join(fixturesDir, `${name}.jsonl`), "utf8").split("\n").filter((line) => line.trim());
    expect(events).toHaveLength(lines.length);
    for (const [index, event] of events.entries()) {
      expect(event.v).toBe(2);
      const parsed = (() => {
        try {
          return JSON.parse(lines[index]!);
        } catch {
          return lines[index];
        }
      })();
      expect(event.raw.payload).toEqual(parsed);
    }
    const actual = events.map(withoutRawPayload);
    const expectedPath = join(fixturesDir, `${name}.expected.json`);
    if (update) writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));
  });
});

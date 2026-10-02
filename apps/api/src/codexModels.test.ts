import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { DbPool } from "@aisevak/core";
const mocks = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock("@aisevak/core", async importOriginal => ({ ...await importOriginal<typeof import("@aisevak/core")>(), discoverCodexModels: mocks.discover }));
import { discoverAuthenticatedCodexModels } from "./codexModels.js";
let root: string;
afterEach(async () => { vi.resetAllMocks(); if (root) await rm(root, {recursive:true, force:true}); });
describe("Codex model discovery homes", () => {
  it.each([false, true])("removes isolated scratch credentials after probe failure=%s", async failure => {
    root = await mkdtemp(join(tmpdir(), "aisevak-model-test-"));
    const pool = {query: vi.fn().mockResolvedValue({rows: []})} as unknown as DbPool;
    mocks.discover.mockImplementation(async ({env}) => {
      expect(env.CODEX_HOME).toContain(root);
      expect(env.HOME).toBe(env.CODEX_HOME);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      if (failure) throw new Error("probe failed");
      return [{id:"gpt-6.1-sol"}];
    });
    const probe = discoverAuthenticatedCodexModels(pool, {root, binary:"codex",secretKey:"unused"});
    if (failure) await expect(probe).rejects.toThrow("probe failed");
    else await expect(probe).resolves.toEqual([{id:"gpt-6.1-sol"}]);
    expect(await readdir(root)).toEqual([]);
  });
});

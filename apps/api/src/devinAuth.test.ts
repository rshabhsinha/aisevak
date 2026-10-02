import { decryptSecret, devinBundleApiKey, type DbPool } from "@aisevak/core";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevinAuthManager } from "./devinAuth.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), run: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./harnessCommand.js", async (original) => ({
  ...await original<typeof import("./harnessCommand.js")>(), runHarnessCommand: mocks.run
}));
const key = Buffer.alloc(32, 7).toString("base64");
const roots: string[] = [];
const managers: DevinAuthManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "devin-auth-")); roots.push(root);
  const stored = new Map<string, string>();
  const pool = { async query(sql: string, params: unknown[] = []) {
    if (sql.includes("INSERT INTO secrets")) stored.set(String(params[0]), String(params[2]));
    if (sql.startsWith("DELETE")) stored.clear();
    return { rows: stored.has(String(params[0])) && sql.startsWith("SELECT")
      ? [{ encrypted_value: stored.get(String(params[0])) }] : [] };
  } } as unknown as DbPool;
  mocks.run.mockResolvedValue({ exitCode: 0, stdout: "Not logged in.", stderr: "" });
  const manager = new DevinAuthManager(pool, key, "/missing/devin", join(root, "auth"), join(root, "host"));
  managers.push(manager);
  return { root, stored, manager };
}
function child(fail = false) {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { process.emit("close", null); return true; })
  });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => {
      if (fail) { process.emit("error", new Error("spawn ENOENT")); process.emit("close", null); }
      else process.stdout.write("Sign in at https://devin.ai/login\n");
    });
    return process;
  });
  return process;
}

describe("Devin login lifecycle", () => {
  it("returns a controlled failure when the CLI cannot start", async () => {
    const { manager } = await setup(); child(true);
    await expect(manager.startLogin("user")).rejects.toThrow("Unable to start Devin login");
  });
  it("skips settings-only homes and imports usable credentials", async () => {
    const { manager, root, stored } = await setup();
    const settings = join(root, "host/.config/devin/config.json");
    const credentials = join(root, "auth/host-import/.local/share/devin/credentials.toml");
    await mkdir(dirname(settings), { recursive: true }); await writeFile(settings, "{}");
    await mkdir(dirname(credentials), { recursive: true }); await writeFile(credentials, 'windsurf_api_key = "test-key"');
    await manager.importHostAuth();
    expect(devinBundleApiKey(decryptSecret(stored.get("devin_auth")!, key))).toBe("test-key");
  });
  it("terminates abandoned login processes and removes their scratch homes", async () => {
    const { manager, root } = await setup(); const process = child();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const login = await manager.startLogin("user");
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(manager.submitLoginCode(login.loginId, "user", "code")).rejects.toThrow("no longer available");
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await stat(join(root, "auth", login.loginId)).catch(() => null)).toBeNull());
  });
  it("disconnect disposes pending logins before removing authentication", async () => {
    const { manager } = await setup(); const process = child();
    const login = await manager.startLogin("user");
    await manager.disconnect();
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(manager.pollLogin(login.loginId, "user")).rejects.toThrow("no longer available");
  });
});

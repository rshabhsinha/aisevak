import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeAllAcpSessions, closeIdleAcpSessions, runAcpTurn } from "./acpClient.js";

afterEach(async () => { vi.restoreAllMocks(); await closeAllAcpSessions(); });

it("handles malformed resume lines and rejects persistence failures without crashing", async () => {
  const home = await mkdtemp(join(tmpdir(), "aisevak-acp-test-"));
  const script = join(home, "fake.cjs");
  await writeFile(script, `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'session/prompt' && m.params.prompt[0].text === 'hold') { setTimeout(() => console.log(JSON.stringify({id:m.id,result:{}})), 1500); return; }
 if(m.method === 'session/load') console.log('Loading session...');
 if(m.method === 'session/prompt') console.log(JSON.stringify({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello'}}}}));
 console.log(JSON.stringify({id:m.id,result:{sessionId:'s1'}}));
});`);
  const lines: string[] = [];
  const options = {
    binary: process.execPath, args: [script], cwd: home, runtimeHome: home,
    model: "auto", prompt: "hello", threadId: "s1", env: process.env, secrets: [],
    onLine: async (line: string) => { lines.push(line); }, onThreadId: async () => {}, shouldCancel: async () => false
  };
  try {
    expect((await runAcpTurn(options)).status).toBe("completed");
    expect(lines).toContain("Loading session...");
    const failed = await runAcpTurn({ ...options, onLine: async () => { throw new Error("persistence failed"); } });
    expect(failed.status).toBe("failed");
    const monitorFailure = await runAcpTurn({ ...options, prompt: "hold", shouldCancel: async () => { throw new Error("database deadlock"); } });
    expect(monitorFailure.status).toBe("failed");
    expect(monitorFailure.error).toContain("database deadlock");
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    const longTurn = runAcpTurn({ ...options, prompt: "hold", onTurnAccepted: async () => { accepted(); } });
    await acceptance;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    await closeIdleAcpSessions();
    expect((await longTurn).status).toBe("completed");
    vi.restoreAllMocks();
  } finally { await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
});

it("runs one mid-turn monitor pass at a time and drains an in-flight injection before returning", async () => {
  const home = await mkdtemp(join(tmpdir(), "aisevak-acp-test-"));
  const script = join(home, "fake.cjs");
  await writeFile(script, `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'session/prompt' && m.params.prompt[0].text === 'hold') { setTimeout(() => console.log(JSON.stringify({id:m.id,result:{}})), 1500); return; }
 if(m.method === 'session/prompt') { setTimeout(() => console.log(JSON.stringify({id:m.id,result:{}})), 1000); return; }
 console.log(JSON.stringify({id:m.id,result:{sessionId:'s1'}}));
});`);
  let inFlight = 0;
  let maxInFlight = 0;
  let claimed = 0;
  const handled: Array<{ id: string; error?: string }> = [];
  try {
    const result = await runAcpTurn({
      binary: process.execPath, args: [script], cwd: home, runtimeHome: home,
      model: "auto", prompt: "hold", threadId: null, env: process.env, secrets: [],
      onLine: async () => {}, onThreadId: async () => {},
      shouldCancel: async () => false,
      // Slower than the 750ms tick, so an unguarded monitor would overlap.
      nextInput: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 900));
        inFlight -= 1;
        claimed += 1;
        return { id: `input-${claimed}`, message: "follow-up", messageDeliveryId: null };
      },
      onInputHandled: async (input, error) => { handled.push({ id: input.id, error }); }
    });
    expect(result.status).toBe("completed");
    expect(maxInFlight).toBe(1);
    expect(claimed).toBe(1);
    // The injected prompt outlives the main one; the run must not finish first.
    expect(handled).toEqual([{ id: "input-1", error: undefined }]);
  } finally { await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
});

it("keeps honoring cancel while an injected prompt is still running", async () => {
  const home = await mkdtemp(join(tmpdir(), "aisevak-acp-test-"));
  const script = join(home, "fake.cjs");
  // The injected prompt is held open until session/cancel arrives.
  await writeFile(script, `const readline = require('node:readline');
const held = [];
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'session/prompt' && m.params.prompt[0].text === 'hold') { setTimeout(() => console.log(JSON.stringify({id:m.id,result:{}})), 1500); return; }
 if(m.method === 'session/prompt') { held.push(m.id); return; }
 if(m.method === 'session/cancel') { for (const id of held.splice(0)) console.log(JSON.stringify({id,result:{stopReason:'cancelled'}})); }
 console.log(JSON.stringify({id:m.id,result:{sessionId:'s1'}}));
});`);
  let injected = false;
  let stopAfter = Number.POSITIVE_INFINITY;
  try {
    const started = Date.now();
    const result = await runAcpTurn({
      binary: process.execPath, args: [script], cwd: home, runtimeHome: home,
      model: "auto", prompt: "hold", threadId: null, env: process.env, secrets: [],
      onLine: async () => {}, onThreadId: async () => {},
      // Stop is pressed after the main prompt has finished, while the
      // injected prompt is still open.
      shouldCancel: async () => Date.now() > stopAfter,
      nextInput: async () => {
        if (injected) return null;
        injected = true;
        stopAfter = Date.now() + 1500;
        return { id: "input-1", message: "follow-up", messageDeliveryId: null };
      },
      onInputHandled: async () => {}
    });
    expect(result.status).toBe("interrupted");
    expect(Date.now() - started).toBeLessThan(8000);
  } finally { await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
}, 15000);

it("marks failed requests the session recovers from so they are not shown as provider errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "aisevak-acp-test-"));
  const script = join(home, "fake.cjs");
  await writeFile(script, `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'session/set_model' || m.method === 'session/set_config_option') { console.log(JSON.stringify({id:m.id,error:{code:-32601,message:'Method not found'}})); return; }
 if(m.method === 'session/prompt' && m.params.prompt[0].text === 'boom') { console.log(JSON.stringify({id:m.id,error:{code:-32603,message:'Prompt failed'}})); return; }
 if(m.method === 'session/prompt') { console.log(JSON.stringify({id:m.id,result:{stopReason:'end_turn'}})); return; }
 console.log(JSON.stringify({id:m.id,result:{sessionId:'s1'}}));
});`);
  const lines: string[] = [];
  const options = {
    binary: process.execPath, args: [script], cwd: home, runtimeHome: home,
    model: "fast-model", prompt: "hello", threadId: null, env: process.env, secrets: [],
    onLine: async (line: string) => { lines.push(line); }, onThreadId: async () => {}, shouldCancel: async () => false
  };
  try {
    expect((await runAcpTurn(options)).status).toBe("completed");
    const errors = lines.map((line) => JSON.parse(line)).filter((message) => message.error);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((message) => message.aisevakRecovered === true)).toBe(true);

    lines.length = 0;
    expect((await runAcpTurn({ ...options, prompt: "boom" })).status).toBe("failed");
    const promptError = lines.map((line) => JSON.parse(line)).find((message) => message.error?.message === "Prompt failed");
    expect(promptError).toBeDefined();
    expect(promptError.aisevakRecovered).toBeUndefined();
  } finally { await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
});

it("sends stored image attachments as ACP image blocks only when the agent advertises image support", async () => {
  // Real path: image attachments must not sit behind a symlink (macOS /var → /private/var).
  const home = await realpath(await mkdtemp(join(tmpdir(), "aisevak-acp-test-")));
  const previousManagedRoot = process.env.MANAGED_ROOT;
  process.env.MANAGED_ROOT = home;
  const script = join(home, "fake.cjs");
  const log = join(home, "prompts");
  await writeFile(script, `const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'initialize') { console.log(JSON.stringify({id:m.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:process.env.FAKE_IMAGE === '1'}}}})); return; }
 if(m.method === 'session/prompt') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.params.prompt) + '\\n');
 if(m.method === 'session/prompt' && m.params.prompt[0].text === 'hold') { setTimeout(() => console.log(JSON.stringify({id:m.id,result:{}})), 1500); return; }
 console.log(JSON.stringify({id:m.id,result:{sessionId:'s1'}}));
});`);
  const id = randomUUID();
  const imagePath = join(home, "attachments", id, "shot.png");
  await mkdir(dirname(imagePath), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  await writeFile(imagePath, png);
  const message = `see attached\n\n<attachments>\n- ${imagePath} (image/png, ${png.length} bytes, id ${id})\n</attachments>`;
  const run = (runtimeHome: string, image: boolean, prompt: string, nextInput?: () => Promise<{ id: string; message: string } | null>) =>
    runAcpTurn({
      binary: process.execPath, args: [script], cwd: home, runtimeHome,
      model: "auto", prompt, threadId: null, env: { ...process.env, FAKE_IMAGE: image ? "1" : "0" }, secrets: [],
      onLine: async () => {}, onThreadId: async () => {}, shouldCancel: async () => false,
      nextInput, onInputHandled: async () => {}
    });
  try {
    let offered = false;
    const injected = async () => (offered ? null : ((offered = true), { id: "input-1", message }));
    expect((await run(join(home, "with-image"), true, message)).status).toBe("completed");
    expect((await run(join(home, "with-image"), true, "hold", injected)).status).toBe("completed");
    await closeAllAcpSessions();
    expect((await run(join(home, "text-only"), false, message)).status).toBe("completed");

    const prompts = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const imageBlock = { type: "image", mimeType: "image/png", data: png.toString("base64") };
    expect(prompts).toEqual([
      [{ type: "text", text: message }, imageBlock],
      [{ type: "text", text: "hold" }],
      [{ type: "text", text: message }, imageBlock],
      [{ type: "text", text: message }]
    ]);
  } finally {
    if (previousManagedRoot === undefined) delete process.env.MANAGED_ROOT;
    else process.env.MANAGED_ROOT = previousManagedRoot; await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
});

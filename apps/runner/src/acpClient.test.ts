import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

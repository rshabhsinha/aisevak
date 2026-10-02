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

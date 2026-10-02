import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeAllAcpSessions, runAcpTurn } from "./acpClient.js";

afterEach(closeAllAcpSessions);

it("handles malformed resume lines and rejects persistence failures without crashing", async () => {
  const home = await mkdtemp(join(tmpdir(), "aisevak-acp-test-"));
  const script = join(home, "fake.cjs");
  await writeFile(script, `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
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
  } finally { await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
});

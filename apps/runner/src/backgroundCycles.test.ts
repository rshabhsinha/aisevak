import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeAllAcpSessions, runAcpTurn } from "./acpClient.js";
import { isCycleResult } from "./backgroundCycles.js";

afterEach(async () => { await closeAllAcpSessions(); });

// A fake ACP harness: session/new hands out s1, s2, ...; a prompt "bg" ends
// its turn at once and, like Claude Code after a background command finishes,
// starts a cycle on its own a moment later.
const FAKE_HARNESS = `const readline = require('node:readline');
let sessions = 0;
const out = (m) => console.log(JSON.stringify(m));
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'session/new') { sessions += 1; out({id:m.id,result:{sessionId:'s' + sessions}}); return; }
  if (m.method === 'session/prompt') {
    const sid = m.params.sessionId;
    out({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'turn ' + sid}}}});
    out({id:m.id,result:{stopReason:'end_turn'}});
    if (m.params.prompt[0].text === 'bg') {
      setTimeout(() => {
        out({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'finish returned token=SECRET1'}}}});
        out({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'usage_update',used:10,size:100}}});
        out({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'usage_update',used:12,size:100,cost:{amount:0.5,currency:'USD'}}}});
      }, 150);
    }
    return;
  }
  out({id:m.id,result:{}});
});`;

async function fakeHarness() {
  const home = await mkdtemp(join(tmpdir(), "aisevak-bg-cycle-"));
  const script = join(home, "fake.cjs");
  await writeFile(script, FAKE_HARNESS);
  return { home, script };
}

function baseOptions(home: string, script: string) {
  return {
    binary: process.execPath, args: [script], cwd: home, runtimeHome: home,
    model: "auto", prompt: "hello", threadId: null as string | null, env: process.env, secrets: ["SECRET1"],
    onLine: async () => {}, onThreadId: async () => {}, shouldCancel: async () => false
  };
}

it("starts a new provider session when the stored session was cleared, even while the process holds one", async () => {
  const { home, script } = await fakeHarness();
  try {
    const ids: string[] = [];
    const options = { ...baseOptions(home, script), onThreadId: async (id: string) => { ids.push(id); } };
    expect((await runAcpTurn(options)).threadId).toBe("s1");
    // A context refresh cleared provider_thread_id: the next turn has no
    // threadId and must not continue s1 in the still-running process.
    expect((await runAcpTurn(options)).threadId).toBe("s2");
    expect(ids).toEqual(["s1", "s2"]);
  } finally { await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
});

it("hands what the harness does between turns to the last turn's background receiver, redacted", async () => {
  const { home, script } = await fakeHarness();
  try {
    const turnLines: string[] = [];
    const background: string[] = [];
    let resolveCycle!: () => void;
    const cycleDone = new Promise<void>((resolve) => { resolveCycle = resolve; });
    const result = await runAcpTurn({
      ...baseOptions(home, script),
      prompt: "bg",
      onLine: async (line) => { turnLines.push(line); },
      onBackgroundLine: async (line) => {
        background.push(line);
        if (isCycleResult(line)) resolveCycle();
      }
    });
    expect(result.status).toBe("completed");
    await cycleDone;
    expect(turnLines.some((line) => line.includes("turn s1"))).toBe(true);
    expect(turnLines.some((line) => line.includes("finish returned"))).toBe(false);
    expect(background).toHaveLength(3);
    expect(background[0]).toContain("finish returned");
    expect(background[0]).not.toContain("SECRET1");
    expect(isCycleResult(background[1]!)).toBe(false);
    expect(isCycleResult(background[2]!)).toBe(true);
    // The cycle's spend is attributed to the cycle (the session started at
    // zero), which moves the baseline so the next turn does not count it.
    expect(JSON.parse(background[2]!).aisevakTurnCost).toBe(0.5);
  } finally { await closeAllAcpSessions(); await rm(home, { recursive: true, force: true }); }
});

it("recognizes only a usage_update with a cost as a cycle result", () => {
  const update = (value: Record<string, unknown>) => JSON.stringify({ method: "session/update", params: { update: value } });
  expect(isCycleResult(update({ sessionUpdate: "usage_update", used: 1, cost: { amount: 1, currency: "USD" } }))).toBe(true);
  expect(isCycleResult(update({ sessionUpdate: "usage_update", used: 1 }))).toBe(false);
  expect(isCycleResult(update({ sessionUpdate: "agent_message_chunk" }))).toBe(false);
  expect(isCycleResult("not json")).toBe(false);
});

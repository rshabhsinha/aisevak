import { CLAUDE_CODE_TOKEN_SECRET_NAME, encryptSecret, type DbPool } from "@aisevak/core";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllAcpSessions } from "./acpClient.js";
import { materializeHarnessAuth, runHarnessTurn } from "./harnessRuntime.js";

const secretKey = Buffer.alloc(32, 3).toString("base64");
const OAUTH = "sk-ant-oat01-fake-subscription-token";
const ROTATED = "sk-ant-oat01-rotated-subscription-token";
const roots: string[] = [];

afterEach(async () => {
  await closeAllAcpSessions();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function poolWith(secret?: string): DbPool {
  return {
    async query(_sql: string, params: unknown[] = []) {
      return {
        rows: secret && params[0] === CLAUDE_CODE_TOKEN_SECRET_NAME
          ? [{ encrypted_value: encryptSecret(secret, secretKey) }]
          : []
      };
    }
  } as unknown as DbPool;
}

// Mirrors claude-agent-acp: no session/set_model (method not found), model and
// effort through session/set_config_option, credentials from the environment.
async function fakeAdapter(root: string): Promise<{ binary: string; log: string }> {
  const log = join(root, "requests.jsonl");
  const binary = join(root, "claude-agent-acp");
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  fs.appendFileSync(log, JSON.stringify({
    pid: process.pid, method: m.method, params: m.params,
    env: { model: process.env.ANTHROPIC_MODEL, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
           apiKey: process.env.ANTHROPIC_API_KEY, configDir: process.env.CLAUDE_CONFIG_DIR }
  }) + '\\n');
  const reply = (body) => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...body }));
  if (m.method === 'initialize') return reply({ result: { protocolVersion: 1, authMethods: [{ id: 'claude-ai-login' }] } });
  if (m.method === 'authenticate') return reply({ error: { code: -32603, message: 'Method not implemented.' } });
  if (m.method === 'session/new') return reply({ result: { sessionId: 'claude-session-1' } });
  if (m.method === 'session/set_model') return reply({ error: { code: -32601, message: 'Method not found' } });
  if (m.method === 'session/set_config_option') return reply({ result: { configOptions: [] } });
  if (m.method === 'session/prompt') {
    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'claude-session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'token is ' + process.env.CLAUDE_CODE_OAUTH_TOKEN } } } }));
    return reply({ result: { stopReason: 'end_turn' } });
  }
  reply({ error: { code: -32601, message: 'Method not found' } });
});
`);
  await chmod(binary, 0o755);
  return { binary, log };
}

async function requests(log: string): Promise<Array<{ pid: number; method: string; params: Record<string, unknown>; env: Record<string, string | undefined> }>> {
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("Claude Code harness", () => {
  it("requires a stored credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-claude-")); roots.push(root);
    await expect(materializeHarnessAuth(poolWith(), "claude", root, secretKey, {}, "claude-opus-5-5"))
      .rejects.toThrow(/Settings > Claude Code/);
  });

  it("runs a turn on the requested model and effort, redacts the credential, and restarts on rotation", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-claude-")); roots.push(root);
    const { binary, log } = await fakeAdapter(root);
    const auth = await materializeHarnessAuth(
      poolWith(OAUTH), "claude", root, secretKey, { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-api03-host" }, "claude-opus-5-5"
    );
    expect(auth.secrets).toEqual([OAUTH]);
    const lines: string[] = [];
    const turn = (credentialAuth: typeof auth, prompt: string) => runHarnessTurn({
      driver: "claude",
      cursorBinary: "unused", openCodeBinary: "unused", devinBinary: "unused",
      claudeBinary: binary,
      acpEnv: credentialAuth.env,
      connectionTag: credentialAuth.connectionTag,
      options: {
        codexBinary: "unused", cwd: root, codexHome: root, model: "claude-opus-5-5",
        modelOptions: [{ id: "reasoningEffort", value: "medium" }],
        prompt, env: credentialAuth.env, secrets: credentialAuth.secrets,
        onLine: async (line) => { lines.push(line); }, onThreadId: async () => {}, shouldCancel: async () => false
      }
    });

    expect((await turn(auth, "first")).status).toBe("completed");
    expect((await turn(auth, "second")).status).toBe("completed");

    let seen = await requests(log);
    expect(seen.map((request) => request.method)).not.toContain("authenticate");
    expect(new Set(seen.map((request) => request.pid)).size).toBe(1);
    const configs = seen.filter((request) => request.method === "session/set_config_option").map((request) => request.params);
    expect(configs).toContainEqual({ sessionId: "claude-session-1", configId: "model", value: "claude-opus-5-5" });
    expect(configs).toContainEqual({ sessionId: "claude-session-1", configId: "effort", value: "medium" });
    expect(seen[0]?.env).toEqual({
      model: "claude-opus-5-5", oauth: OAUTH, apiKey: undefined, configDir: join(root, ".claude")
    });
    expect(lines.join("\n")).not.toContain(OAUTH);

    const rotated = await materializeHarnessAuth(poolWith(ROTATED), "claude", root, secretKey, { PATH: process.env.PATH }, "claude-opus-5-5");
    expect(rotated.connectionTag).not.toBe(auth.connectionTag);
    expect((await turn(rotated, "third")).status).toBe("completed");
    seen = await requests(log);
    expect(new Set(seen.map((request) => request.pid)).size).toBe(2);
    expect(seen.at(-1)?.env.oauth).toBe(ROTATED);
  });
});

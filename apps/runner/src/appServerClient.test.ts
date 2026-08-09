import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeAllCodexAppServers,
  runCodexAppServerTurn,
  type AppServerTurnInput,
  type AppServerTurnOptions
} from "./appServerClient.js";

const cleanup: string[] = [];

afterEach(async () => {
  await closeAllCodexAppServers();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent Codex app-server", () => {
  it("reuses one app-server process across turns in the same runtime home", async () => {
    const fixture = await fakeAppServerFixture();
    const first = await runCodexAppServerTurn(turnOptions(fixture, "first"));
    const second = await runCodexAppServerTurn(turnOptions(fixture, "second", first.threadId));

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect((await readFile(fixture.startsFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("steers a message into an active turn", async () => {
    const fixture = await fakeAppServerFixture();
    const input: AppServerTurnInput = { id: "input-1", message: "verification-code" };
    let offered = false;
    let handled: { input: AppServerTurnInput; error?: string } | null = null;

    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "wait-for-steer"),
      nextInput: async () => {
        if (offered) return null;
        offered = true;
        return input;
      },
      onInputHandled: async (value, error) => {
        handled = { input: value, error };
      }
    });

    expect(result.status).toBe("completed");
    expect(handled).toEqual({ input });
    expect(result.rawStdout).toContain("verification-code");
  });

  it("interrupts an active turn when cancellation is requested", async () => {
    const fixture = await fakeAppServerFixture();
    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "wait-for-steer"),
      shouldCancel: async () => true
    });

    expect(result.status).toBe("interrupted");
  });
});

interface FakeFixture {
  directory: string;
  binary: string;
  startsFile: string;
}

async function fakeAppServerFixture(): Promise<FakeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "aisevak-app-server-test-"));
  cleanup.push(directory);
  const binary = join(directory, "fake-codex");
  const startsFile = join(directory, "starts");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(process.env.FAKE_STARTS_FILE, process.pid + "\\n");
let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    return send({ id: message.id, result: { thread: { id: message.params.threadId || "thread-1" } } });
  }
  if (message.method === "turn/start") {
    const turnId = "turn-" + (++turn);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
    if (message.params.input[0].text !== "wait-for-steer") {
      setTimeout(() => send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } }), 10);
    }
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: message.params.expectedTurnId, delta: message.params.input[0].text } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.expectedTurnId, status: "completed" } } }), 10);
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } });
  }
  if (message.method === "thread/backgroundTerminals/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  send({ id: message.id, result: {} });
});
`,
    { mode: 0o700 }
  );
  return { directory, binary, startsFile };
}

function turnOptions(
  fixture: FakeFixture,
  prompt: string,
  threadId?: string
): AppServerTurnOptions {
  return {
    codexBinary: fixture.binary,
    cwd: fixture.directory,
    codexHome: fixture.directory,
    model: "gpt-test",
    prompt,
    threadId,
    env: { ...process.env, FAKE_STARTS_FILE: fixture.startsFile },
    secrets: [],
    onLine: async () => {},
    onThreadId: async () => {},
    shouldCancel: async () => false
  };
}

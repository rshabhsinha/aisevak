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

  it("closes a provider session when cancellation never completes", async () => {
    const fixture = await fakeAppServerFixture();
    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "wait-for-steer"),
      env: { ...turnOptions(fixture, "wait-for-steer").env, FAKE_IGNORE_INTERRUPT: "1" },
      shouldCancel: async () => true,
      cancelGraceMs: 50
    });

    expect(result.status).toBe("interrupted");
  });

  it("redacts secrets from earlier turns throughout the persistent session", async () => {
    const fixture = await fakeAppServerFixture();
    const oldSecret = "old-secret-value";
    const firstOptions = turnOptions(fixture, "first");
    firstOptions.env.FAKE_OLD_SECRET = oldSecret;
    firstOptions.secrets = [oldSecret];
    const first = await runCodexAppServerTurn(firstOptions);
    const captured: string[] = [];
    const secondOptions = turnOptions(fixture, "emit-old-secret", first.threadId);
    secondOptions.env.FAKE_OLD_SECRET = oldSecret;
    secondOptions.secrets = ["new-secret-value"];
    secondOptions.onLine = async (line) => {
      captured.push(line);
    };

    const second = await runCodexAppServerTurn(secondOptions);

    expect(second.status).toBe("completed");
    expect(second.rawStdout).not.toContain(oldSecret);
    expect(captured.join("\n")).not.toContain(oldSecret);
    expect(second.rawStdout).toContain("[REDACTED]");
  });

  it("replaces a persistent session after its process exits", async () => {
    const fixture = await fakeAppServerFixture();
    const first = await runCodexAppServerTurn(turnOptions(fixture, "exit-after-turn"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await runCodexAppServerTurn(turnOptions(fixture, "second", first.threadId));

    expect(second.status).toBe("completed");
    expect((await readFile(fixture.startsFile, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("starts a replacement thread when the saved rollout is missing", async () => {
    const fixture = await fakeAppServerFixture();
    const seenThreadIds: string[] = [];
    const options = turnOptions(fixture, "recover-missing-rollout", "missing-thread");
    options.onThreadId = async (threadId) => {
      seenThreadIds.push(threadId);
    };

    const result = await runCodexAppServerTurn(options);

    expect(result.status).toBe("completed");
    expect(result.threadId).toBe("thread-1");
    expect(seenThreadIds.length).toBeGreaterThan(0);
    expect(new Set(seenThreadIds)).toEqual(new Set(["thread-1"]));
  });

  it("does not cross the presentation boundary when thread setup fails", async () => {
    const fixture = await fakeAppServerFixture();
    let turnAccepted = false;
    const options = turnOptions(fixture, "setup-failure", "broken-thread");
    options.onTurnAccepted = async () => {
      turnAccepted = true;
    };

    const result = await runCodexAppServerTurn(options);

    expect(result.status).toBe("failed");
    expect(result.promptMayHaveBeenPresented).toBe(false);
    expect(turnAccepted).toBe(false);
  });

  it("reports an ambiguous presentation when app-server exits after turn/start is sent", async () => {
    const fixture = await fakeAppServerFixture();
    let turnAccepted = false;
    const options = turnOptions(fixture, "exit-on-turn-start");
    options.onTurnAccepted = async () => {
      turnAccepted = true;
    };

    const result = await runCodexAppServerTurn(options);

    expect(result.status).toBe("failed");
    expect(result.promptMayHaveBeenPresented).toBe(true);
    expect(turnAccepted).toBe(false);
  });

  it("keeps an explicit turn/start rejection before the presentation boundary", async () => {
    const fixture = await fakeAppServerFixture();
    let turnAccepted = false;
    const options = turnOptions(fixture, "reject-turn-start", "thread-1");
    options.onTurnAccepted = async () => {
      turnAccepted = true;
    };

    const result = await runCodexAppServerTurn(options);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("turn rejected");
    expect(result.promptMayHaveBeenPresented).toBe(false);
    expect(turnAccepted).toBe(false);
  });

  it("notifies the runner after turn/start is accepted", async () => {
    const fixture = await fakeAppServerFixture();
    let acceptedCount = 0;
    const options = turnOptions(fixture, "accepted-turn");
    options.onTurnAccepted = async () => {
      acceptedCount += 1;
    };

    const result = await runCodexAppServerTurn(options);

    expect(result.status).toBe("completed");
    expect(result.promptMayHaveBeenPresented).toBe(true);
    expect(acceptedCount).toBe(1);
  });

  it("does not send turn/start after the ownership gate rejects the run", async () => {
    const fixture = await fakeAppServerFixture();
    let checks = 0;
    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "ownership-changed"),
      onBeforeTurnStart: async () => {
        checks += 1;
        return null;
      }
    });

    expect(result.status).toBe("interrupted");
    expect(result.promptMayHaveBeenPresented).toBe(false);
    expect(checks).toBe(1);
  });

  it("replaces the provider session when the post-launch ownership fence fails", async () => {
    const fixture = await fakeAppServerFixture();
    const options = turnOptions(fixture, "wait-for-steer");
    options.env.FAKE_REQUEST_ON_SIGTERM = "1";
    const first = await runCodexAppServerTurn({
      ...options,
      onBeforeTurnStart: async () => async () => {
        throw new Error("ownership fence commit failed");
      }
    });

    expect(first.status).toBe("failed");
    expect(first.error).toBe("ownership fence commit failed");
    expect(first.promptMayHaveBeenPresented).toBe(true);

    const second = await runCodexAppServerTurn(turnOptions(fixture, "second", first.threadId));

    expect(second.status).toBe("completed");
    expect((await readFile(fixture.startsFile, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("does not abandon a pending request when turn/start cannot be written", async () => {
    const fixture = await fakeAppServerFixture();
    const options = turnOptions(fixture, "send-after-close");
    options.env.FAKE_EXIT_AFTER_THREAD_START = "1";
    options.onThreadId = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const result = await runCodexAppServerTurn(options);

    expect(result.status).toBe("failed");
    expect(result.promptMayHaveBeenPresented).toBe(false);
    expect(result.error).toMatch(/stdin is closed|app-server exited/);
  });

  it("quarantines asynchronous provider stdin failures", async () => {
    const fixture = await fakeAppServerFixture();
    const options = turnOptions(fixture, "write-after-stdin-close");
    options.env.FAKE_CLOSE_STDIN_AFTER_THREAD_START = "1";
    options.onThreadId = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const first = await runCodexAppServerTurn(options);
    const second = await runCodexAppServerTurn(turnOptions(fixture, "second", first.threadId));

    expect(first.status).toBe("failed");
    expect(second.status).toBe("completed");
    expect((await readFile(fixture.startsFile, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("contains delayed event-write rejection before a provider turn completes", async () => {
    const fixture = await fakeAppServerFixture();
    const unrelated = await fakeAppServerFixture();
    const secret = "fixture-persistence-secret";
    const failedOptions = turnOptions(fixture, "wait-for-steer");
    failedOptions.secrets = [secret];
    failedOptions.onLine = async (line) => {
      if (JSON.parse(line).method !== "turn/started") return;
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error(`database unavailable ${secret}`);
    };

    const [failed, independent] = await Promise.all([
      runCodexAppServerTurn(failedOptions),
      runCodexAppServerTurn(turnOptions(unrelated, "independent"))
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Codex event persistence failed: database unavailable [REDACTED]");
    expect(failed.promptMayHaveBeenPresented).toBe(true);
    expect(independent.status).toBe("completed");
    // The original provider never sent turn/completed. Returning proves the
    // failure was observed while active; Vitest also rejects unhandled errors.
    expect(failed.rawStdout).not.toContain('"method":"turn/completed"');
    const replacement = await runCodexAppServerTurn(turnOptions(fixture, "replacement", failed.threadId));
    expect(replacement.status).toBe("completed");
    expect((await readFile(fixture.startsFile, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("does not persist later events or report success after an earlier delayed write fails", async () => {
    const fixture = await fakeAppServerFixture();
    const persisted: string[] = [];
    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "complete-before-write-failure"),
      onLine: async (line) => {
        const method = JSON.parse(line).method;
        if (method === "turn/started") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("late DB write failed");
        }
        if (method) persisted.push(method);
      }
    });
    expect(result.rawStdout).toContain('"method":"turn/completed"');
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Codex event persistence failed: late DB write failed");
    expect(persisted).not.toContain("turn/completed");
  });

  it.each([200, 5000])("waits for actual quarantined process exit with SIGTERM delay %i ms", async (delay) => {
    const fixture = await fakeAppServerFixture();
    const options = turnOptions(fixture, "complete-before-delayed-quarantine");
    options.env.FAKE_DELAY_SIGTERM_MS = String(delay);
    options.onLine = async (line) => {
      if (JSON.parse(line).method !== "turn/started") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("late write failure");
    };
    const result = await runCodexAppServerTurn(options);
    const firstPid = Number((await readFile(fixture.startsFile, "utf8")).trim());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Codex event persistence failed: late write failure");
    expect(result.rawStdout).toContain('"method":"turn/completed"');
    expect(() => process.kill(firstPid, 0)).toThrow();
    // 5000 ms exercises the SIGKILL fallback; 200 ms exits via SIGTERM.
    const replacement = await runCodexAppServerTurn(turnOptions(fixture, "replacement", result.threadId));
    expect(replacement.status).toBe("completed");
    expect((await readFile(fixture.startsFile, "utf8")).trim().split("\n")).toHaveLength(2);
  }, 10000);

  it("waits for successful delayed event persistence in original sequence", async () => {
    const fixture = await fakeAppServerFixture();
    const persisted: number[] = [];
    let finalPersisted = false;
    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "ordered-writes"),
      onLine: async (line, seq) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        persisted.push(seq);
        if (JSON.parse(line).method === "turn/completed") finalPersisted = true;
      }
    });
    expect(result.status).toBe("completed");
    expect(finalPersisted).toBe(true);
    expect(persisted).toEqual(persisted.map((_, index) => index));
    expect(persisted.length).toBeGreaterThan(3);
  });

  it("contains an asynchronously rejected thread-identity event", async () => {
    const fixture = await fakeAppServerFixture();
    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "wait-for-steer"),
      onThreadId: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error("identity persistence failed");
      }
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("identity persistence failed");
    expect(result.promptMayHaveBeenPresented).toBe(false);
  });

  it("contains delayed monitor persistence failure without waiting for completion", async () => {
    const fixture = await fakeAppServerFixture();
    const result = await runCodexAppServerTurn({
      ...turnOptions(fixture, "wait-for-steer"),
      nextInput: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("delivery claim failed");
      }
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Codex turn monitor failed: delivery claim failed");
    expect(result.rawStdout).not.toContain('"method":"turn/completed"');
  });

  it("waits for persistence of a late reply generated by the final in-flight monitor", async () => {
    const fixture = await fakeAppServerFixture();
    const options = turnOptions(fixture, "complete-after-monitor-start");
    options.env.FAKE_REJECT_LATE_STEER = "1";
    let offered = false;
    options.nextInput = async () => {
      if (offered) return null;
      offered = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { id: "late-input", message: "arrives after completion" };
    };
    options.onLine = async (line) => {
      if (JSON.parse(line).error?.message !== "turn already completed") return;
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw new Error("late steer reply persistence failed");
    };
    const result = await runCodexAppServerTurn(options);
    expect(result.rawStdout).toContain('"method":"turn/completed"');
    expect(result.rawStdout).toContain("turn already completed");
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Codex event persistence failed: late steer reply persistence failed");
  });

  it("retains redacted stderr when quarantine closes before monitor persistence finishes", async () => {
    const fixture = await fakeAppServerFixture();
    const options = turnOptions(fixture, "complete-after-monitor-start");
    options.env.FAKE_STDERR_LINE = "fixture diagnostic fixture-only-stderr-secret";
    options.secrets = ["fixture-only-stderr-secret"];
    options.nextInput = async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return null;
    };
    options.onLine = async (line) => {
      if (JSON.parse(line).method !== "turn/completed") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("completion write failed");
    };
    const result = await runCodexAppServerTurn(options);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Codex event persistence failed: completion write failed");
    expect(result.rawStderr).toBe("fixture diagnostic [REDACTED]\n");
    expect(result.rawStderr).not.toContain("fixture-only-stderr-secret");
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
if (process.env.FAKE_DELAY_SIGTERM_MS) setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  if (process.env.FAKE_DELAY_SIGTERM_MS) {
    return setTimeout(() => process.exit(0), Number(process.env.FAKE_DELAY_SIGTERM_MS));
  }
  if (process.env.FAKE_REQUEST_ON_SIGTERM === "1") {
    send({ id: "late-approval", method: "item/commandExecution/requestApproval", params: {} });
    return setTimeout(() => process.exit(0), 10);
  }
  process.exit(0);
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/resume" && message.params.threadId === "missing-thread") {
    return send({ id: message.id, error: { code: -32602, message: "no rollout found for thread id missing-thread" } });
  }
  if (message.method === "thread/resume" && message.params.threadId === "broken-thread") {
    return send({ id: message.id, error: { code: -32603, message: "thread setup failed" } });
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId || "thread-1" } } });
    if (message.method === "thread/start" && process.env.FAKE_EXIT_AFTER_THREAD_START === "1") {
      setTimeout(() => process.exit(0), 10);
    }
    if (message.method === "thread/start" && process.env.FAKE_CLOSE_STDIN_AFTER_THREAD_START === "1") {
      setInterval(() => {}, 1000);
      setTimeout(() => fs.closeSync(0), 10);
    }
    return;
  }
  if (message.method === "turn/start") {
    const turnId = "turn-" + (++turn);
    const prompt = message.params.input[0].text;
    if (process.env.FAKE_STDERR_LINE) process.stderr.write(process.env.FAKE_STDERR_LINE + "\\n");
    if (prompt === "exit-on-turn-start") return process.exit(0);
    if (prompt === "reject-turn-start") {
      return send({ id: message.id, error: { code: -32602, message: "turn rejected" } });
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
    if (prompt === "emit-old-secret") {
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, delta: process.env.FAKE_OLD_SECRET } });
    }
    if (prompt !== "wait-for-steer") {
      setTimeout(() => send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } }), prompt === "complete-after-monitor-start" ? 800 : 10);
    }
    if (prompt === "exit-after-turn") setTimeout(() => process.exit(0), 20);
    return;
  }
  if (message.method === "turn/steer") {
    if (process.env.FAKE_REJECT_LATE_STEER === "1") {
      return send({ id: message.id, error: { code: -32602, message: "turn already completed" } });
    }
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: message.params.expectedTurnId, delta: message.params.input[0].text } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.expectedTurnId, status: "completed" } } }), 10);
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (process.env.FAKE_IGNORE_INTERRUPT === "1") return;
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

import { buildCodexAppServerArgs } from "@aisevak/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface AppServerTurnOptions {
  codexBinary: string;
  cwd: string;
  codexHome: string;
  model: string;
  prompt: string;
  threadId?: string | null;
  env: NodeJS.ProcessEnv;
  secrets: Array<string | null | undefined>;
  onLine: (line: string, seq: number) => Promise<void>;
  onThreadId: (threadId: string) => Promise<void>;
  shouldCancel: () => Promise<boolean>;
}

export interface AppServerTurnResult {
  status: "completed" | "failed" | "interrupted";
  threadId: string;
  turnId: string | null;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
  error: string | null;
}

export async function runCodexAppServerTurn(options: AppServerTurnOptions): Promise<AppServerTurnResult> {
  const child = spawn(options.codexBinary, buildCodexAppServerArgs(), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let rawStdout = "";
  let rawStderr = "";
  let stdoutBuffer = "";
  let seq = 0;
  let nextId = 1;
  let threadId = options.threadId ?? null;
  let turnId: string | null = null;
  let completed = false;
  let finalStatus: AppServerTurnResult["status"] | null = null;
  let finalError: string | null = null;
  let eventChain = Promise.resolve();
  const pending = new Map<string, PendingRequest>();

  const closePromise = new Promise<number | null>((resolve, reject) => {
    child.on("error", (error) => {
      for (const [id] of pending) {
        rejectPending(id, error);
      }
      reject(error);
    });
    child.on("close", (code) => {
      for (const [id] of pending) {
        rejectPending(id, new Error(`app-server exited before request resolved with code ${code ?? "null"}`));
      }
      resolve(code);
    });
  });

  const turnCompletedPromise = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk) => {
      const text = redactText(String(chunk), options.secrets);
      rawStdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line, resolve);
      }
    });
  });

  child.stderr.on("data", (chunk) => {
    rawStderr += redactText(String(chunk), options.secrets);
  });

  function send(message: unknown): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `aisevak-${nextId++}`;
    const timeout = setTimeout(() => {
      rejectPending(id, new Error(`Timed out waiting for app-server response to ${method}`));
    }, 30_000);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject, timeout });
    });
    send({ id, method, params });
    return promise;
  }

  function rejectPending(id: string, error: Error): void {
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    pending.delete(id);
    waiter.reject(error);
  }

  function resolvePending(id: string, value: Record<string, unknown>): void {
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    pending.delete(id);
    waiter.resolve(value);
  }

  function handleLine(line: string, resolveTurnCompleted: () => void): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const currentSeq = seq++;
    eventChain = eventChain.then(() => options.onLine(trimmed, currentSeq));

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }

    const maybeThreadId = extractThreadId(message);
    if (maybeThreadId && maybeThreadId !== threadId) {
      threadId = maybeThreadId;
      eventChain = eventChain.then(() => options.onThreadId(maybeThreadId));
    }

    if (message.method && message.id !== undefined) {
      handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const id = String(message.id);
      if (message.error) {
        rejectPending(id, new Error(message.error.message ?? `app-server request ${id} failed`));
      } else {
        resolvePending(id, message.result ?? {});
      }
      return;
    }

    if (message.method === "turn/started") {
      turnId = extractTurnId(message) ?? turnId;
      return;
    }

    if (message.method === "turn/completed") {
      const completedTurnId = extractTurnId(message);
      if (turnId && completedTurnId && completedTurnId !== turnId) return;
      completed = true;
      finalStatus = mapTurnStatus(message);
      finalError = extractTurnError(message);
      resolveTurnCompleted();
    }
  }

  function handleServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || !message.method) return;
    const id = message.id;
    if (message.method === "item/commandExecution/requestApproval") {
      send({ id, result: { decision: "acceptForSession" } });
      return;
    }
    if (message.method === "item/fileChange/requestApproval") {
      send({ id, result: { decision: "acceptForSession" } });
      return;
    }
    if (message.method === "applyPatchApproval" || message.method === "execCommandApproval") {
      send({ id, result: { decision: "approved_for_session" } });
      return;
    }
    if (message.method === "item/permissions/requestApproval") {
      send({
        id,
        result: {
          permissions: {
            fileSystem: {
              read: null,
              write: null,
              entries: [
                {
                  access: "write",
                  path: { type: "special", value: { kind: "root" } }
                }
              ]
            },
            network: { enabled: true }
          },
          scope: "session",
          strictAutoReview: false
        }
      });
      return;
    }
    send({
      id,
      error: {
        code: -32601,
        message: `Aisevak runner does not handle app-server request ${message.method}`
      }
    });
  }

  try {
    await request("initialize", {
      clientInfo: { name: "aisevak", title: "Aisevak", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    send({ method: "initialized" });

    const threadParams = {
      model: explicitModel(options.model),
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: "aisevak",
      persistExtendedHistory: false
    };
    const threadResponse = threadId
      ? await request("thread/resume", { ...threadParams, threadId, excludeTurns: true })
      : await request("thread/start", { ...threadParams, experimentalRawEvents: false });
    threadId = extractThreadId({ result: threadResponse }) ?? threadId;
    if (!threadId) throw new Error("app-server did not return a thread id");
    await options.onThreadId(threadId);

    const turnResponse = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      cwd: options.cwd,
      model: explicitModel(options.model),
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
    turnId = stringValue(recordValue(turnResponse.turn)?.id) ?? turnId;

    let interruptSent = false;
    const cancellation = setInterval(async () => {
      if (interruptSent || !threadId || !turnId) return;
      if (!(await options.shouldCancel())) return;
      interruptSent = true;
      try {
        await request("turn/interrupt", { threadId, turnId });
      } catch {
        child.kill("SIGTERM");
      }
    }, 1000);

    const closeOrTurn = await Promise.race([
      turnCompletedPromise.then(() => "turn" as const),
      closePromise.then((code) => ({ code }))
    ]);
    clearInterval(cancellation);
    if (typeof closeOrTurn === "object" && !completed) {
      throw new Error(`app-server exited before turn completed with code ${closeOrTurn.code ?? "null"}`);
    }

    if (stdoutBuffer.trim()) {
      handleLine(stdoutBuffer, () => undefined);
      stdoutBuffer = "";
    }
    await eventChain;

    return {
      status: finalStatus ?? "failed",
      threadId,
      turnId,
      rawStdout,
      rawStderr,
      exitCode: 0,
      error: finalError
    };
  } catch (error) {
    await eventChain.catch(() => undefined);
    return {
      status: "failed",
      threadId: threadId ?? "",
      turnId,
      rawStdout,
      rawStderr,
      exitCode: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timeout);
      pending.delete(id);
      waiter.reject(new Error("app-server turn finished before request resolved"));
    }
    await stopChild(child, closePromise);
  }
}

function mapTurnStatus(message: JsonRpcMessage): AppServerTurnResult["status"] {
  const turn = recordValue(message.params?.turn);
  const status = stringValue(turn?.status);
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function extractTurnError(message: JsonRpcMessage): string | null {
  const turn = recordValue(message.params?.turn);
  const error = recordValue(turn?.error);
  return stringValue(error?.message) ?? null;
}

function extractThreadId(message: JsonRpcMessage): string | undefined {
  const params = recordValue(message.params);
  const result = recordValue(message.result);
  return (
    stringValue(params?.threadId) ??
    stringValue(recordValue(params?.thread)?.id) ??
    stringValue(recordValue(result?.thread)?.id)
  );
}

function extractTurnId(message: JsonRpcMessage): string | undefined {
  const params = recordValue(message.params);
  return stringValue(params?.turnId) ?? stringValue(recordValue(params?.turn)?.id);
}

function explicitModel(model: string | null | undefined): string | null {
  return model && !["default", "auto", "codex-default"].includes(model.trim().toLowerCase())
    ? model
    : null;
}

function redactText(text: string, secrets: Array<string | null | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  closePromise: Promise<number | null>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  child.kill("SIGTERM");
  await Promise.race([closePromise.catch(() => null), sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

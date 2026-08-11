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

export interface AppServerTurnInput {
  id: string;
  message: string;
}

export interface AppServerTurnOptions {
  codexBinary: string;
  cwd: string;
  codexHome: string;
  model: string;
  modelOptions?: Array<{ id: string; value: string | number | boolean }>;
  prompt: string;
  threadId?: string | null;
  env: NodeJS.ProcessEnv;
  secrets: Array<string | null | undefined>;
  onLine: (line: string, seq: number) => Promise<void>;
  onThreadId: (threadId: string) => Promise<void>;
  shouldCancel: () => Promise<boolean>;
  nextInput?: () => Promise<AppServerTurnInput | null>;
  onInputHandled?: (input: AppServerTurnInput, error?: string) => Promise<void>;
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

interface TurnState {
  options: AppServerTurnOptions;
  threadId: string | null;
  turnId: string | null;
  seq: number;
  rawStdout: string;
  stderrStart: number;
  completed: boolean;
  finalStatus: AppServerTurnResult["status"] | null;
  finalError: string | null;
  eventChain: Promise<void>;
  resolveCompleted: () => void;
  completedPromise: Promise<void>;
}

const sessions = new Map<string, PersistentAppServer>();
const idleSessionMs = positiveNumber(process.env.CODEX_APP_SERVER_IDLE_MS, 60 * 60 * 1000);
const backgroundRecheckMs = Math.min(idleSessionMs, 10 * 60 * 1000);

export async function runCodexAppServerTurn(options: AppServerTurnOptions): Promise<AppServerTurnResult> {
  let session = sessions.get(options.codexHome);
  if (session && !session.matches(options)) {
    sessions.delete(options.codexHome);
    await session.close();
    session = undefined;
  }
  if (!session) {
    session = new PersistentAppServer(options, () => {
      if (sessions.get(options.codexHome) === session) sessions.delete(options.codexHome);
    });
    sessions.set(options.codexHome, session);
  }
  return session.runTurn(options);
}

export async function closeAllCodexAppServers(): Promise<void> {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map((session) => session.close()));
}

class PersistentAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connectionKey: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly loadedThreads = new Set<string>();
  private readonly turnStates = new Map<string, TurnState>();
  private readonly redactionSecrets = new Set<string>();
  private readonly closePromise: Promise<{ code: number | null; error?: Error }>;
  private stdoutBuffer = "";
  private rawStderr = "";
  private nextId = 1;
  private activeTurn: TurnState | null = null;
  private initializePromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: AppServerTurnOptions, onClose: () => void) {
    this.connectionKey = appServerConnectionKey(options);
    this.addSecrets(options.secrets);
    this.child = spawn(options.codexBinary, buildCodexAppServerArgs(), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.closePromise = new Promise((resolve) => {
      this.child.on("error", (error) => {
        this.rejectPending(error);
        resolve({ code: null, error });
      });
      this.child.on("close", (code) => {
        this.rejectPending(new Error(`app-server exited with code ${code ?? "null"}`));
        resolve({ code });
        onClose();
      });
    });

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += String(chunk);
      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line);
    });
    this.child.stderr.on("data", (chunk) => {
      this.rawStderr += redactText(String(chunk), [...this.redactionSecrets]);
    });
  }

  matches(options: AppServerTurnOptions): boolean {
    return !this.closed &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.child.stdin.writable &&
      this.connectionKey === appServerConnectionKey(options);
  }

  async runTurn(options: AppServerTurnOptions): Promise<AppServerTurnResult> {
    if (this.activeTurn) throw new Error(`Codex app-server ${options.codexHome} already has an active turn`);
    if (this.closed) throw new Error(`Codex app-server ${options.codexHome} is closed`);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.addSecrets(options.secrets);
    this.rawStderr = "";

    let resolveCompleted: () => void = () => {};
    const completedPromise = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const state: TurnState = {
      options,
      threadId: options.threadId ?? null,
      turnId: null,
      seq: 0,
      rawStdout: "",
      stderrStart: 0,
      completed: false,
      finalStatus: null,
      finalError: null,
      eventChain: Promise.resolve(),
      resolveCompleted,
      completedPromise
    };
    this.activeTurn = state;

    let monitor: NodeJS.Timeout | null = null;
    let monitorTask: Promise<void> = Promise.resolve();
    try {
      await this.initialize();
      const threadParams = {
        model: explicitModel(options.model),
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        serviceName: "aisevak",
        persistExtendedHistory: false
      };
      if (state.threadId) {
        if (!this.loadedThreads.has(state.threadId)) {
          try {
            const response = await this.request("thread/resume", {
              ...threadParams,
              threadId: state.threadId,
              excludeTurns: true
            });
            state.threadId = extractThreadId({ result: response }) ?? state.threadId;
          } catch (error) {
            if (!isMissingRolloutError(error)) throw error;
            state.threadId = null;
          }
        }
      }
      if (!state.threadId) {
        const response = await this.request("thread/start", {
          ...threadParams,
          experimentalRawEvents: false
        });
        state.threadId = extractThreadId({ result: response }) ?? null;
      }
      if (!state.threadId) throw new Error("app-server did not return a thread id");
      this.loadedThreads.add(state.threadId);
      await options.onThreadId(state.threadId);

      const turnResponse = await this.request("turn/start", {
        threadId: state.threadId,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
        cwd: options.cwd,
        model: explicitModel(options.model),
        ...(stringModelOption(options.modelOptions, "reasoningEffort")
          ? { effort: stringModelOption(options.modelOptions, "reasoningEffort") }
          : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" }
      });
      this.bindTurnId(state, extractTurnId({ result: turnResponse }));
      if (!state.turnId) throw new Error("app-server did not return a turn id");

      let monitorBusy = false;
      let interruptSent = false;
      monitor = setInterval(() => {
        if (monitorBusy || state.completed) return;
        monitorBusy = true;
        monitorTask = this.monitorTurn(state, interruptSent)
          .then((interrupted) => {
            interruptSent ||= interrupted;
          })
          .finally(() => {
            monitorBusy = false;
          });
      }, 750);

      const closeOrTurn = await Promise.race([
        state.completedPromise.then(() => ({ kind: "turn" as const })),
        this.closePromise.then((closed) => ({ kind: "close" as const, ...closed }))
      ]);
      if (closeOrTurn.kind === "close" && !state.completed) {
        throw closeOrTurn.error ?? new Error(`app-server exited before turn completed with code ${closeOrTurn.code ?? "null"}`);
      }
      await state.eventChain;

      return {
        status: state.finalStatus ?? "failed",
        threadId: state.threadId,
        turnId: state.turnId,
        rawStdout: state.rawStdout,
        rawStderr: this.rawStderr.slice(state.stderrStart),
        exitCode: 0,
        error: state.finalError
      };
    } catch (error) {
      await state.eventChain.catch(() => undefined);
      return {
        status: "failed",
        threadId: state.threadId ?? "",
        turnId: state.turnId,
        rawStdout: state.rawStdout,
        rawStderr: this.rawStderr.slice(state.stderrStart),
        exitCode: null,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (monitor) clearInterval(monitor);
      await monitorTask.catch(() => undefined);
      if (state.turnId && this.turnStates.get(state.turnId) === state) {
        this.turnStates.delete(state.turnId);
      }
      if (this.activeTurn === state) this.activeTurn = null;
      this.scheduleIdleCheck(idleSessionMs);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.rejectPending(new Error("app-server session closed"));
    await stopChild(this.child, this.closePromise.then(({ code }) => code));
    this.turnStates.clear();
    this.loadedThreads.clear();
    this.redactionSecrets.clear();
    this.stdoutBuffer = "";
    this.rawStderr = "";
  }

  private async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await this.request("initialize", {
          clientInfo: { name: "aisevak", title: "Aisevak", version: "0.1.0" },
          capabilities: { experimentalApi: true }
        });
        this.send({ method: "initialized" });
      })();
    }
    return this.initializePromise;
  }

  private async monitorTurn(state: TurnState, interruptSent: boolean): Promise<boolean> {
    if (!state.threadId || !state.turnId) return interruptSent;
    if (!interruptSent && await state.options.shouldCancel()) {
      try {
        await this.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId });
      } catch {
        await this.close();
      }
      return true;
    }
    if (interruptSent || !state.options.nextInput) return interruptSent;
    const input = await state.options.nextInput();
    if (!input) return interruptSent;
    try {
      const response = await this.request("turn/steer", {
        threadId: state.threadId,
        expectedTurnId: state.turnId,
        input: [{ type: "text", text: input.message, text_elements: [] }]
      });
      this.bindTurnId(state, extractTurnId({ result: response }));
      await state.options.onInputHandled?.(input);
    } catch (error) {
      await state.options.onInputHandled?.(
        input,
        error instanceof Error ? error.message : String(error)
      );
    }
    return interruptSent;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      const state = this.activeTurn;
      if (state) this.captureLine(state, trimmed);
      return;
    }

    const messageTurnId = extractTurnId(message);
    const state = (messageTurnId ? this.turnStates.get(messageTurnId) : null) ?? this.activeTurn;
    if (state) this.captureLine(state, trimmed);

    const maybeThreadId = extractThreadId(message);
    if (state && maybeThreadId && maybeThreadId !== state.threadId) {
      state.threadId = maybeThreadId;
      this.loadedThreads.add(maybeThreadId);
      state.eventChain = state.eventChain.then(() => state.options.onThreadId(maybeThreadId));
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const id = String(message.id);
      if (message.error) {
        this.rejectOne(id, new Error(message.error.message ?? `app-server request ${id} failed`));
      } else {
        this.resolveOne(id, message.result ?? {});
      }
      return;
    }
    if (message.method === "turn/started") {
      if (state) this.bindTurnId(state, messageTurnId);
      return;
    }
    if (message.method === "turn/completed") {
      const completedState = (messageTurnId ? this.turnStates.get(messageTurnId) : null) ?? state;
      if (!completedState || completedState.completed) return;
      completedState.completed = true;
      completedState.finalStatus = mapTurnStatus(message);
      completedState.finalError = extractTurnError(message);
      completedState.resolveCompleted();
    }
  }

  private captureLine(state: TurnState, line: string): void {
    const redacted = redactText(line, [...this.redactionSecrets]);
    state.rawStdout += `${redacted}\n`;
    const seq = state.seq++;
    state.eventChain = state.eventChain.then(() => state.options.onLine(redacted, seq));
  }

  private bindTurnId(state: TurnState, turnId: string | undefined): void {
    if (!turnId || turnId === state.turnId) return;
    if (state.turnId) this.turnStates.delete(state.turnId);
    state.turnId = turnId;
    this.turnStates.set(turnId, state);
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || !message.method) return;
    const id = message.id;
    if (message.method === "item/commandExecution/requestApproval") {
      this.send({ id, result: { decision: "acceptForSession" } });
      return;
    }
    if (message.method === "item/fileChange/requestApproval") {
      this.send({ id, result: { decision: "acceptForSession" } });
      return;
    }
    if (message.method === "applyPatchApproval" || message.method === "execCommandApproval") {
      this.send({ id, result: { decision: "approved_for_session" } });
      return;
    }
    if (message.method === "item/permissions/requestApproval") {
      this.send({
        id,
        result: {
          permissions: {
            fileSystem: {
              read: null,
              write: null,
              entries: [{ access: "write", path: { type: "special", value: { kind: "root" } } }]
            },
            network: { enabled: true }
          },
          scope: "session",
          strictAutoReview: false
        }
      });
      return;
    }
    this.send({
      id,
      error: { code: -32601, message: `Aisevak runner does not handle app-server request ${message.method}` }
    });
  }

  private send(message: unknown): void {
    if (this.closed || !this.child.stdin.writable) throw new Error("app-server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `aisevak-${this.nextId++}`;
    const timeout = setTimeout(() => {
      this.rejectOne(id, new Error(`Timed out waiting for app-server response to ${method}`));
    }, 30_000);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.send({ id, method, params });
    return promise;
  }

  private rejectOne(id: string, error: Error): void {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.pending.delete(id);
    waiter.reject(error);
  }

  private resolveOne(id: string, value: Record<string, unknown>): void {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.pending.delete(id);
    waiter.resolve(value);
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) this.rejectOne(id, error);
  }

  private addSecrets(secrets: Array<string | null | undefined>): void {
    for (const secret of secrets) if (secret && secret.length >= 6) this.redactionSecrets.add(secret);
  }

  private scheduleIdleCheck(delay: number): void {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.closeIfIdle();
    }, delay);
    this.idleTimer.unref();
  }

  private async closeIfIdle(): Promise<void> {
    this.idleTimer = null;
    if (this.activeTurn || this.closed) return;
    try {
      for (const threadId of this.loadedThreads) {
        const response = await this.request("thread/backgroundTerminals/list", { threadId, limit: 1 });
        if (Array.isArray(response.data) && response.data.length > 0) {
          this.scheduleIdleCheck(backgroundRecheckMs);
          return;
        }
      }
    } catch {
      // A dead or incompatible app-server is safe to replace on the next turn.
    }
    await this.close();
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
    stringValue(result?.threadId) ??
    stringValue(recordValue(result?.thread)?.id)
  );
}

function extractTurnId(message: JsonRpcMessage): string | undefined {
  const params = recordValue(message.params);
  const result = recordValue(message.result);
  return (
    stringValue(params?.turnId) ??
    stringValue(recordValue(params?.turn)?.id) ??
    stringValue(result?.turnId) ??
    stringValue(recordValue(result?.turn)?.id)
  );
}

function explicitModel(model: string | null | undefined): string | null {
  return model && !["default", "auto", "codex-default"].includes(model.trim().toLowerCase())
    ? model
    : null;
}

function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id/i.test(message);
}

function stringModelOption(
  options: AppServerTurnOptions["modelOptions"],
  id: string
): string | undefined {
  const value = options?.find((option) => option.id === id)?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function appServerConnectionKey(options: AppServerTurnOptions): string {
  const environment = Object.entries(options.env)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([options.codexBinary, options.cwd, environment]);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  closePromise: Promise<number | null>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  child.kill("SIGTERM");
  await Promise.race([closePromise.catch(() => null), sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

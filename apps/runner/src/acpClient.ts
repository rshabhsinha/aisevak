import {
  acpPermissionDecision,
  buildAcpInitializeParams,
  extractAcpSessionId,
  normalizeAcpEvent,
  parseCodexJsonLine,
  redactSecrets
} from "@aisevak/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppServerTurnInput, AppServerTurnOptions, AppServerTurnResult } from "./appServerClient.js";

export interface AcpTurnOptions extends Omit<AppServerTurnOptions, "codexBinary" | "codexHome"> {
  binary: string;
  args: string[];
  runtimeHome: string;
  authMethodId?: string | null;
  // ACP `authenticate` parameter (sent as _meta.api_key). Devin requires this —
  // it intentionally does not read CLI credentials in ACP mode.
  apiKey?: string | null;
}

const sessions = new Map<string, PersistentAcpSession>();
const ACP_SESSION_IDLE_MS = 30 * 60_000;

export async function runAcpTurn(options: AcpTurnOptions): Promise<AppServerTurnResult> {
  const key = options.runtimeHome;
  await closeIdleAcpSessions(key);
  let session = sessions.get(key);
  if (session && !session.matches(options)) {
    sessions.delete(key);
    await session.close();
    session = undefined;
  }
  if (!session) {
    session = new PersistentAcpSession(options, () => {
      if (sessions.get(key) === session) sessions.delete(key);
    });
    sessions.set(key, session);
  }
  return session.runTurn(options);
}

export async function closeAllAcpSessions(): Promise<void> {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map((session) => session.close()));
}

export async function closeIdleAcpSessions(exceptKey?: string, idleMs = ACP_SESSION_IDLE_MS): Promise<void> {
  const now = Date.now();
  const stale: Array<Promise<void>> = [];
  for (const [key, session] of sessions) {
    if (key !== exceptKey && !session.isRunning && now - session.lastUsedAt > idleMs) {
      sessions.delete(key);
      stale.push(session.close());
    }
  }
  await Promise.all(stale);
}

export function cachedAcpProcessIds(homes: string[] = [...sessions.keys()]): number[] {
  return homes.flatMap(home => { const pid = sessions.get(home)?.processId; return pid ? [pid] : []; });
}
export async function closeIdleAcpSession(home: string): Promise<boolean> {
  const session = sessions.get(home);
  if (!session) return true;
  if (session.isRunning) return false;
  await session.close();
  if (sessions.get(home) === session) sessions.delete(home);
  return true;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class PersistentAcpSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly connectionKey: string;
  private stdoutBuffer = "";
  private rawStderr = "";
  private nextId = 1;
  private closed = false;
  private initializePromise: Promise<void> | null = null;
  private sessionId: string | null = null;
  lastUsedAt = Date.now();
  isRunning = false;
  private lastActivityAt = Date.now();
  private readonly closePromise: Promise<{ code: number | null; error?: Error }>;
  private onNotification: ((line: string) => Promise<void>) | null = null;

  get processId(): number | undefined { return this.child.pid; }

  constructor(
    private readonly initial: AcpTurnOptions,
    onClose: () => void
  ) {
    this.connectionKey = JSON.stringify([initial.binary, initial.args, initial.cwd, initial.runtimeHome, initial.apiKey ?? null]);
    this.child = spawn(initial.binary, initial.args, {
      cwd: initial.cwd,
      env: initial.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.closePromise = new Promise((resolve) => {
      this.child.on("error", (error) => {
        this.rejectPending(error);
        resolve({ code: null, error });
      });
      this.child.on("close", (code) => {
        this.rejectPending(new Error(`ACP harness exited with code ${code ?? "null"}`));
        resolve({ code });
        onClose();
      });
    });
    this.child.stdin.on("error", (error) => {
      this.rejectPending(error);
      void this.close().catch(() => undefined);
    });
    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += String(chunk);
      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line);
    });
    this.child.stderr.on("data", (chunk) => {
      this.rawStderr += String(chunk);
    });
  }

  matches(options: AcpTurnOptions): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null &&
      this.connectionKey === JSON.stringify([options.binary, options.args, options.cwd, options.runtimeHome, options.apiKey ?? null]);
  }

  private apiKey: string | null = null;

  async runTurn(options: AcpTurnOptions): Promise<AppServerTurnResult> {
    if (this.isRunning) throw new Error("ACP session already has an active turn");
    this.isRunning = true;
    let seq = 0;
    let promptMayHaveBeenPresented = false;
    let cancelRequested = false;
    const rawLines: string[] = [];
    let loadingSession = false;
    const emit = async (line: string) => {
      if (loadingSession) {
        try {
          const raw = JSON.parse(line);
          if (raw && typeof raw === "object") line = JSON.stringify({ ...raw, aisevakReplay: true });
        } catch { /* Keep malformed output for the controlled parse-error path. */ }
      }
      seq += 1;
      rawLines.push(line);
      await options.onLine(redactSecrets(line, options.secrets), seq);
    };

    this.onNotification = emit;
    this.lastUsedAt = Date.now();
    this.apiKey = options.apiKey ?? null;
    try {
      await this.initialize(options.authMethodId);
      if (options.threadId) {
        loadingSession = true;
        try {
          await this.request("session/load", {
            sessionId: options.threadId,
            cwd: options.cwd,
            mcpServers: []
          });
          this.sessionId = options.threadId;
        } catch (error) {
          if (this.closed) throw error;
          console.warn("ACP session/load failed; starting a fresh session and orphaning prior context", {
            threadId: options.threadId,
            error: error instanceof Error ? error.message : String(error)
          });
          this.sessionId = null;
        } finally {
          loadingSession = false;
        }
      }
      if (!this.sessionId) {
        const created = await this.request("session/new", { cwd: options.cwd, mcpServers: [] });
        this.sessionId = extractAcpSessionId(created) ?? null;
      }
      if (!this.sessionId) throw new Error("ACP harness did not return a session id");
      await options.onThreadId(this.sessionId);
      await this.applyModel(options);

      const release = await options.onBeforeTurnStart?.();
      if (options.onBeforeTurnStart && !release) {
        return {
          status: "interrupted",
          threadId: this.sessionId,
          turnId: null,
          rawStdout: rawLines.join("\n"),
          rawStderr: this.rawStderr,
          exitCode: null,
          error: "provider turn cancelled because run ownership changed before launch",
          promptMayHaveBeenPresented: false
        };
      }

      const promptRequest = this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: options.prompt }]
      }, true);
      void promptRequest.catch(() => undefined);
      promptMayHaveBeenPresented = true;
      try {
        await release?.();
      } catch (error) {
        await this.close().catch(() => undefined);
        await promptRequest.catch(() => undefined);
        throw error;
      }

      await options.onTurnAccepted?.();

      const monitor = setInterval(() => {
        void (async () => {
          if (cancelRequested) return;
          if (await options.shouldCancel()) {
            cancelRequested = true;
            await this.request("session/cancel", { sessionId: this.sessionId }).catch(() => this.close());
            return;
          }
          const input = await options.nextInput?.();
          if (!input) return;
          try {
            await this.request("session/prompt", {
              sessionId: this.sessionId,
              prompt: [{ type: "text", text: input.message }]
            }, true);
            await options.onInputHandled?.(input);
          } catch (error) {
            await options.onInputHandled?.(input, error instanceof Error ? error.message : String(error));
          }
        })().catch((error: unknown) => {
          this.rejectPending(error instanceof Error ? error : new Error(String(error)));
          void this.close().catch(() => undefined);
        });
      }, 750);

      try {
        await promptRequest;
      } finally {
        clearInterval(monitor);
      }

      return {
        status: cancelRequested ? "interrupted" : "completed",
        threadId: this.sessionId,
        turnId: this.sessionId,
        rawStdout: rawLines.join("\n"),
        rawStderr: this.rawStderr,
        exitCode: 0,
        error: null,
        promptMayHaveBeenPresented
      };
    } catch (error) {
      return {
        status: cancelRequested ? "interrupted" : "failed",
        threadId: this.sessionId ?? "",
        turnId: null,
        rawStdout: rawLines.join("\n"),
        rawStderr: this.rawStderr,
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
        promptMayHaveBeenPresented
      };
    } finally {
      this.isRunning = false;
      this.lastUsedAt = Date.now();
      this.onNotification = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error("ACP session closed"));
    this.child.kill("SIGTERM");
    await this.closePromise;
  }

  private async initialize(authMethodId?: string | null): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        const result = await this.request("initialize", buildAcpInitializeParams());
        const methods = Array.isArray((result as { authMethods?: unknown }).authMethods)
          ? ((result as { authMethods: Array<{ id?: string }> }).authMethods ?? [])
          : [];
        const methodId =
          authMethodId && methods.some((method) => method.id === authMethodId)
            ? authMethodId
            : methods[0]?.id;
        if (methodId || this.apiKey) {
          await this.request("authenticate", {
            ...(methodId ? { methodId } : {}),
            ...(this.apiKey ? { _meta: { api_key: this.apiKey } } : {})
          }).catch(() => undefined);
        }
      })();
    }
    return this.initializePromise;
  }

  private async applyModel(options: AcpTurnOptions): Promise<void> {
    if (!this.sessionId || !options.model || options.model === "auto" || options.model === "default") return;
    await this.request("session/set_model", { sessionId: this.sessionId, modelId: options.model }).catch(
      async () => {
        await this.request("session/set_config_option", {
          sessionId: this.sessionId,
          configId: "model",
          value: options.model
        }).catch(() => undefined);
      }
    );
    const effort = options.modelOptions?.find((option) => option.id === "reasoningEffort")?.value;
    if (typeof effort === "string" && effort) {
      await this.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "effort",
        value: effort
      }).catch(() => undefined);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.lastActivityAt = Date.now();
    void this.onNotification?.(trimmed).catch((error: unknown) => {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      void this.close().catch(() => undefined);
    });
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.method === "string" && message.id !== undefined) {
      if (message.method === "session/request_permission") {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: acpPermissionDecision((message.params ?? {}) as Record<string, unknown>)
        });
      } else {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported ACP method ${message.method}` }
        });
      }
      return;
    }
    if (message.id !== undefined) {
      const id = String(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (message.error && typeof message.error === "object") {
        pending.reject(new Error(String((message.error as { message?: string }).message ?? "ACP request failed")));
      } else {
        pending.resolve((message.result as Record<string, unknown>) ?? {});
      }
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    idleAware = false
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("ACP session closed"));
    const id = this.nextId++;
    // session/prompt stays open for the whole turn and turns legitimately run
    // longer than 15 minutes, so it uses an idle window instead: keep waiting
    // while the session keeps emitting events, and only give up after
    // ACP_PROMPT_IDLE_MS of complete silence.
    const idleAwareMs = 60 * 60_000;
    const arm = (): NodeJS.Timeout =>
      setTimeout(
        () => {
          const pending = this.pending.get(String(id));
          if (!pending) return;
          if (idleAware && Date.now() - this.lastActivityAt < idleAwareMs) {
            pending.timeout = arm();
            return;
          }
          this.pending.delete(String(id));
          pending.reject(new Error(`Timed out waiting for ACP ${method}`));
        },
        idleAware ? idleAwareMs : 15 * 60_000
      );
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject, timeout: arm() });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function persistAcpLine(
  line: string,
  sessionId: string | null
): { type: string; text?: string; threadId?: string; raw: unknown } {
  const raw = parseCodexJsonLine(line);
  const normalized = normalizeAcpEvent(raw, sessionId);
  return normalized;
}

export type { AppServerTurnInput };

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
}

const sessions = new Map<string, PersistentAcpSession>();

export async function runAcpTurn(options: AcpTurnOptions): Promise<AppServerTurnResult> {
  const key = options.runtimeHome;
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
  private readonly closePromise: Promise<{ code: number | null; error?: Error }>;
  private onNotification: ((line: string) => Promise<void>) | null = null;

  constructor(
    private readonly initial: AcpTurnOptions,
    onClose: () => void
  ) {
    this.connectionKey = JSON.stringify([initial.binary, initial.args, initial.cwd, initial.runtimeHome]);
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
    return this.connectionKey === JSON.stringify([options.binary, options.args, options.cwd, options.runtimeHome]);
  }

  async runTurn(options: AcpTurnOptions): Promise<AppServerTurnResult> {
    let seq = 0;
    let promptMayHaveBeenPresented = false;
    let cancelRequested = false;
    const rawLines: string[] = [];
    const emit = async (line: string) => {
      seq += 1;
      rawLines.push(line);
      await options.onLine(redactSecrets(line, options.secrets), seq);
    };

    this.onNotification = emit;
    try {
      await this.initialize(options.authMethodId);
      if (options.threadId) {
        try {
          await this.request("session/load", {
            sessionId: options.threadId,
            cwd: options.cwd,
            mcpServers: []
          });
          this.sessionId = options.threadId;
        } catch {
          this.sessionId = null;
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
      });
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
            });
            await options.onInputHandled?.(input);
          } catch (error) {
            await options.onInputHandled?.(input, error instanceof Error ? error.message : String(error));
          }
        })();
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
        if (methodId) {
          await this.request("authenticate", { methodId }).catch(() => undefined);
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
    void this.onNotification?.(trimmed);
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

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const timeout = setTimeout(() => {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id));
      pending.reject(new Error(`Timed out waiting for ACP ${method}`));
    }, 15 * 60_000);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject, timeout });
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

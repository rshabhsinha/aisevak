import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { buildCodexAppServerArgs } from "./codex.js";
import type { CodexHarnessModel, CodexModelOption } from "./models.js";

interface JsonRpcResponse {
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface DiscoverCodexModelsOptions {
  codexBinary: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function discoverCodexModels(
  options: DiscoverCodexModelsOptions
): Promise<CodexHarnessModel[]> {
  const child = spawn(options.codexBinary, buildCodexAppServerArgs(), {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const timeoutMs = options.timeoutMs ?? 12_000;
  const pending = new Map<string, PendingRequest>();
  let buffer = "";
  let nextId = 1;
  let processError: Error | null = null;

  child.on("error", (error) => {
    processError = error;
    rejectAll(pending, error);
  });
  child.on("close", (code) => {
    if (pending.size === 0) return;
    rejectAll(pending, new Error(`Codex app-server exited while listing models (${code ?? "unknown"})`));
  });
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) handleResponseLine(line, pending);
  });

  function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (processError) return Promise.reject(processError);
    const id = `aisevak-models-${nextId++}`;
    const timeout = setTimeout(() => {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter.reject(new Error(`Timed out waiting for Codex ${method}`));
    }, timeoutMs);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject, timeout });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  try {
    await request("initialize", {
      clientInfo: { name: "aisevak", title: "Aisevak", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);

    const models: CodexHarnessModel[] = [];
    let cursor: string | undefined;
    do {
      const result = await request("model/list", cursor ? { cursor } : {});
      models.push(...parseCodexModelListResult(result));
      cursor = stringValue(result.nextCursor) ?? stringValue(result.next_cursor);
    } while (cursor);
    return dedupeModels(models);
  } finally {
    rejectAll(pending, new Error("Codex model discovery finished"));
    await stopChild(child);
  }
}

export function parseCodexModelListResult(result: Record<string, unknown>): CodexHarnessModel[] {
  const data = Array.isArray(result.data) ? result.data : [];
  return data.flatMap((value): CodexHarnessModel[] => {
    const model = recordValue(value);
    const id = stringValue(model?.model) ?? stringValue(model?.id);
    if (!id) return [];
    const isDefault = model?.isDefault === true || model?.is_default === true;
    const options = parseModelOptions(model);
    return [
      {
        id,
        label: formatModelLabel(stringValue(model?.displayName) ?? stringValue(model?.display_name) ?? id),
        description:
          stringValue(model?.description) ??
          (isDefault ? "Default model reported by Codex." : "Available through the Codex harness."),
        ...(isDefault ? { badge: "Default" } : {}),
        ...(options.length > 0 ? { options } : {})
      }
    ];
  });
}

function parseModelOptions(model: Record<string, unknown> | undefined): CodexModelOption[] {
  if (!model) return [];
  const reasoningValues = arrayValue(
    model.supportedReasoningEfforts ?? model.supported_reasoning_efforts
  ).flatMap((value) => {
    if (typeof value === "string") return [{ id: value, label: titleCase(value) }];
    const entry = recordValue(value);
    const id =
      stringValue(entry?.reasoningEffort) ?? stringValue(entry?.reasoning_effort) ?? stringValue(entry?.id);
    if (!id) return [];
    return [
      {
        id,
        label: titleCase(id),
        ...(stringValue(entry?.description) ? { description: stringValue(entry?.description) } : {})
      }
    ];
  });
  if (reasoningValues.length === 0) return [];
  const defaultValue =
    stringValue(model.defaultReasoningEffort) ?? stringValue(model.default_reasoning_effort);
  return [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      values: reasoningValues,
      ...(defaultValue ? { defaultValue } : {})
    }
  ];
}

function handleResponseLine(line: string, pending: Map<string, PendingRequest>): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let response: JsonRpcResponse;
  try {
    response = JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    return;
  }
  if (response.id === undefined) return;
  const id = String(response.id);
  const waiter = pending.get(id);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  pending.delete(id);
  if (response.error) {
    waiter.reject(new Error(response.error.message ?? `Codex request ${id} failed`));
  } else {
    waiter.resolve(response.result ?? {});
  }
}

function rejectAll(pending: Map<string, PendingRequest>, error: Error): void {
  for (const [id, waiter] of pending) {
    clearTimeout(waiter.timeout);
    pending.delete(id);
    waiter.reject(error);
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function dedupeModels(models: CodexHarnessModel[]): CodexHarnessModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function formatModelLabel(value: string): string {
  return value.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, letter: string) => `-${letter.toUpperCase()}`);
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

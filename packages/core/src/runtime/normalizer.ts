import { createAcpAdapter } from "./acpAdapter.js";
import { normalizeCodexMessage } from "./codexAdapter.js";
import { RUNTIME_EVENT_VERSION, type RuntimeEvent, type RuntimeProvider } from "./events.js";

export interface RuntimeNormalizer {
  /** One provider stdout line in, at most one canonical event out (null for blank lines). */
  normalize(line: string): RuntimeEvent | null;
}

/**
 * Create the normalizer for one provider turn. ACP adapters keep per-run state
 * (synthesized turn and message ids), so create one per run and feed it every
 * line in order.
 */
export function createRuntimeNormalizer(
  provider: RuntimeProvider,
  options: { sessionId?: string | null } = {}
): RuntimeNormalizer {
  const acp = provider === "codex" ? null : createAcpAdapter({ provider, sessionId: options.sessionId });
  return {
    normalize(line: string): RuntimeEvent | null {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return {
          v: RUNTIME_EVENT_VERSION,
          type: "parse.error",
          provider,
          text: trimmed,
          raw: { source: provider === "codex" ? "codex.app-server" : "acp.jsonrpc", payload: line }
        };
      }
      return acp ? acp.normalize(message) : normalizeCodexMessage(message);
    }
  };
}

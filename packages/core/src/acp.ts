export interface AcpClientInfo {
  name: string;
  version: string;
}

export function buildAcpInitializeParams(clientInfo: AcpClientInfo = { name: "aisevak", version: "0.1.0" }) {
  return {
    protocolVersion: 1,
    clientInfo,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { parameterizedModelPicker: true }
    }
  };
}

export function buildCursorAcpArgs(apiEndpoint?: string | null): string[] {
  return [...(apiEndpoint?.trim() ? ["-e", apiEndpoint.trim()] : []), "acp"];
}

export function buildOpenCodeAcpArgs(): string[] {
  return ["acp"];
}

export function acpPermissionDecision(params: Record<string, unknown>): { outcome: { outcome: "selected"; optionId: string } } {
  // Security: auto-approves tool calls, matching the Codex harness
  // `danger-full-access` policy. Only run on trusted hosts (see README).
  const options = Array.isArray(params.options) ? params.options : [];
  const choices = options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const record = option as Record<string, unknown>;
    const optionId = stringValue(record.optionId);
    return optionId ? [{ optionId, kind: stringValue(record.kind) ?? "" }] : [];
  });
  // Never pick a rejection, and never an option that clears the agent's
  // context (Claude Code's "exit plan mode and clear context" choices): an
  // unattended worker must keep its conversation.
  const usable = choices.filter((choice) => !/^reject/i.test(choice.kind) && !/clear/i.test(choice.optionId));
  const ids = usable.map((choice) => choice.optionId);
  const preferred =
    ids.find((id) => /allow_always|allow-always|always_allow/i.test(id)) ??
    ids.find((id) => /^allow$/i.test(id)) ??
    ids.find((id) => /bypass/i.test(id)) ??
    ids.find((id) => /allow|proceed|approve|yes/i.test(id)) ??
    usable.find((choice) => /^allow/i.test(choice.kind))?.optionId ??
    ids[0] ??
    choices[0]?.optionId ??
    "allow";
  return { outcome: { outcome: "selected", optionId: preferred } };
}

export function extractAcpSessionId(value: unknown): string | undefined {
  const record = objectValue(value);
  return (
    stringValue(record?.sessionId) ??
    stringValue(record?.session_id) ??
    stringValue(objectValue(record?.session)?.sessionId) ??
    stringValue(objectValue(record?.session)?.id)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

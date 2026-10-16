import { defaultHarnessModelOptions, defaultModelForDriver, isClaudeModelId } from "@aisevak/core";
export interface AgentDeletionCandidate {
  kind: string;
  name: string;
}

export interface AgentDeletionUsage {
  taskCount: number;
  threadCount: number;
  scheduleCount: number;
  otherEnabledDispatcherCount: number;
}

export function agentDeletionBlockReason(
  agent: AgentDeletionCandidate,
  usage: AgentDeletionUsage
): string | null {
  const references = [
    usage.taskCount > 0 ? `${usage.taskCount} task${usage.taskCount === 1 ? "" : "s"}` : null,
    usage.threadCount > 0 ? `${usage.threadCount} thread${usage.threadCount === 1 ? "" : "s"}` : null,
    usage.scheduleCount > 0
      ? `${usage.scheduleCount} schedule${usage.scheduleCount === 1 ? "" : "s"}`
      : null
  ].filter(Boolean);

  if (references.length > 0) {
    return `Cannot delete ${agent.name} because it is used by ${references.join(" and ")}. Reassign those first.`;
  }
  if (agent.kind === "dispatcher" && usage.otherEnabledDispatcherCount === 0) {
    return `Cannot delete ${agent.name} because it is the last enabled Orchestrator.`;
  }
  return null;
}


export type AgentModelOptions = Array<{ id: string; value: string | number | boolean }>;

// Decides the model an agent update stores once its harness is known. Moving
// an agent onto Claude Code without naming a model switches it to the Claude
// default (with that model's effort default) instead of keeping a model
// Claude Code cannot run; an explicit non-Claude model is refused, and moving
// off Claude Code requires naming the new model.
export function planAgentModelUpdate(input: {
  driver: string;
  previousDriver: string;
  currentModel: string;
  requestedModel: string | null;
  requestedOptions: AgentModelOptions | null;
}): { model: string | null; modelOptions: AgentModelOptions | null; error: string | null } {
  let model = input.requestedModel;
  let modelOptions = input.requestedOptions;
  if (!model) {
    const fitted = defaultModelForDriver(input.driver, input.currentModel);
    if (fitted !== input.currentModel) {
      model = fitted;
      modelOptions ??= defaultHarnessModelOptions(fitted);
    }
  }
  // Leaving Claude Code: its model means nothing to the new harness, and a
  // safe default cannot be guessed (Cursor and Devin have claude-* IDs of
  // their own), so the caller must name one.
  if (!model && input.previousDriver === "claude" && input.driver !== "claude") {
    return { model, modelOptions, error: "Choose a model for the new harness when moving an agent off Claude Code" };
  }
  const effective = model ?? input.currentModel;
  const error = input.driver === "claude" && !isClaudeModelId(effective)
    ? `Claude Code agents need a Claude model such as claude-opus-5-5, not ${effective}`
    : null;
  return { model, modelOptions, error };
}

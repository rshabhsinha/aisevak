export type UserRole = "owner" | "admin" | "member";
export type ProjectSource = "local_path" | "github";
export type WorkspaceMode = "direct" | "git_worktree";
export type RunStatus =
  | "draft"
  | "queued"
  | "running"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed";
export type ImportJobStatus = "queued" | "running" | "succeeded" | "failed";
export type GithubAuthMode = "app" | "pat";
export type AgentKind = "worker" | "dispatcher";
export type RunKind = "worker" | "dispatcher";
export type RunTrigger = "manual" | "heartbeat" | "auto_route" | "agent_tool";

export type ProviderDriver = "codex";

export interface ModelOptionSelection {
  id: string;
  value: string | number | boolean;
}

export interface ModelSelection {
  providerInstanceId: string;
  model: string;
  options: ModelOptionSelection[];
}

export interface CodexSkillReference {
  name: string;
  description: string;
}

export interface CodexSkillSnapshot extends CodexSkillReference {
  id: string;
  instructions: string;
  files: Record<string, string>;
  sources: string[];
}

export interface CodexPromptOptions {
  agentName: string;
  agentInstructions: string;
  taskTitle: string;
  taskBody?: string | null;
  projectPath: string;
  branch?: string | null;
  previousContext?: string | null;
  skills?: CodexSkillReference[];
}

export interface NormalizedCodexEvent {
  type: string;
  text?: string;
  threadId?: string;
  itemId?: string;
  status?: string;
  usage?: Record<string, unknown>;
  raw: unknown;
}

export interface DispatcherPromptOptions {
  dispatcherInstructions: string;
  tasksJson: string;
  agentsJson: string;
  projectsJson: string;
  targetTaskNumber?: number | null;
  skills?: CodexSkillReference[];
}

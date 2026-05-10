export type UserRole = "owner" | "admin" | "member";
export type ProjectSource = "local_path" | "github";
export type WorkspaceMode = "direct" | "git_worktree";
export type RunStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed";
export type ImportJobStatus = "queued" | "running" | "succeeded" | "failed";
export type GithubAuthMode = "app" | "pat";

export interface CodexCommandOptions {
  resumeThreadId?: string | null;
  model?: string | null;
  skipGitRepoCheck?: boolean;
}

export interface CodexPromptOptions {
  agentName: string;
  agentInstructions: string;
  taskTitle: string;
  taskBody?: string | null;
  projectPath: string;
  branch?: string | null;
  previousContext?: string | null;
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

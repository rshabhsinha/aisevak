import { createHash } from "node:crypto";

export const DEFAULT_ORCHESTRATION_POLICY = {
  maxActiveAssignments: 5,
  maxActiveChildren: 5,
  maxChildDepth: 3,
  maxAssignmentAttempts: 3
} as const;

export type OrchestrationPolicy = {
  maxActiveAssignments: number;
  maxActiveChildren: number;
  maxChildDepth: number;
  maxAssignmentAttempts: number;
};

export type JobSafetyMode = "audit" | "enforce";

export function jobSafetyMode(): JobSafetyMode {
  return process.env.AISEVAK_JOB_SAFETY_MODE === "audit" ? "audit" : "enforce";
}

export function normalizeWorkKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(key)) {
    throw Object.assign(new Error("workKey must be 1-200 characters and use letters, numbers, dots, underscores, colons, slashes, or hyphens"), { statusCode: 400 });
  }
  return key;
}

export function normalizeWorkScope(value: string | undefined, fallback: string): string {
  const scope = (value ?? fallback).trim();
  if (!scope || scope.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(scope)) {
    throw Object.assign(new Error("workScope must be 1-200 characters and use letters, numbers, dots, underscores, colons, slashes, or hyphens"), { statusCode: 400 });
  }
  return scope;
}

export function taskWorkScope(input: { parentTaskId?: string | null; projectId?: string | null; actorId?: string | null }): string {
  if (input.parentTaskId) return `task:${input.parentTaskId}`;
  if (input.projectId) return `project:${input.projectId}`;
  if (input.actorId) return `agent:${input.actorId}`;
  return "global";
}

export function detachedWorkScope(agentId: string): string {
  return `detached:${agentId}`;
}

export function taskFingerprint(input: {
  title: string;
  description: string;
  body: string;
  projectId?: string | null;
  agentId: string;
  parentTaskId?: string | null;
  workScope: string;
  workKey: string;
}): string {
  return stableFingerprint({
    title: input.title.trim(),
    description: input.description.trim(),
    body: input.body,
    projectId: input.projectId ?? null,
    agentId: input.agentId,
    parentTaskId: input.parentTaskId ?? null,
    workScope: input.workScope,
    workKey: input.workKey
  });
}

export function assignmentFingerprint(input: {
  taskId: string;
  assignmentKey: string;
  assignedAgentId: string;
  instructions: string;
}): string {
  return stableFingerprint({
    taskId: input.taskId,
    assignmentKey: input.assignmentKey,
    assignedAgentId: input.assignedAgentId,
    instructions: input.instructions
  });
}

export function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function orchestrationPolicy(value: unknown): OrchestrationPolicy {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const positive = (key: keyof OrchestrationPolicy): number => {
    const candidate = Number(source[key]);
    return Number.isInteger(candidate) && candidate > 0 ? Math.min(candidate, 100) : DEFAULT_ORCHESTRATION_POLICY[key];
  };
  return {
    maxActiveAssignments: positive("maxActiveAssignments"),
    maxActiveChildren: positive("maxActiveChildren"),
    maxChildDepth: positive("maxChildDepth"),
    maxAssignmentAttempts: positive("maxAssignmentAttempts")
  };
}

export function childDepth(value: number | null | undefined): number {
  return Math.max(0, Number(value ?? 0));
}

export function safetyConflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export function safetyForbidden(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 403 });
}

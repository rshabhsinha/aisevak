export interface ScheduledAgentPromptInput {
  agentName: string;
  agentDescription: string;
  agentInstructions: string;
  prompt: string;
}

export function extractPromptSkillNames(prompt: string): string[] {
  const names = new Set<string>();
  for (const match of prompt.matchAll(/@skill\(([^)\n]+)\)/g)) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

export function buildScheduledAgentPrompt(input: ScheduledAgentPromptInput): string {
  const description = input.agentDescription.trim();
  const identity = description
    ? `You are ${input.agentName}: ${description}`
    : `You are ${input.agentName}.`;
  return [
    identity,
    "This is a scheduled run. Complete the request independently and leave a concise result in this task.",
    input.agentInstructions.trim(),
    "Scheduled prompt:",
    input.prompt.trim()
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function nextScheduleRunAt(
  scheduledFor: Date,
  intervalSeconds: number,
  now = new Date()
): Date {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
    throw new Error("Schedule interval must be at least 60 seconds");
  }
  const base = Math.max(scheduledFor.getTime(), now.getTime());
  return new Date(base + intervalSeconds * 1000);
}

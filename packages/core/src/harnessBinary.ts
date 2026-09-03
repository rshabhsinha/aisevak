import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePathExecutable } from "./codexBinary.js";

const AUTO_VALUES = new Set(["", "auto", "default"]);

export function resolveCursorBinary(
  configured: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env
): string {
  return resolveNamedBinary({
    configured,
    defaultName: "cursor-agent",
    aliases: ["cursor-agent", "agent"],
    darwinCandidates: [
      join(homedir(), ".local", "bin", "cursor-agent"),
      join(homedir(), ".local", "bin", "agent")
    ],
    environment
  });
}

export function resolveOpenCodeBinary(
  configured: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env
): string {
  return resolveNamedBinary({
    configured,
    defaultName: "opencode",
    aliases: ["opencode"],
    darwinCandidates: [join(homedir(), ".opencode", "bin", "opencode")],
    environment
  });
}

function resolveNamedBinary(input: {
  configured: string | null | undefined;
  defaultName: string;
  aliases: string[];
  darwinCandidates: string[];
  environment: NodeJS.ProcessEnv;
}): string {
  const requested = input.configured?.trim() ?? "";
  const automatic = AUTO_VALUES.has(requested.toLowerCase());
  if (!automatic) {
    const resolved = resolvePathExecutable(requested, input.environment);
    if (resolved) return resolved;
    if (!input.aliases.includes(requested)) return requested;
  }

  for (const alias of input.aliases) {
    const fromPath = resolvePathExecutable(alias, input.environment);
    if (fromPath) return fromPath;
  }

  if (process.platform === "darwin") {
    for (const candidate of input.darwinCandidates) {
      if (resolvePathExecutable(candidate, input.environment)) return candidate;
    }
  }

  return input.defaultName;
}

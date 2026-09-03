import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePathExecutable } from "./codexBinary.js";

const AUTO_VALUES = new Set(["", "auto", "default"]);

// Published by scripts/install.sh and bind-mounted read-only into the API
// container, so container probes resolve the same host CLIs as the runner.
const HOST_PUBLISHED_BIN_DIR = "/opt/aisevak/harness-bin";

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
    sharedCandidates: [
      join(HOST_PUBLISHED_BIN_DIR, "cursor-agent"),
      join(HOST_PUBLISHED_BIN_DIR, "agent")
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
    sharedCandidates: [join(HOST_PUBLISHED_BIN_DIR, "opencode")],
    environment
  });
}

function resolveNamedBinary(input: {
  configured: string | null | undefined;
  defaultName: string;
  aliases: string[];
  darwinCandidates: string[];
  sharedCandidates: string[];
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

  for (const candidate of input.sharedCandidates) {
    if (resolvePathExecutable(candidate, input.environment)) return candidate;
  }

  return input.defaultName;
}

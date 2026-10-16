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

export function resolveDevinBinary(
  configured: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env
): string {
  return resolveNamedBinary({
    configured,
    defaultName: "devin",
    aliases: ["devin"],
    darwinCandidates: [
      join(homedir(), ".local", "bin", "devin"),
      "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin"
    ],
    sharedCandidates: [join(HOST_PUBLISHED_BIN_DIR, "devin")],
    environment
  });
}

// Claude Code runs through the ACP adapter `claude-agent-acp`
// (@agentclientprotocol/claude-agent-acp), which bundles the Claude Agent SDK
// and its native Claude Code executable. It is a Node package, so it is
// installed globally on the host for the runner and not published into
// HARNESS_BIN_DIR for the API container.
export function resolveClaudeAcpBinary(
  configured: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env
): string {
  return resolveNamedBinary({
    configured,
    defaultName: "claude-agent-acp",
    aliases: ["claude-agent-acp"],
    darwinCandidates: [join(homedir(), ".local", "bin", "claude-agent-acp"), "/opt/homebrew/bin/claude-agent-acp"],
    sharedCandidates: ["/usr/local/bin/claude-agent-acp", "/usr/bin/claude-agent-acp"],
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

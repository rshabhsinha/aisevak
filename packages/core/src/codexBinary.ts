import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const AUTO_VALUES = new Set(["", "auto", "default"]);

export function resolveCodexBinary(
  configured: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const requested = configured?.trim() ?? "";
  const automatic = AUTO_VALUES.has(requested.toLowerCase());

  if (!automatic) {
    const resolved = resolveExecutable(requested, environment);
    if (resolved) return resolved;
    if (requested !== "codex") return requested;
  }

  const fromPath = resolveExecutable("codex", environment);
  if (fromPath) return fromPath;

  if (process.platform === "darwin") {
    const applicationCandidates = [
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      join(homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
      join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex")
    ];
    for (const candidate of applicationCandidates) {
      if (isExecutable(candidate)) return candidate;
    }
  }

  return "codex";
}

function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : null;
  }

  const extensions =
    process.platform === "win32"
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

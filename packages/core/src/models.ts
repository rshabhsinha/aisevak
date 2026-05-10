export interface CodexHarnessModel {
  id: string;
  label: string;
  description: string;
  badge?: string;
}

export const DEFAULT_CODEX_MODEL = "gpt-5.5";

export const CODEX_HARNESS_MODELS: CodexHarnessModel[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "Newest frontier model for complex Codex work.",
    badge: "Default"
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    description: "Flagship Codex model for professional coding work."
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Fast, efficient model for lighter tasks and subagents."
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Coding-specialized model for complex software engineering."
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    description: "Research-preview model for near-instant coding iteration.",
    badge: "Preview"
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    description: "Previous general-purpose fallback for Codex tasks."
  }
];

export function normalizeCodexModel(model: string | null | undefined): string {
  if (!model || ["default", "auto", "codex-default"].includes(model.trim().toLowerCase())) {
    return DEFAULT_CODEX_MODEL;
  }
  return model;
}

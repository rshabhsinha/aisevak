import type { ModelOptionSelection } from "./types.js";

export interface CodexHarnessModel {
  id: string;
  label: string;
  description: string;
  badge?: string;
  options?: CodexModelOption[];
}

export interface CodexModelOption {
  id: string;
  label: string;
  values: Array<{ id: string; label: string; description?: string }>;
  defaultValue?: string;
}

export const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
export const DEFAULT_CODEX_REASONING_EFFORT = "max";

const EXTENDED_REASONING: CodexModelOption = {
  id: "reasoningEffort",
  label: "Reasoning",
  values: [
    { id: "low", label: "Low", description: "Fast responses with lighter reasoning" },
    { id: "medium", label: "Medium", description: "Balances speed and reasoning depth" },
    { id: "high", label: "High", description: "Greater reasoning depth for complex problems" },
    { id: "xhigh", label: "Xhigh", description: "Extra-high reasoning depth" },
    { id: "max", label: "Max", description: "Maximum reasoning depth" },
    { id: "ultra", label: "Ultra", description: "Maximum reasoning with automatic delegation" }
  ],
  defaultValue: "low"
};

function reasoning(defaultValue: string, maximum: "xhigh" | "max" | "ultra"): CodexModelOption[] {
  const maximumIndex = EXTENDED_REASONING.values.findIndex((value) => value.id === maximum);
  return [
    {
      ...EXTENDED_REASONING,
      values: EXTENDED_REASONING.values.slice(0, maximumIndex + 1),
      defaultValue
    }
  ];
}

// Fallback catalog used only when live `model/list` discovery fails.
// IDs, reasoning ranges and CLI defaults verified with Codex 0.160.0 on
// 2026-10-02. The existing Luna/max application policy remains unchanged.
export const CODEX_HARNESS_MODELS: CodexHarnessModel[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "Latest workhorse model for coding and everyday work.", options: reasoning("low", "ultra") },
  { id: "gpt-6-astra", label: "GPT-6-Astra", description: "Frontier intelligence for the most demanding work.", options: reasoning("low", "ultra") },
  { id: "gpt-6-sol", label: "GPT-6-Sol", description: "Previous generation workhorse model.", options: reasoning("medium", "ultra") },
  { id: "gpt-6-luna", label: "GPT-6-Luna", description: "Fast and affordable model for easier tasks.", options: reasoning("medium", "max") },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Reliable agentic workhorse for everyday tasks.",
    options: reasoning("low", "ultra")
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    options: reasoning("medium", "ultra")
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    badge: "Default",
    options: reasoning(DEFAULT_CODEX_REASONING_EFFORT, "max")
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "Frontier model for complex coding, research, and real-world work.",
    options: reasoning("medium", "xhigh")
  }
];

export function resolveCodexDefaultModel(value = process.env.CODEX_DEFAULT_MODEL): string {
  const configured = value?.trim();
  if (!configured || ["default", "auto", "codex-default"].includes(configured.toLowerCase())) {
    return DEFAULT_CODEX_MODEL;
  }
  return CODEX_HARNESS_MODELS.some((model) => model.id === configured)
    ? configured
    : DEFAULT_CODEX_MODEL;
}

export function normalizeCodexModel(model: string | null | undefined): string {
  if (!model || ["default", "auto", "codex-default"].includes(model.trim().toLowerCase())) {
    return DEFAULT_CODEX_MODEL;
  }
  return model;
}

export function applyCodexModelDefaults(
  models: CodexHarnessModel[],
  preferredModel = DEFAULT_CODEX_MODEL
): { defaultModel: string; models: CodexHarnessModel[] } {
  const defaultModel =
    models.find((model) => model.id === preferredModel)?.id ??
    models.find((model) => model.badge === "Default")?.id ??
    models[0]?.id ??
    preferredModel;

  return {
    defaultModel,
    models: models.map((model) => ({
      ...model,
      ...(model.id === defaultModel ? { badge: "Default" } : { badge: undefined }),
      options: model.options?.map((option) => {
        if (
          model.id !== DEFAULT_CODEX_MODEL ||
          option.id !== "reasoningEffort" ||
          !option.values.some((value) => value.id === DEFAULT_CODEX_REASONING_EFFORT)
        ) {
          return option;
        }
        return { ...option, defaultValue: DEFAULT_CODEX_REASONING_EFFORT };
      })
    }))
  };
}

export function defaultCodexModelOptions(modelId = DEFAULT_CODEX_MODEL): ModelOptionSelection[] {
  const model = CODEX_HARNESS_MODELS.find((entry) => entry.id === modelId);
  return (model?.options ?? []).flatMap((option): ModelOptionSelection[] => {
    const value = option.defaultValue ?? option.values[0]?.id;
    return value ? [{ id: option.id, value }] : [];
  });
}

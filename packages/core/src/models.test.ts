import { describe, expect, it } from "vitest";
import {
  applyCodexModelDefaults,
  defaultCodexModelOptions,
  normalizeCodexModel,
  resolveCodexDefaultModel
} from "./models.js";

describe("Codex model defaults", () => {
  it("normalizes automatic model selection to Luna", () => {
    expect(normalizeCodexModel("auto")).toBe("gpt-5.6-luna");
  });

  it("marks Luna as the application default with max reasoning", () => {
    const catalog = applyCodexModelDefaults([
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        description: "Sol",
        badge: "Default"
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6-Luna",
        description: "Luna",
        options: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            defaultValue: "medium",
            values: [
              { id: "medium", label: "Medium" },
              { id: "max", label: "Max" }
            ]
          }
        ]
      }
    ]);

    expect(catalog.defaultModel).toBe("gpt-5.6-luna");
    expect(catalog.models[0]?.badge).toBeUndefined();
    expect(catalog.models[1]?.badge).toBe("Default");
    expect(catalog.models[1]?.options?.[0]?.defaultValue).toBe("max");
  });

  it("provides max reasoning for newly created Luna agents", () => {
    expect(defaultCodexModelOptions()).toEqual([{ id: "reasoningEffort", value: "max" }]);
  });

  it("accepts a supported configured default and rejects unknown values", () => {
    expect(resolveCodexDefaultModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(resolveCodexDefaultModel("not-a-model")).toBe("gpt-5.6-luna");
    expect(resolveCodexDefaultModel("auto")).toBe("gpt-5.6-luna");
  });
});

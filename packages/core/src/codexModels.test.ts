import { describe, expect, it } from "vitest";
import { parseCodexModelListResult } from "./codexModels.js";

describe("parseCodexModelListResult", () => {
  it("normalizes live models and reasoning options", () => {
    expect(
      parseCodexModelListResult({
        data: [
          {
            model: "gpt-5.6-sol",
            displayName: "gpt-5.6-sol",
            description: "Frontier coding model",
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "More reasoning" }
            ]
          }
        ]
      })
    ).toEqual([
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        description: "Frontier coding model",
        badge: "Default",
        options: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            defaultValue: "high",
            values: [
              { id: "medium", label: "Medium", description: "Balanced" },
              { id: "high", label: "High", description: "More reasoning" }
            ]
          }
        ]
      }
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORCHESTRATION_POLICY,
  assignmentFingerprint,
  normalizeWorkKey,
  orchestrationPolicy,
  stableFingerprint,
  taskFingerprint
} from "./jobSafety.js";

describe("generic job identity safety", () => {
  it("normalizes valid work keys and rejects ambiguous values", () => {
    expect(normalizeWorkKey("  build:parser-v1  ")).toBe("build:parser-v1");
    expect(() => normalizeWorkKey("contains spaces")).toThrow(/workKey/);
    expect(() => normalizeWorkKey("../outside")).toThrow(/workKey/);
  });

  it("keeps task fingerprints stable and sensitive to immutable input", () => {
    const input = {
      title: "Build parser",
      description: "Parse input",
      body: "Use the grammar.",
      projectId: "project-1",
      agentId: "agent-1",
      parentTaskId: null,
      workScope: "project:project-1",
      workKey: "parser-v1"
    };
    expect(taskFingerprint(input)).toBe(taskFingerprint({ ...input, title: "  Build parser " }));
    expect(taskFingerprint(input)).not.toBe(taskFingerprint({ ...input, body: "Use another grammar." }));
    expect(assignmentFingerprint({ taskId: "task-1", assignmentKey: "review", assignedAgentId: "agent-2", instructions: "Review" }))
      .toBe(assignmentFingerprint({ taskId: "task-1", assignmentKey: "review", assignedAgentId: "agent-2", instructions: "Review" }));
    expect(stableFingerprint({ a: 1 })).toHaveLength(64);
  });

  it("fails closed to the default limits and clamps admin overrides", () => {
    expect(orchestrationPolicy(null)).toEqual(DEFAULT_ORCHESTRATION_POLICY);
    expect(orchestrationPolicy({ maxActiveAssignments: 8, maxChildDepth: 0 })).toEqual({
      ...DEFAULT_ORCHESTRATION_POLICY,
      maxActiveAssignments: 8
    });
    expect(orchestrationPolicy({ maxActiveChildren: 1000 }).maxActiveChildren).toBe(100);
  });
});

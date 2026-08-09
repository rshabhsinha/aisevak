import { describe, expect, it } from "vitest";
import { findSlashTrigger, promptReferenceToken, replaceSlashTrigger } from "./promptComposer.js";

describe("prompt composer slash commands", () => {
  it("finds a partial slash command at the cursor", () => {
    expect(findSlashTrigger("Review this with /sk", 20)).toMatchObject({
      command: null,
      query: "sk",
      mode: "command"
    });
  });

  it("finds a reference query after a command", () => {
    expect(findSlashTrigger("Use /skill work", 15)).toMatchObject({
      command: "skill",
      query: "work",
      mode: "reference"
    });
  });

  it("replaces only the active slash expression", () => {
    const text = "Use /skill work tomorrow";
    const trigger = findSlashTrigger(text, 15)!;
    expect(replaceSlashTrigger(text, trigger, `${promptReferenceToken("skill", "work-next")} `)).toEqual({
      value: "Use @skill(work-next)  tomorrow",
      cursor: 22
    });
  });

  it("ignores URL slashes", () => {
    expect(findSlashTrigger("https://example.com/sk", 22)).toBeNull();
  });
});

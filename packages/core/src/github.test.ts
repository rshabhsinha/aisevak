import { describe, expect, it } from "vitest";
import { managedGithubRepoPath, normalizeGithubRepo, taskBranchName } from "./github.js";

describe("github helpers", () => {
  it("creates stable branch names", () => {
    expect(taskBranchName(42, "Fix OAuth callback!")).toBe("agent/42-fix-oauth-callback");
  });

  it("keeps managed repo paths inside the workspace", () => {
    expect(managedGithubRepoPath("/srv/app", "Owner", "Repo")).toBe(
      "/srv/app/workspaces/github/owner/repo"
    );
  });

  it("normalizes GitHub REST repository payloads", () => {
    expect(
      normalizeGithubRepo({
        full_name: "owner/repo",
        clone_url: "https://github.com/owner/repo.git",
        default_branch: "main"
      })
    ).toMatchObject({ owner: "owner", name: "repo" });
  });
});

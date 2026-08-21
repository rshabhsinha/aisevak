import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateGithubCli,
  discoverGithubRepositories,
  githubCliPaths,
  parseGithubRepositoryPages,
  safeChildEnvironment
} from "./githubCli.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitHub CLI runtime", () => {
  it("does not pass Aisevak service secrets to child processes", () => {
    const value = safeChildEnvironment({
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.test",
      AWS_SHARED_CREDENTIALS_FILE: "/srv/aisevak/aws/credentials",
      AWS_CONFIG_FILE: "/srv/aisevak/aws/config",
      AWS_PROFILE: "aisevak-reader",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "must-not-pass",
      AWS_SECRET_ACCESS_KEY: "must-not-pass",
      DATABASE_URL: "postgres://secret",
      SECRET_KEY: "encryption-key",
      COOKIE_SECRET: "cookie-key",
      OPENAI_API_KEY: "openai-key"
    });

    expect(value).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.test",
      AWS_SHARED_CREDENTIALS_FILE: "/srv/aisevak/aws/credentials",
      AWS_CONFIG_FILE: "/srv/aisevak/aws/config",
      AWS_PROFILE: "aisevak-reader",
      AWS_REGION: "us-east-1"
    });
  });

  it("parses every paginated repository response", () => {
    expect(
      parseGithubRepositoryPages(
        JSON.stringify([
          [repository("owner/first")],
          [repository("owner/second")]
        ])
      ).map((repo) => repo.fullName)
    ).toEqual(["owner/first", "owner/second"]);
  });

  it("authenticates gh, configures Git credentials, and discovers repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisevak-github-cli-"));
    temporaryRoots.push(root);
    const managedRoot = join(root, "managed");
    const binary = join(root, "fake-gh");
    await writeFile(binary, fakeGithubCli(), "utf8");
    await chmod(binary, 0o700);

    const account = await authenticateGithubCli("test-token", {
      managedRoot,
      binary,
      sourceEnv: { PATH: process.env.PATH }
    });
    const paths = githubCliPaths(managedRoot);

    expect(account).toBe("octocat");
    expect(existsSync(join(paths.configDir, "hosts.yml"))).toBe(true);
    expect(await readFile(paths.gitConfig, "utf8")).toContain("credential");
    expect(
      (await discoverGithubRepositories({ managedRoot, binary, sourceEnv: { PATH: process.env.PATH } })).map(
        (repo) => repo.fullName
      )
    ).toEqual(["octocat/alpha", "octocat/beta"]);
  });
});

function repository(fullName: string): Record<string, string> {
  return {
    full_name: fullName,
    clone_url: `https://github.com/${fullName}.git`,
    default_branch: "main"
  };
}

function fakeGithubCli(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "login") {
  let token = "";
  process.stdin.on("data", (chunk) => token += chunk);
  process.stdin.on("end", () => {
    if (token.trim() !== "test-token") process.exit(2);
    fs.mkdirSync(process.env.GH_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.GH_CONFIG_DIR, "hosts.yml"), "github.com:\\n  user: octocat\\n");
  });
} else if (args[0] === "auth" && args[1] === "setup-git") {
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, ".gitconfig"), "[credential]\\n  helper = gh auth git-credential\\n");
} else if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("octocat\\n");
} else if (args[0] === "api" && args.some((arg) => arg.startsWith("/user/repos"))) {
  process.stdout.write(JSON.stringify([[
    ${JSON.stringify(repository("octocat/alpha"))},
    ${JSON.stringify(repository("octocat/beta"))}
  ]]));
} else {
  process.stderr.write("unexpected arguments: " + args.join(" "));
  process.exit(3);
}
`;
}

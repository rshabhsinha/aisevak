import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { agentToolScript } from "./script.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("embedded aisevak CLI", () => {
  it("does not advertise an empty POST body as JSON", async () => {
    let contentType: string | undefined;
    const server = createServer((request, response) => {
      contentType = request.headers["content-type"];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ report: { key: "REPORT-1", status: "published" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");

    const directory = await mkdtemp(join(tmpdir(), "aisevak-cli-test-"));
    cleanup.push(directory);
    const cliPath = join(directory, "aisevak");
    await writeFile(cliPath, agentToolScript(), { mode: 0o700 });
    const result = await execFileAsync(process.execPath, [cliPath, "reports", "publish", "REPORT-1"], {
      env: {
        ...process.env,
        AISEVAK_API_URL: `http://127.0.0.1:${address.port}`,
        AISEVAK_AGENT_TOKEN: "test-token"
      }
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(contentType).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({ report: { status: "published" } });
  });

  it("documents the durable coordination resources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aisevak-cli-test-"));
    cleanup.push(directory);
    const cliPath = join(directory, "aisevak");
    await writeFile(cliPath, agentToolScript(), { mode: 0o700 });
    const result = await execFileAsync(process.execPath, [cliPath, "help"], {
      env: { ...process.env, AISEVAK_AGENT_TOKEN: "test-token" }
    });
    expect(result.stdout).toContain("threads");
    expect(result.stdout).toContain("assignments");
    expect(result.stdout).toContain("--work-key");
    expect(result.stdout).toContain("reports");
    expect(result.stdout).toContain("incidents");
    expect(result.stdout).toContain("schedules");
    expect(result.stdout).toContain("skills path");
    expect(result.stdout).toContain("skills install");
  });

  it("prints the isolated skill-view path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aisevak-cli-test-"));
    cleanup.push(directory);
    const cliPath = join(directory, "aisevak");
    await writeFile(cliPath, agentToolScript(), { mode: 0o700 });
    const result = await execFileAsync(process.execPath, [cliPath, "skills", "path"], {
      env: {
        ...process.env,
        AISEVAK_AGENT_TOKEN: "test-token",
        AISEVAK_SKILLS_DIR: "/srv/aisevak/codex-homes/thread-1/.agents/skills"
      }
    });

    expect(JSON.parse(result.stdout)).toEqual({
      path: "/srv/aisevak/codex-homes/thread-1/.agents/skills"
    });
  });

  it("publishes a validated skill directory through the authenticated API", async () => {
    let requestPath = "";
    let requestBody: Record<string, unknown> = {};
    const server = createServer((request, response) => {
      requestPath = request.url ?? "";
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ skill: { key: "SKILL-background-terminals" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");

    const directory = await mkdtemp(join(tmpdir(), "aisevak-cli-test-"));
    cleanup.push(directory);
    const cliPath = join(directory, "aisevak");
    const skillPath = join(directory, "background-terminals");
    await mkdir(join(skillPath, "references"), { recursive: true });
    await writeFile(cliPath, agentToolScript(), { mode: 0o700 });
    await writeFile(
      join(skillPath, "SKILL.md"),
      "---\nname: background-terminals\ndescription: Keep background commands alive safely.\n---\n\n# Background terminals\n"
    );
    await writeFile(join(skillPath, "references", "tmux.md"), "Use a detached tmux session.\n");

    const result = await execFileAsync(process.execPath, [cliPath, "skills", "install", skillPath], {
      env: {
        ...process.env,
        AISEVAK_API_URL: `http://127.0.0.1:${address.port}`,
        AISEVAK_AGENT_TOKEN: "test-token"
      }
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(requestPath).toBe("/api/agent-tools/v1/skills");
    expect(requestBody).toMatchObject({
      markdown: expect.stringContaining("name: background-terminals"),
      files: { "references/tmux.md": "Use a detached tmux session.\n" }
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ skill: { key: "SKILL-background-terminals" } });
  });

  it("reads rotating agent credentials from a token file", async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ agent: { name: "Builder" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");

    const directory = await mkdtemp(join(tmpdir(), "aisevak-cli-test-"));
    cleanup.push(directory);
    const cliPath = join(directory, "aisevak");
    const tokenPath = join(directory, "agent-token");
    await writeFile(cliPath, agentToolScript(), { mode: 0o700 });
    await writeFile(tokenPath, "rotated-token\n", { mode: 0o600 });
    await execFileAsync(process.execPath, [cliPath, "whoami"], {
      env: {
        ...process.env,
        AISEVAK_API_URL: `http://127.0.0.1:${address.port}`,
        AISEVAK_AGENT_TOKEN: "",
        AISEVAK_AGENT_TOKEN_FILE: tokenPath
      }
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(authorization).toBe("Bearer rotated-token");
  });

  it("creates schedules with stable prompt and timing options", async () => {
    let requestPath = "";
    let requestBody: Record<string, unknown> = {};
    const server = createServer((request, response) => {
      requestPath = request.url ?? "";
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ schedule: { key: "SCHEDULE-1", status: "scheduled" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");

    const directory = await mkdtemp(join(tmpdir(), "aisevak-cli-test-"));
    cleanup.push(directory);
    const cliPath = join(directory, "aisevak");
    await writeFile(cliPath, agentToolScript(), { mode: 0o700 });
    const result = await execFileAsync(
      process.execPath,
      [
        cliPath, "schedules", "create", "--title", "Daily brief", "--agent", "Reviewer",
        "--at", "2026-08-10T09:00:00.000Z", "--interval-seconds", "3600",
        "--prompt", "Use @skill(aisevak-cli) and prepare the brief.",
        "--idempotency-key", "daily-brief-v1"
      ],
      {
        env: {
          ...process.env,
          AISEVAK_API_URL: `http://127.0.0.1:${address.port}`,
          AISEVAK_AGENT_TOKEN: "test-token"
        }
      }
    );
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(requestPath).toBe("/api/agent-tools/v1/schedules");
    expect(requestBody).toMatchObject({
      title: "Daily brief",
      agent: "Reviewer",
      at: "2026-08-10T09:00:00.000Z",
      intervalSeconds: "3600",
      prompt: "Use @skill(aisevak-cli) and prepare the brief.",
      idempotencyKey: "daily-brief-v1"
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ schedule: { key: "SCHEDULE-1" } });
  });

  it("creates keyed assignments through the durable assignment endpoint", async () => {
    let requestPath = "";
    let requestBody: Record<string, unknown> = {};
    const server = createServer((request, response) => {
      requestPath = request.url ?? "";
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ assignment: { key: "ASSIGNMENT-7", status: "queued" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");

    const directory = await mkdtemp(join(tmpdir(), "aisevak-cli-test-"));
    cleanup.push(directory);
    const cliPath = join(directory, "aisevak");
    await writeFile(cliPath, agentToolScript(), { mode: 0o700 });
    const result = await execFileAsync(
      process.execPath,
      [cliPath, "assignments", "create", "TASK-34", "--key", "parser-review", "--to", "Reviewer", "--instructions", "Validate the parser and report concrete failures."],
      {
        env: {
          ...process.env,
          AISEVAK_API_URL: `http://127.0.0.1:${address.port}`,
          AISEVAK_AGENT_TOKEN: "test-token"
        }
      }
    );
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(requestPath).toBe("/api/agent-tools/v1/tasks/TASK-34/assignments");
    expect(requestBody).toMatchObject({ key: "parser-review", to: "Reviewer" });
    expect(JSON.parse(result.stdout)).toMatchObject({ assignment: { key: "ASSIGNMENT-7" } });
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(result.stdout).toContain("reports");
    expect(result.stdout).toContain("incidents");
    expect(result.stdout).toContain("schedules");
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
});

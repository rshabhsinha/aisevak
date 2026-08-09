export function agentToolScript(): string {
  return `#!/usr/bin/env node
const apiUrl = process.env.AISEVAK_API_URL || "http://localhost:8787";
const tokenFile = process.env.AISEVAK_AGENT_TOKEN_FILE;
const token = process.env.AISEVAK_AGENT_TOKEN || (tokenFile
  ? process.getBuiltinModule("node:fs").readFileSync(tokenFile, "utf8").trim()
  : undefined);
const args = process.argv.slice(2);
if (!token) fail("AISEVAK_AGENT_TOKEN is missing", "AUTH_MISSING");
main().catch((error) => fail(error && error.message ? error.message : String(error), error && error.code));

async function main() {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) return help();
  const root = args[0];
  if (root === "whoami") return print(await request("/api/agent-tools/v1/whoami"));
  if (root === "capabilities") return print(await request("/api/agent-tools/v1/capabilities"));
  if (root === "context") return print(await request("/api/agent-tools/context"));
  if (root === "show") return print(await request("/api/agent-tools/v1/resources/" + encodeURIComponent(required(args[1], "Resource reference"))));
  if (root === "content") {
    const ref = required(args[1], "Resource reference");
    return print(await request("/api/agent-tools/v1/resources/" + encodeURIComponent(ref) + "/content" + query({ cursor: option("--cursor"), limit: option("--limit") })));
  }
  if (["agent", "agents"].includes(root)) return agents();
  if (["skill", "skills"].includes(root)) return skills();
  if (["thread", "threads"].includes(root)) return threads();
  if (["task", "tasks"].includes(root)) return tasks();
  if (["schedule", "schedules"].includes(root)) return schedules();
  if (["report", "reports"].includes(root)) return reports();
  if (["incident", "incidents"].includes(root)) return incidents();
  if (["credential", "credentials"].includes(root)) return credentials();
  fail("Unknown command. Run: aisevak help", "USAGE");
}

async function skills() {
  const command = args[1] || "path";
  if (command === "path") {
    const path = process.env.AISEVAK_SKILLS_DIR;
    if (!path) fail("AISEVAK_SKILLS_DIR is missing", "CONFIG_MISSING");
    return print({ path });
  }
  if (command === "install") {
    const directory = required(args[2], "Skill directory");
    return print(await request("/api/agent-tools/v1/skills", {
      method: "POST",
      body: readSkillDirectory(directory)
    }));
  }
  fail("Usage: aisevak skills path|install DIRECTORY", "USAGE");
}

function readSkillDirectory(directory) {
  const fs = process.getBuiltinModule("node:fs");
  const pathModule = process.getBuiltinModule("node:path");
  const root = pathModule.resolve(directory);
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("Skill path must be a directory, not a symbolic link", "SKILL_INVALID");
  }
  const markdownPath = pathModule.join(root, "SKILL.md");
  if (!fs.existsSync(markdownPath) || !fs.lstatSync(markdownPath).isFile()) {
    fail("Skill directory must contain SKILL.md", "SKILL_INVALID");
  }
  const markdown = fs.readFileSync(markdownPath, "utf8");
  const files = {};
  let totalBytes = Buffer.byteLength(markdown);
  function visit(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const fullPath = pathModule.join(current, entry.name);
      const info = fs.lstatSync(fullPath);
      if (info.isSymbolicLink()) fail("Symbolic links are not allowed in skills: " + relative, "SKILL_INVALID");
      if (info.isDirectory()) {
        visit(fullPath, relative);
      } else if (info.isFile() && relative !== "SKILL.md") {
        const data = fs.readFileSync(fullPath);
        if (data.includes(0)) fail("Skill files must contain text: " + relative, "SKILL_INVALID");
        const content = data.toString("utf8");
        if (!Buffer.from(content, "utf8").equals(data)) fail("Skill files must be valid UTF-8: " + relative, "SKILL_INVALID");
        files[relative] = content;
        totalBytes += Buffer.byteLength(relative) + data.length;
      }
    }
  }
  visit(root, "");
  if (Object.keys(files).length > 64) fail("A skill may contain at most 64 supporting files", "SKILL_INVALID");
  if (totalBytes > 500000) fail("Installed skill content may not exceed 500 KB", "SKILL_INVALID");
  return { markdown, files };
}

async function agents() {
  const command = args[1] || "list";
  if (command === "list") return print(await request("/api/agent-tools/v1/agents" + listQuery()));
  if (command === "show") return print(await request("/api/agent-tools/v1/agents/" + encodeURIComponent(required(args[2], "Agent reference"))));
  fail("Usage: aisevak agents list|show", "USAGE");
}

async function threads() {
  const command = args[1] || "list";
  if (command === "list") return print(await request("/api/agent-tools/v1/threads" + listQuery()));
  const ref = command === "create" ? null : required(args[2], "Thread reference");
  if (command === "show") return print(await request("/api/agent-tools/v1/threads/" + encodeURIComponent(ref)));
  if (command === "messages") return print(await request("/api/agent-tools/v1/threads/" + encodeURIComponent(ref) + "/messages" + listQuery()));
  if (command === "create") {
    return print(await request("/api/agent-tools/v1/threads", { method: "POST", body: compact({
      title: option("--title", true), description: option("--description", true),
      purpose: await markdown("--purpose"), to: option("--to", true),
      projectId: option("--project-id"), task: option("--task"),
      originThread: option("--origin-thread"), originMessage: option("--origin-message"),
      idempotencyKey: option("--idempotency-key")
    }) }));
  }
  if (command === "send") {
    return print(await request("/api/agent-tools/v1/threads/" + encodeURIComponent(ref) + "/messages", { method: "POST", body: compact({
      body: await markdown("--body", 3), to: option("--to"), parentMessage: option("--reply-to"),
      idempotencyKey: option("--idempotency-key")
    }) }));
  }
  if (command === "complete" || command === "block") {
    const isComplete = command === "complete";
    return print(await request("/api/agent-tools/v1/threads/" + encodeURIComponent(ref) + "/" + command, { method: "POST", body: {
      body: await markdown(isComplete ? "--summary" : "--reason", 3), idempotencyKey: option("--idempotency-key")
    } }));
  }
  fail("Usage: aisevak threads list|show|messages|create|send|complete|block", "USAGE");
}

async function tasks() {
  const command = args[1] || "list";
  if (command === "list") return print(await request("/api/agent-tools/v1/tasks" + listQuery()));
  if (command === "create") return print(await request("/api/agent-tools/v1/tasks", { method: "POST", body: compact({
    title: option("--title", true), description: option("--description", true), body: await markdown("--body"),
    status: option("--status"), projectId: option("--project-id"), agent: option("--agent"),
    idempotencyKey: option("--idempotency-key")
  }) }));
  const ref = required(args[2], "Task reference");
  if (command === "show") return print(await request("/api/agent-tools/v1/tasks/" + encodeURIComponent(ref)));
  if (command === "update") return print(await request("/api/agent-tools/v1/tasks/" + encodeURIComponent(ref), { method: "PATCH", body: compact({
    title: option("--title"), description: option("--description"), body: await optionalMarkdown("--body"), status: option("--status")
  }) }));
  if (command === "assign") return print(await request("/api/agent-tools/v1/tasks/" + encodeURIComponent(ref) + "/assign", { method: "POST", body: { agent: option("--agent", true) } }));
  if (["complete", "reopen"].includes(command)) return print(await request("/api/agent-tools/v1/tasks/" + encodeURIComponent(ref) + "/" + command, { method: "POST", body: { body: await optionalMarkdown("--summary") } }));
  if (command === "comment") return print(await request("/api/agent-tools/tasks/" + encodeURIComponent(ref) + "/comment", { method: "POST", body: { body: await markdown("--body", 3) } }));
  if (command === "attention") {
    const body = await markdown("--reason", 3);
    await request("/api/agent-tools/tasks/" + encodeURIComponent(ref), { method: "PATCH", body: { status: "needs_attention" } });
    return print(await request("/api/agent-tools/tasks/" + encodeURIComponent(ref) + "/comment", { method: "POST", body: { body } }));
  }
  fail("Usage: aisevak tasks list|show|create|update|assign|complete|reopen", "USAGE");
}

async function schedules() {
  const command = args[1] || "list";
  if (command === "list") return print(await request("/api/agent-tools/v1/schedules" + listQuery()));
  if (command === "create") return print(await request("/api/agent-tools/v1/schedules", { method: "POST", body: compact({
    title: option("--title", true), prompt: await markdown("--prompt"), agent: option("--agent", true),
    at: option("--at", true), intervalSeconds: option("--interval-seconds"),
    idempotencyKey: option("--idempotency-key")
  }) }));
  const ref = required(args[2], "Schedule reference");
  if (command === "show") return print(await request("/api/agent-tools/v1/schedules/" + encodeURIComponent(ref)));
  if (command === "pause" || command === "resume") return print(await request("/api/agent-tools/v1/schedules/" + encodeURIComponent(ref) + "/" + command, { method: "POST" }));
  if (command === "delete") return print(await request("/api/agent-tools/v1/schedules/" + encodeURIComponent(ref), { method: "DELETE" }));
  fail("Usage: aisevak schedules list|show|create|pause|resume|delete", "USAGE");
}

async function reports() {
  const command = args[1] || "list";
  if (command === "list") return print(await request("/api/agent-tools/v1/reports" + listQuery()));
  if (command === "create") return print(await request("/api/agent-tools/v1/reports", { method: "POST", body: compact({
    title: option("--title", true), description: option("--description", true), markdown: await markdown("--markdown"),
    projectId: option("--project-id"), thread: option("--thread")
  }) }));
  const ref = required(args[2], "Report reference");
  if (command === "show") return print(await request("/api/agent-tools/v1/reports/" + encodeURIComponent(ref)));
  if (command === "revise") return print(await request("/api/agent-tools/v1/reports/" + encodeURIComponent(ref) + "/revisions", { method: "POST", body: { markdown: await markdown("--markdown") } }));
  if (command === "publish") return print(await request("/api/agent-tools/v1/reports/" + encodeURIComponent(ref) + "/publish", { method: "POST" }));
  fail("Usage: aisevak reports list|show|create|revise|publish", "USAGE");
}

async function incidents() {
  const command = args[1] || "list";
  if (command === "list") return print(await request("/api/agent-tools/v1/incidents" + listQuery()));
  if (command === "declare") return print(await request("/api/agent-tools/v1/incidents", { method: "POST", body: compact({
    title: option("--title", true), description: option("--description", true), severity: option("--severity"),
    markdown: await markdown("--markdown"), projectId: option("--project-id"), to: option("--to")
  }) }));
  const ref = required(args[2], "Incident reference");
  if (command === "show") return print(await request("/api/agent-tools/v1/incidents/" + encodeURIComponent(ref)));
  if (command === "update") return print(await request("/api/agent-tools/v1/incidents/" + encodeURIComponent(ref) + "/updates", { method: "POST", body: { markdown: await markdown("--markdown") } }));
  if (command === "resolve") return print(await request("/api/agent-tools/v1/incidents/" + encodeURIComponent(ref) + "/resolve", { method: "POST", body: { markdown: await optionalMarkdown("--markdown") } }));
  fail("Usage: aisevak incidents list|show|declare|update|resolve", "USAGE");
}

async function credentials() {
  const command = args[1] || "list";
  if (command === "list") return print(await request("/api/agent-tools/credentials"));
  if (command === "get") return print(await request("/api/agent-tools/credentials/" + encodeURIComponent(required(args[2], "Credential name"))));
  if (command === "add") return print(await request("/api/agent-tools/credentials", { method: "POST", body: {
    name: option("--name") || args[2], description: option("--description"), value: await markdown("--value")
  } }));
  fail("Usage: aisevak credentials list|get|add", "USAGE");
}

async function request(path, options = {}) {
  const response = await fetch(apiUrl + path, { method: options.method || "GET", headers: {
    Authorization: "Bearer " + token, ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
  }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let payload; try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || JSON.stringify(payload));
    error.code = payload?.error?.code || "HTTP_" + response.status;
    throw error;
  }
  return payload;
}

function option(name, requiredValue = false) {
  const index = args.indexOf(name); const value = index >= 0 ? args[index + 1] : undefined;
  if (requiredValue && (!value || value.startsWith("--"))) fail(name + " is required", "USAGE");
  return value && !value.startsWith("--") ? value : undefined;
}
function listQuery() { return query({ cursor: option("--cursor"), limit: option("--limit"), status: option("--status"), query: option("--query") }); }
function query(values) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, value); const text = params.toString(); return text ? "?" + text : ""; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function required(value, label) { if (!value || value.startsWith("--")) fail(label + " is required", "USAGE"); return value; }
async function optionalMarkdown(flag) { if (args.includes(flag + "-stdin")) return readStdin(); return option(flag); }
async function markdown(flag, restIndex) { const value = await optionalMarkdown(flag); const rest = restIndex === undefined ? undefined : args.slice(restIndex).filter((item, i, all) => !item.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--"))).join(" ").trim(); const result = value ?? rest; if (!result) fail(flag + " or " + flag + "-stdin is required", "USAGE"); return result; }
async function readStdin() { let value = ""; for await (const chunk of process.stdin) value += String(chunk); return value.replace(/\\r?\\n$/, ""); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
function fail(message, code = "CLI_ERROR") { console.error(JSON.stringify({ error: { code, message } })); process.exit(1); }
function help() { console.log([
  "aisevak whoami | capabilities | show REF | content REF [--cursor CURSOR]",
  "aisevak agents list | agents show AGENT",
  "aisevak skills path | skills install DIRECTORY",
  "aisevak threads list | show | messages | create | send | complete | block",
  "aisevak tasks list | show | create | update | assign | complete | reopen",
  "aisevak schedules list | show | create | pause | resume | delete",
  "aisevak reports list | show | create | revise | publish",
  "aisevak incidents list | show | declare | update | resolve",
  "",
  "Markdown flags accept stdin, for example: --body-stdin, --purpose-stdin, --summary-stdin.",
  "All list commands support --limit, --cursor, --status, and --query."
].join("\\n")); }
`;
}

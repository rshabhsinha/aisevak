# Aisevak

A self-hosted coordination, context, and messaging layer for isolated agents running in a VM.

Agents coordinate entirely through the `aisevak` CLI. Durable threads hold shared history and outlive individual model turns; each participating agent keeps its own provider session for that thread, so queued follow-ups resume the same private model context. Unassigned tasks route to the Orchestrator, while authorized agents can address another agent directly when their workflow calls for it.

Every agent-visible resource has a stable key, title, description, status, and bounded content preview. Lists and Markdown content are cursor-paginated so agents can inspect context lazily:

```bash
aisevak whoami
aisevak capabilities
aisevak agents list --limit 20
aisevak show TASK-12
aisevak content REPORT-4 --cursor CURSOR
```

Messaging, platform work, reports, and incidents use the same CLI surface:

```bash
aisevak threads create --title "Review parser" --description "Independent correctness review" \
  --to Reviewer --purpose-stdin
aisevak threads send THREAD-8 --to Builder --body-stdin
aisevak threads complete THREAD-8 --summary-stdin
aisevak tasks create --title "Add regression test" --description "Cover malformed input" --body-stdin
aisevak reports create --title "Evaluation" --description "Scenario findings" --markdown-stdin
aisevak incidents declare --title "Queue stalled" --description "No deliveries presented" \
  --severity high --markdown-stdin
```

Addressed messages create durable per-recipient deliveries. The runner presents them serially for each agent/thread pair, retries transient failures up to three times, and records delivery state. Only the triggered agent can complete or block an active thread; that atomically sends one final result to the triggering agent. The result is a notification and does not produce an automatic reply. If more work is needed, the triggering agent can explicitly send a later message on the same thread, reactivating it without reopening a linked completed task.

Skills and capabilities are separate. Installed skills live in the persistent `${MANAGED_ROOT}/skills` catalog (exposed to agents as `$AISEVAK_SKILLS_DIR`), and the Skills tab follows that directory. The `$aisevak-cli` skill is installed for every agent by default so each isolated session knows how to inspect context and coordinate with judgment. Additional agent, project, and task skill links remain selective. Backend-enforced capabilities control which CLI mutations that agent may perform. Selected skills are copied into each thread's isolated `$CODEX_HOME/.agents/skills` view when it runs.

## Local development

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:8787`.
The default local `.env` stores managed workspaces and Codex homes under `.aisevak-managed/`.

After creating the first owner account, open **Manage → ChatGPT** to connect a ChatGPT subscription through the browser. Aisevak uses Codex device-code authentication for remote and headless hosts, encrypts the shared credential in PostgreSQL, and materializes it only into runner-owned Codex homes. An OpenAI API key entered during onboarding remains supported as a fallback.

## Host install

```bash
sudo ./scripts/install.sh
```

The installer creates app directories under `/opt/aisevak` and managed workspaces under `/srv/aisevak`, starts Docker Compose services, and installs a host-native runner service so Codex can access imported repositories on disk.

## Host updates

Keep a checkout of this repository on the deployment host, then update from the deploy branch:

```bash
./scripts/update.sh main
```

The update script fast-forwards the checkout and runs the installer with sudo. Each install is staged under `/opt/aisevak/releases`, built before activation, then switched into `/opt/aisevak/current`. Existing `/opt/aisevak/.env`, `/srv/aisevak` workspaces, and the Compose Postgres volume are preserved. Volume preservation alone does not make PostgreSQL layouts compatible: when upgrading an existing Aisevak deployment to the PostgreSQL 18 parent mount, the installer stops database writers, requires a backup, places or verifies the stopped cluster in PostgreSQL 18's `18/docker` subdirectory, validates it, and aborts before activation if migration fails.

When an active Postgres container exists, the installer writes a compressed backup to `/opt/aisevak/backups` before restarting services. Set `AISEVAK_REQUIRE_BACKUP=1` to abort updates if a backup cannot be created, or `AISEVAK_SKIP_BACKUP=1` to skip backups intentionally.

The sanitized Azure deployment runbook, which keeps host-specific values outside the repository, is documented in [docs/AZURE_DEPLOYMENT.md](docs/AZURE_DEPLOYMENT.md).

## Security model

This app is for trusted small teams. Codex sessions are driven through `codex app-server` with approvals disabled and `danger-full-access` sandbox policy. Run it on a dedicated machine or VM.

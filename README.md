# Aisevak

A self-hosted task board for running local Codex sessions against local or imported GitHub repositories.

Tasks can be assigned directly to a worker agent or left on `Auto-route`. Auto-routed tasks are picked up by the Dispatcher agent, either when a user clicks Run or on the default 5 minute heartbeat. Dispatcher runs do not appear on the task board; the `Agent Runs` tab shows every Dispatcher and worker Codex session.

Codex runs receive an `aisevak` CLI on PATH so agents can update the board without touching the database directly:

```bash
aisevak context
aisevak task assign TASK-12 --agent Builder --run
aisevak task attention TASK-12 "Blocked on missing GitHub token"
aisevak task create --title "Add regression test" --status needs_attention
```

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

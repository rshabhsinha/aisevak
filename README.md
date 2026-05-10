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

## Host install

```bash
sudo ./scripts/install.sh
```

The installer creates app directories under `/opt/aisevak` and managed workspaces under `/srv/aisevak`, starts Docker Compose services, and installs a host-native runner service so Codex can access imported repositories on disk.

## Security model

This app is for trusted small teams. Codex task runs intentionally use `--dangerously-bypass-approvals-and-sandbox`, `approval_policy = "never"`, and `sandbox_mode = "danger-full-access"`. Run it on a dedicated machine or VM.

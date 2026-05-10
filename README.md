# Aisevak

A self-hosted task list for running local Codex sessions against local or imported GitHub repositories.

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

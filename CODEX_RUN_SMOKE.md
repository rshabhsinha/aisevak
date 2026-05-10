# Aisevak Smoke Report

Smoke date: 2026-05-10

## Scope

This was a real, low-risk Aisevak smoke exercise against this repository. The requested task was executed by a real Codex agent and limited to repository inspection, non-destructive verification commands, and creation of this report at the repository root.

No application source files were intentionally changed.

## Architecture Summary

The app is a pnpm monorepo with four primary workspaces:

- `apps/web`: React and Vite frontend. It handles onboarding, login, projects, agents, tasks, GitHub import controls, run controls, and run event display.
- `apps/api`: Fastify HTTP API. It manages auth cookies, onboarding, CRUD for projects/agents/tasks, GitHub connections/import jobs, run queue creation, run event streaming, and pull request preparation/creation.
- `apps/runner`: Host-side worker process. It polls the database for queued repository imports and queued Codex task runs, performs workspace preparation, launches Codex, and persists run results/events.
- `packages/core`: Shared database, migration, auth, crypto, GitHub, and Codex helper logic used by the API and runner.

Runtime services are defined by `docker-compose.yml`:

- `postgres`: primary database.
- `api`: containerized Fastify API on port `8787`.
- `web`: containerized static frontend served by nginx on port `8080`.

For local development, `README.md` documents:

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

## Runner Flow

1. A user creates or selects a project, an agent, and a task in the web UI.
2. The API route `POST /api/tasks/:id/runs` loads the task, project, and agent, builds a Codex prompt, creates or reuses a task session, and inserts a queued row in `task_runs`.
3. The runner process starts with `apps/runner/src/index.ts`, runs migrations, ensures `MANAGED_ROOT` exists, and loops over import jobs and run jobs.
4. For queued repository imports, the runner clones or updates GitHub repositories and creates/updates the matching project row.
5. For queued task runs, the runner marks the run as `running`, prepares the workspace, writes a per-task `CODEX_HOME/config.toml`, copies host Codex auth when no API key secret is configured, and spawns:

```bash
codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
```

6. If an explicit model is configured, `--model <model>` is added. If a prior Codex thread id exists, the runner uses `resume <thread_id> -`.
7. Codex stdout is read as JSONL. Each line is parsed, normalized, redacted for known secrets, and stored in `run_events`.
8. If a Codex thread id is observed, the runner saves it on both `task_sessions` and `task_runs` so later runs can resume the same thread.
9. The web UI reads historical events through `GET /api/runs/:id/events` and streams active runs through `GET /api/runs/:id/stream`.
10. When the process exits, the runner records `succeeded`, `failed`, or `cancelled`, stores raw stdout/stderr, exit code, timestamps, and error text when applicable.

## Verification Performed

These low-risk checks passed in this workspace:

```bash
node --version
# v20.19.3

pnpm --version
# 9.15.0

codex --version
# codex-cli 0.130.0-alpha.5

pnpm test
# 2 test files passed, 11 tests passed

pnpm typecheck
# packages/core, apps/web, apps/api, and apps/runner typechecked successfully

pnpm build
# packages/core, apps/web, apps/api, and apps/runner built successfully
```

The production build generated temporary `dist` directories during verification; those generated artifacts were removed afterward so the smoke report remains the only intentional file addition.

## Verification Commands That Should Pass

For a healthy checkout with dependencies installed, these commands should pass:

```bash
pnpm test
pnpm typecheck
pnpm build
```

For a host with the Codex CLI installed and configured, this command should also pass:

```bash
codex --version
```

For a fully configured local app instance with Postgres available, these commands should initialize and run the app:

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

The API health endpoint should then return `{ "ok": true }` from:

```bash
curl http://localhost:8787/api/health
```

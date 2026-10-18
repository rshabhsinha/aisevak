# Contributing

Thanks for helping improve Aisevak.

## Repository layout

```
apps/
  api/       Fastify API, PostgreSQL state, and the coordination layer
  runner/    Picks up queued turns and runs harnesses in isolated worktrees
  web/       React control room (http://localhost:5173 in development)
packages/
  cli/       The `aisevak` CLI that agents use inside their runs
  core/      Shared types, migrations, harness adapters, and runtime events
scripts/     install.sh, update.sh, and the Codex runtime publisher the installer uses
tests/       Cross-package tests and fixtures
docs/        Design language, provider event notes, and UI QA checklists
```

## Setup

You need Node.js 20+, pnpm 9+, Docker, and Git 2.36+ (the runner uses `git worktree list -z`).

```bash
git clone https://github.com/rshabhsinha/aisevak.git
cd aisevak
pnpm install
cp .env.example .env
```

Set `SECRET_KEY` (a base64-encoded 32-byte key) and `COOKIE_SECRET` in `.env`; the [README](README.md#quick-start) has a one-line generator. Then start PostgreSQL and run migrations:

```bash
docker compose up -d postgres
pnpm db:migrate
```

Run the API, runner, and web app together with `pnpm dev`, or one at a time with `pnpm dev:api`, `pnpm dev:runner`, and `pnpm dev:web`.

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
```

Some runner tests spawn real processes and can time out on a busy machine. If they do, rerun with a longer timeout, for example `pnpm exec vitest run --testTimeout=60000`.

UI changes should follow [docs/design-language.md](docs/design-language.md) and be checked in light and dark mode at desktop and narrow widths. [docs/MOBILE_UI_QA.md](docs/MOBILE_UI_QA.md) lists the mobile checks.

## Guidelines

- Keep commits focused on one change.
- Code that runs inside agent runs must not assume it is in the root checkout; runs execute in runner-managed worktrees.
- New or changed persistent state needs a migration in `packages/core`.
- Provider output goes through the runtime event adapters in `packages/core/src/runtime`; add a fixture when you change how a provider's events are mapped.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

# Contributing to AiSevak

Thank you for contributing to AiSevak! AiSevak is the open-source host-native operating system and multi-agent coordination layer for software engineers.

---

## Code of Conduct & Principles

1. **Host-Native Determinism**: AI agents coordinate as real Linux/macOS processes via durable threads and dedicated Git worktrees.
2. **Zero Token Markup**: Users always connect their own model credentials directly; no middleman fee or telemetry proxies.
3. **No Fluff**: Keep tools, CLI arguments, and docs concise, typed, and well-tested.

---

## Monorepo Architecture

AiSevak is organized as a pnpm workspace:

```
aisevak/
├── apps/
│   ├── api/        # Fastify + PostgreSQL coordination backend & SSE dispatcher
│   ├── runner/     # Host-native turn delivery & isolated execution supervisor
│   ├── web/        # React 19 control room client (local dev port 5173)
│   └── site/       # React 19 marketing site & waitlist app (local dev port 5174)
├── packages/
│   ├── cli/        # `aisevak` CLI socket interface used by agents and developers
│   └── core/       # Shared TypeScript types, migrations, and database schema
└── scripts/
    └── install.sh  # Host-native Linux systemd daemon installer
```

---

## Development Setup

### Prerequisites
- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Docker & Docker Compose (for local PostgreSQL 18)
- Git >= 2.38 (supporting worktrees)

### Getting Started

1. **Clone the repository**:
   ```bash
   git clone https://github.com/rshabhsinha/aisevak.git
   cd aisevak
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Configure environment & database**:
   ```bash
   cp .env.example .env
   docker compose up -d postgres
   pnpm db:migrate
   ```

4. **Start the full local development stack**:
   ```bash
   pnpm dev
   ```
   Or run specific services:
   - Web Control Room: `pnpm dev:web` (`http://localhost:5173`)
   - Marketing Site: `pnpm dev:site` (`http://localhost:5174`)
   - Coordination API: `pnpm dev:api` (`http://localhost:8787`)
   - Host Runner: `pnpm dev:runner`

---

## Testing & Type Checking

Run all test suites across packages before opening a pull request:

```bash
# Type check all packages
pnpm typecheck

# Run Vitest test suites
pnpm test

# Build marketing site
pnpm build:site
```

---

## Pull Request Guidelines

- **Atomic Commits**: Keep Git commits focused on single concerns.
- **Git Worktree Compatibility**: Ensure tools never assume working inside the root repo checkout when executing inside runner-managed worktrees.
- **Durable State Serialization**: Any new coordination entity must be versioned in `@aisevak/core` database migrations.

---

## License

AiSevak is open-source software licensed under the [MIT License](LICENSE).
Created by [PromptLabs Pvt Ltd](https://promptlabs.link).

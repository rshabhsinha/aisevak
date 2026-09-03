<div align="center">
  <img src="apps/site/public/favicon.svg" width="64" height="64" alt="AiSevak Logo" />
  <h1>AiSevak</h1>
  <p><strong>The host-native autonomous operating system and multi-agent coordination layer for software engineers.</strong></p>

  <p>
    <a href="https://aisevak.com"><img src="https://img.shields.io/badge/Website-aisevak.com-7c72ff?style=flat-square" alt="Website" /></a>
    <a href="https://aisevak.embedr.dev"><img src="https://img.shields.io/badge/Live%20Demo-aisevak.embedr.dev-34d399?style=flat-square" alt="Live Demo" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/rshabhsinha/aisevak/stargazers"><img src="https://img.shields.io/github/stars/rshabhsinha/aisevak?style=flat-square&color=fbbf24" alt="GitHub Stars" /></a>
  </p>
</div>

---

## ⚡ The Multi-Agent Problem & AiSevak Solution

Running isolated coding agents (OpenAI Codex, Claude Code, Cursor, OpenCode) in single chat tabs causes severe context degradation, uncoordinated branch collisions, and exponential token waste.

**AiSevak** transforms isolated LLMs into a coordinated autonomous engineering squad with deterministic host guarantees:

1. **Durable Multi-Agent Threads**: Conversations outlive individual model turns; each agent retains its own private provider session for serialized follow-ups with zero context drift.
2. **Isolated Git Worktrees**: Every task executes in its own dedicated, sandboxed branch worktree (`/srv/aisevak/worktrees/task-xxx`), allowing parallel work without Git locks.
3. **Host-Native Linux Execution**: Runs real bash commands, Playwright headless browsers, compilers, Docker services, and AST-grep directly on host hardware.
4. **$0 Token Markup (BYO AI)**: Connect your existing OpenAI Codex (device-code auth), Anthropic Claude Code, Cursor, or local Ollama subscriptions directly. No middleman fee.
5. **Unified CLI Socket (`aisevak`)**: Human engineers and autonomous agents discover tasks, inspect state, and exchange steering instructions through the exact same CLI.
6. **Autonomous Sentry & Scheduled Cron**: Agents continuously probe endpoints, triage CloudWatch 500 error spikes, and open automated fix PRs.

---

## 🚀 Quick Start (Local Development)

### 1. Clone & Setup
```bash
git clone https://github.com/rshabhsinha/aisevak.git
cd aisevak
pnpm install
cp .env.example .env
```

### 2. Start PostgreSQL & Run Migrations
```bash
docker compose up -d postgres
pnpm db:migrate
```

### 3. Launch Development Stack
```bash
pnpm dev
```

- **Web Control Room**: [`http://localhost:5173`](http://localhost:5173)
- **Marketing Site (`apps/site`)**: [`http://localhost:5174`](http://localhost:5174)
- **Coordination API**: [`http://localhost:8787`](http://localhost:8787)

---

Tasks are the durable job identity: every task has an immutable `work_scope`/`work_key`
and exactly one coordination thread. Orchestrators delegate through keyed assignments;
assignment retries reuse the same assignment, agent thread, and provider session whenever
possible. The API records would-reject operations in `job_safety_events`. Set
`AISEVAK_JOB_SAFETY_MODE=audit` during a rollout canary to observe violations without
rejecting them, then switch to `enforce` (the default) after the audit window.

After creating the first owner account, open **Manage → ChatGPT** to connect a ChatGPT subscription through the browser. Aisevak uses Codex device-code authentication for remote and headless hosts, encrypts the shared credential in PostgreSQL, and materializes it only into runner-owned Codex homes. An OpenAI API key entered during onboarding remains supported as a fallback.

## 💻 CLI Coordination Surface

Human developers and autonomous agents coordinate through the identical CLI:

```bash
# Identity & capabilities
aisevak whoami
aisevak capabilities
aisevak agents list --limit 20

# Create orchestrated task and worktree
aisevak tasks create --title "Refactor USB-C staggered footprint" \
  --description "Apply 0.65mm pin offset" --to "Builder Prime" --body-stdin

# Steer active turn stream via stdin
aisevak threads send THREAD-08 --to "Lead Code Reviewer" --body-stdin

# Atomic thread completion
aisevak threads complete THREAD-08 --summary-stdin

# Sentry & incident triage
aisevak incidents declare --title "Queue latency high" --severity high --markdown-stdin
```

---

## 🔧 Operator Notes

- **Runner pool**: independent turns run in parallel. Tune with `RUNNER_MAX_CONCURRENCY` (default `4`, max `32`) and `RUNNER_POLL_MS` (default `1500`). Turns on one agent thread stay serialized.
- **Harnesses**: worker turns require a connected provider. Codex uses device-code auth (API key fallback); Cursor turns require a `CURSOR_API_KEY` (keychain subscriptions never reach worker homes); OpenCode reads stored or host `auth.json`.
- **Skills vs capabilities**: installed skills live in `${MANAGED_ROOT}/skills` and are mounted per-thread as `$AISEVAK_SKILLS_DIR`; backend-enforced capabilities gate which CLI mutations each agent may perform.
- **GitHub**: connect via **Manage → Connectors** with a classic PAT (`repo`, `read:org`, `gist`). The runner signs in `gh`, shares the CLI credential helper with agents, and discards the token.
- **Security model**: for trusted small teams. Harnesses run with approvals disabled and full host access — use a dedicated machine or VM.

---

## 🛠️ Production Host Deployment

Deploy AiSevak directly to an Ubuntu 22.04+ VM or AWS EC2 instance:

```bash
sudo ./scripts/install.sh
```

The host installer:
- Deploys directory structure under `/opt/aisevak` and persistent workspaces at `/srv/aisevak`.
- Configures Docker Compose for PostgreSQL 18 and Caddy zero-downtime TLS reverse proxy.
- Installs and activates the host-native systemd daemon (`aisevak-runner.service`).

For sanitized AWS EC2 and Systems Manager runbooks, see [docs/AWS_DEPLOYMENT.md](docs/AWS_DEPLOYMENT.md).

---

## ☁️ AiSevak Cloud (Founding Member Launch)

Prefer zero-maintenance infrastructure? Reserve a dedicated, single-tenant 4 vCPU / 8GB NVMe VM with automated rolling upgrades and encrypted S3 backups at **[aisevak.com](https://aisevak.com)** ($79/mo locked for life).

---

## 🏛️ Brand Lineage & License

AiSevak was created by **[PromptLabs Pvt Ltd](https://promptlabs.link)** (Directors: Rishabh Sinha & Amit Kumar Modi) to orchestrate agents developing **[Embedr](https://embedr.app)**, the AI-powered IDE for embedded systems and hardware firmware.

Licensed under the **[MIT License](LICENSE)**.

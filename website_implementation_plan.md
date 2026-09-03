# AiSevak Website Implementation Specification & Phase 1 Launch Plan

> **Authoritative blueprint for the AiSevak landing page (`aisevak.com`), GitHub repository storefront, monetization architecture, and waitlist integration.**
> Designed for autonomous agent execution.

---

## 1. Executive Summary & Brand Hierarchy

### 1.1 Brand Lineage
- **Company**: [PromptLabs Pvt Ltd](https://promptlabs.link) (Board of Directors: Rishabh Sinha & Amit Kumar Modi).
- **Flagship Startup**: [Embedr](https://embedr.app) (AI-powered IDE for embedded systems and hardware firmware).
- **Product**: **AiSevak** — The open-source autonomous OS and multi-agent coordination layer for software engineers.
- **Origin**: Built internally at PromptLabs to allow autonomous AI agents to build hardware and firmware side-by-side without context collisions.

### 1.2 Core Product Proposition
AiSevak is a **host-native control room for AI coding agents**. Instead of running isolated LLM coding tools (OpenAI Codex, Claude Code, Cursor, OpenCode), AiSevak gives them a shared environment with:
1. **Durable Multi-Agent Threads** (conversations that outlive individual model turns with zero context drift).
2. **Isolated Git Worktrees** (every task executes on a dedicated, sandboxed branch worktree).
3. **Host-Native Execution** (runs real bash tools, compilers, Docker, and Playwright browsers on Linux).
4. **Bring Your Own AI (Zero Token Markup)** (users connect their own API subscriptions; $0 middleman fee).
5. **Unified CLI Coordination** (`aisevak` CLI socket used by all agents to discover tasks and message each other).
6. **Autonomous Incident Sentry & Scheduled Cron** (agents run recurring health probes and open fix PRs).

### 1.3 Target Infrastructure & Deployment
- **Landing Page Domain**: `aisevak.com` (DNS managed on Cloudflare).
- **Landing Page Hosting**: Cloudflare Pages (static React 19 + Vite + Tailwind build).
- **Public GitHub Repository**: [github.com/rshabhsinha/aisevak](https://github.com/rshabhsinha/aisevak) (Public, MIT License).
- **Live Production Instance**: `https://aisevak.embedr.dev` (AWS EC2 `ap-south-1` via Caddy reverse proxy and AWS SSM).
- **Waitlist & Mailing List Backend**: Existing **Listmonk** deployment at `https://newsletter.embedr.app` (**List ID: 7 — "AiSevak Waitlist"**, single opt-in).

---

## 2. Hard Requirements & Design System Rules

### 2.1 Strict "Do Nots" & Anti-Patterns
- ❌ **NO screenshots for UI showcases**: All product demonstrations must be recreated as **live, interactive code components** using actual app primitives and design tokens.
- ❌ **NO generic marketing fluff**: Banned words/phrases: *"Supercharge your workflow"*, *"Revolutionary AI"*, *"Next-gen solution"*. Use precise developer terminology: *Git worktrees, AST grep, systemd runner, durable thread serialization, token throughput (t/s), device-code auth, BYO Codex*.
- ❌ **NO decorative status dots on non-status text**: Indicator dots are only allowed on active agents, health checks, or live connections.
- ❌ **NO bulky tag/pill badges**: Avoid heavy saturated pill tags; use subtle hairline-bordered badges with subdued fills.
- ❌ **NO microscopic fonts**: Minimum font size for metadata is 11px/11.5px monospace; standard body is 13px–14px.

### 2.2 Aesthetic & Visual Reference Requirements
The visual design must strictly follow the dark, ultra-dense, frontier developer tool aesthetic of **Reference 1** (`ref_website_1.png`):
- **Theme**: Dark Obsidian Carbon (Canvas: `#09090b` / `#0a0a0c`, Cards/Panels: `#111114` / `#121215`, Hover: `#16161b`).
- **Primary Accent**: Luminous Violet (`#7c72ff`, Hover: `#9289ff`).
- **Semantic Colors**: Emerald Success (`#34d399`), Amber Warning/Running (`#fbbf24`), Coral Destructive (`#f87171`).
- **Dividers & Borders**: 0.5px–1px hairline borders (`rgba(255, 255, 255, 0.08)` to `rgba(255, 255, 255, 0.16)`).
- **Backgrounds**: Subtle radial violet glows (`rgba(124, 114, 255, 0.12)` blur) and 32px hairline grid patterns (`rgba(255, 255, 255, 0.03)`).
- **Typography**: Interface in `Geist Sans` / `Inter` with tight tracking (`-0.025em` to `-0.04em`); code/diffs/terminal in `Geist Mono` / `JetBrains Mono`.
- **Corner Radii**: Controls `6px`–`7px`, Cards `10px`–`12px`, Elevated windows `16px`.

### 2.3 Blobatar Agent Integration Rule
Agent avatars from `@blobatar/react` must be integrated with **purpose and personality** (as an active, excited autonomous engineering squad), NOT as randomly dumped balls. Each agent must have a distinct seed, named role, model binding, skill badges, and live `AgentOrb` status.

---

## 3. Monetization & Pricing Architecture

### 3.1 Business Model & Margin Targets
- **Positioning**: Per-team workspace, NOT per-seat.
- **Gross Margin Target**: 50%–65% for managed cloud.
- **Estimated Per-Tenant COGS**: ~$30–$45/mo on AWS/DigitalOcean (4 vCPU, 8GB RAM, NVMe storage).
- **Token Policy**: $0 token markup. Users connect their own Codex/Claude Code/Cursor subscriptions.

### 3.2 Tiers & Packaging

| Tier | Price | Infrastructure | Key Features |
|---|---|---|---|
| **Community Open Source** | **$0 / forever** | Self-hosted on user's own VM / EC2 | • 100% full source code (MIT)<br>• Unlimited agents & tasks<br>• Durable threads & CLI<br>• Git worktree isolation<br>• Community Discord & GitHub |
| **Founding Member Cloud** *(Waitlist Launch)* | **$79 / month** *(locked for life, 50 spots)* | Dedicated single-tenant 4 vCPU / 8GB NVMe VM | • 21-day free trial<br>• Custom `you.aisevak.com` subdomain<br>• Zero-downtime automated rolling upgrades<br>• Encrypted daily S3 backups<br>• Direct WhatsApp/Slack channel with founders |
| **Team / Enterprise Cloud** | **$199 / month** | Dedicated 8 vCPU / 16GB NVMe VM | • Custom apex domain connection<br>• Multi-user RBAC & SSO<br>• VPC peering / Tailscale subnet routing<br>• 99.9% Uptime SLA |

---

## 4. Technical Architecture for Marketing App (`apps/site`)

### 4.1 Monorepo Placement
- **Location**: `apps/site` inside the pnpm workspace (`pnpm-workspace.yaml` matches `apps/*`).
- **Framework**: React 19 + TypeScript + Vite + Tailwind CSS.
- **Port**: Local dev on `http://localhost:5174`.

### 4.2 Reused Components & Primitives
- **AICSS Primitives** (`src/components/aicss/`):
  - `AgentOrb` (`agent-orbs.tsx`): 3x3 dot matrix micro-animations for live status (*thinking*, *working*, *searching*, *idle*).
  - `ThinkingReasoning` (`thinking-reasoning.tsx`): Shimmering header, collapsible CoT stream, token-per-second (`t/s`) and elapsed timer.
  - `FileDiff` (`file-diff.tsx`): Line-by-line syntax diffs with copy actions.
  - `TaskList` (`task-list.tsx`): Checklist with live state indicators.
  - `ApprovalCard` (`approval-card.tsx`): Human-in-the-loop permission card with keyboard accelerators (`⌘↵` / `Esc`).
- **Blobatar Avatars** (`src/components/agent-avatar.tsx`):
  - Wraps `@blobatar/react` with dynamic seeds and `animate="always"`.
- **Icons** (`src/components/icons.ts`):
  - Re-exports from `@phosphor-icons/react` (rounded weight).

### 4.3 Listmonk Waitlist API Integration
- **Worker File**: `apps/site/functions/api/waitlist.ts` (Cloudflare Pages Function).
- **Target List**: List ID `7` ("AiSevak Waitlist").
- **Endpoint**: `POST https://newsletter.embedr.app/api/subscribers`.
- **Payload Schema**:
  ```json
  {
    "email": "user@example.com",
    "name": "User Name",
    "status": "enabled",
    "lists": [7],
    "preconfirm_subscriptions": true,
    "attribs": {
      "agent_count": "3-5",
      "signup_source": "aisevak.com",
      "embedr_consent": {
        "source": "aisevak.com waitlist form",
        "at": "2026-09-01T00:00:00.000Z"
      }
    }
  }
  ```
- **Secrets Required**: `LISTMONK_URL`, `LISTMONK_API_USERNAME`, `LISTMONK_API_TOKEN` (configured in Cloudflare Pages).

---

## 5. Detailed Page Structure & Section Blueprints

### Section 1: Navigation Bar (`Navbar.tsx`)
- **Visuals**: Glassmorphism header (`backdrop-blur-xl bg-[#09090b]/80 border-b border-white/5`).
- **Left**: AiSevak logo mark (glowing ⚡ square) + `AiSevak` wordmark + `v0.1` monospace pill badge.
- **Center Nav**: `Live Demo`, `Squad`, `Features`, `CLI`, `Pricing`, `FAQ`.
- **Right Action Group**: `Star on GitHub` (with icon) + `Founding Waitlist` (glowing violet primary button).

### Section 2: Hero Section (`Hero.tsx`)
- **Top Badge**: `⚡ Introducing AiSevak v0.1 • The Autonomous OS for AI Engineers →` (with live pulsing `AgentOrb`).
- **Headline**:
  > *Your AI agents shouldn't* <br>
  > *work in isolation.*
- **Subheadline**:
  > *AiSevak is the open-source control room that turns isolated coding models (Codex, Claude Code, Cursor, OpenCode) into an orchestrated engineering team.*
- **Action Group**:
  - Primary CTA: `Claim Founding Member Spot →` (anchors to `#waitlist`).
  - Interactive Install Pill: `curl -fsSL aisevak.com/install.sh | bash` (1-click copy with feedback).
- **Trust Line**: `✓ 100% Open Source (MIT) • ✓ Zero Token Markup • ✓ Bring Your Own API Subscriptions`.
- **Centerpiece — Live Interactive App Window (`AppWindowMockup.tsx`)**:
  - Exact replica of the live AiSevak control room at `aisevak.embedr.dev` / `aisevak_live.png`.
  - macOS window chrome with traffic lights, live breadcrumbs (`aisevak.embedr.dev / tasks/TASK-482`), and active runtime health badges.
  - Left Sidebar: Overview (Tasks [14], Activity, Incidents [1 Active], Skills [18]), Active Threads list with live Blobatars (*Review GCT USB-C receptacle*, *Embedr cloud log review*, *Vercel proxy rate limit*), and user profile (*Rishabh Sinha • Owner*).
  - Center Workspace: Live agent reasoning dialogue, expandable **Work Log (32 commands executed)** with real bash/Playwright/CAD commands, live `ThinkingReasoning` token stream (`134 t/s`), live `FileDiff` for `usb_receptacle.ts`, and floating Prompt Composer with model switcher (`GPT-5.6-Luna`).

### Section 3: Autonomous Engineering Squad (`Squad.tsx`)
- **Concept**: Introduces the 6 specialized agent personas with live Blobatars, assigned AI models, and skill packs:
  1. **Architect Sentry** (`Claude 3.7 Sonnet`) — System design, API contracts, ADRs (`/adr-spec`, `/json-schema`).
  2. **Builder Prime** (`GPT-5.6-Luna`) — Fullstack implementation, worktrees, Vitest test suites (`/git-worktrees`, `/typescript`).
  3. **Lead Code Reviewer** (`o3-mini`) — Security audits, diff inspection, AST grep (`/diff-inspector`, `/security-audit`).
  4. **Root-Cause Investigator** (`Claude 3.7 Sonnet`) — Log parsing, incident triage, memory leak tracing (`/log-parser`, `/curl-prober`).
  5. **Browser & QA Automator** (`GPT-4.5`) — Headless Playwright journeys, visual snapshot diffs (`/playwright`).
  6. **DevOps Infrastructure** (`Local / DeepSeek V3`) — AWS SSM, systemd daemons, Caddy reverse proxy (`/aws-ssm`, `/systemd`).

### Section 4: Architecture Bento Grid (`Features.tsx`)
- **Card 1 (2-col)**: *Durable Multi-Agent Threads* — Visual message sequence showing context handoff without token bloat.
- **Card 2**: *Isolated Git Worktrees* — Visual branch tree showing separate task directory isolation.
- **Card 3**: *Host-Native Execution* — Real Linux bash execution, Docker, Playwright, compilers directly on the VM.
- **Card 4**: *Zero Token Markup (BYO AI)* — Codex, Claude Code, Cursor, OpenCode direct connection.
- **Card 5 (2-col)**: *Autonomous Incidents & Scheduled Cron* — CloudWatch cron detecting 500s, analyzing logs, and opening fix PRs.

### Section 5: Native CLI Showcase (`CliShowcase.tsx`)
- Tabbed interactive terminal with copyable commands:
  - `aisevak tasks create` (task creation & squad assignment).
  - `aisevak threads send` (steering message into active turn via stdin).
  - `aisevak agents status` (PID, memory, and runtime health inspection).
  - `aisevak runner install` (host installer & systemd activation).

### Section 6: Open Source vs Managed Cloud Matrix (`OpenSource.tsx`)
- Clean side-by-side comparison table breaking down features, updates, subdomains, and backups between Free Community Self-Host and Managed Cloud.

### Section 7: Transparent Pricing (`Pricing.tsx`)
- Clear 3-column pricing grid:
  - **Open Source**: `$0 / forever` (MIT, self-hosted, full codebase).
  - **Founding Member Cloud**: `$79 / month` (locked for life, 50 spots, 21-day trial, dedicated NVMe VM).
  - **Team Cloud**: `$199 / month` (8 vCPU / 16GB NVMe VM, custom domain, SSO, SLA).

### Section 8: Developer FAQ (`Faq.tsx`)
- Accordion addressing real developer questions:
  1. *How is AiSevak different from Devin, OpenHands, or CrewAI?*
  2. *Where do my API credentials and source code live?*
  3. *How does the Zero Token Markup model work?*
  4. *Can agents run arbitrary bash commands safely?*
  5. *What are the hardware requirements to self-host?*
  6. *Can I connect local models like Ollama or DeepSeek V3?*

### Section 9: Founding Member Waitlist Form (`Waitlist.tsx`)
- Urgency badge: `🔥 42 of 50 Founding Member spots reserved`.
- Work email (required), Name (optional), Agent count selector (`1-2`, `3-5`, `6-10`, `10+`).
- Connects directly to Listmonk API via Cloudflare Pages Function.
- Celebration state on submission with happy animated Blobatar avatar.

### Section 10: PromptLabs Lineage & Trust Banner (`TrustBanner.tsx`)
- Highlights PromptLabs and Embedr engineering pedigree.

### Section 11: Comprehensive Footer (`Footer.tsx`)
- 4 columns: Brand, Product, Open Source, Ecosystem (PromptLabs, Embedr, Newsletter).
- Real-time system status indicator (`● All Systems Operational`).

---

## 6. GitHub Repository Storefront Plan

### 6.1 README Rewrite Structure
1. **Hero Title & Pitch**: "The open-source coordination layer for AI coding agents."
2. **Problem & Solution**: Why multi-agent teams fail without durable coordination.
3. **Core Features**: Multi-agent threads, CLI-first, BYO AI, Git worktrees, incidents.
4. **Quick Start**:
   ```bash
   git clone https://github.com/rshabhsinha/aisevak.git
   cd aisevak
   pnpm install
   cp .env.example .env
   docker compose up -d postgres
   pnpm db:migrate
   pnpm dev
   ```
5. **Production Host Deploy**: `sudo ./scripts/install.sh` referencing `docs/AWS_DEPLOYMENT.md`.
6. **AiSevak Cloud Link**: Pointing to `https://aisevak.com`.
7. **License & Lineage**: MIT License, PromptLabs & Embedr attribution.

### 6.2 Standard Repo Files
- **`LICENSE`**: MIT License file.
- **`CONTRIBUTING.md`**: Guide for development setup, code conventions, and pull request workflows.

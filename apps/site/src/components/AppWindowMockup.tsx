import { useState, useEffect } from "react";
import { AgentAvatar } from "./agent-avatar";
import { AgentOrb, DotMatrixLoader } from "./aicss";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bot,
  Calendar,
  ChatsIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDashed,
  CheckCircle2,
  CreditCard,
  FolderGit2,
  Github,
  Headset,
  Info,
  KeyRound,
  LayoutDashboard,
  Play,
  Plus,
  RefreshCw,
  Search,
  SettingsIcon,
  Sparkle,
  Square,
  Terminal,
  TrendUp
} from "./icons";

type NavView = "tasks" | "runs" | "activity" | "incidents" | "agents" | "skills" | "schedules" | "settings";

export function AppWindowMockup() {
  const [view, setView] = useState<NavView>("runs");
  const [activeThreadId, setActiveThreadId] = useState("growth");
  const [composerText, setComposerText] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("growth-sentry");
  const [selectedSkillId, setSelectedSkillId] = useState("git-worktree");
  const [scheduleViewMode, setScheduleViewMode] = useState<"calendar" | "agenda">("calendar");
  const [settingsTab, setSettingsTab] = useState<"codex" | "connectors" | "apikeys">("codex");

  // Dynamic live execution animation state
  const [stepIndex, setStepIndex] = useState(2);
  const [isWorking, setIsWorking] = useState(true);

  // Auto-advance work logs periodically to simulate live agent execution & cross-agent handoff
  useEffect(() => {
    const interval = setInterval(() => {
      setStepIndex((prev) => (prev >= 3 ? 1 : prev + 1));
    }, 4500);
    return () => clearInterval(interval);
  }, []);

  // Realistic SF Startup Context: Veloce Robotics (Autonomous Edge Drones & CV, Series A)
  const threads = [
    {
      id: "growth",
      agentId: "growth-sentry",
      agentName: "Growth Sentry",
      dept: "Growth & Acquisition",
      title: "Q3 Developer Acquisition Funnel & Paid Ad Budget",
      badge: "Active",
      time: "Turn active",
      model: "Grok 4.6",
      userMsg: "Analyze last week's Google & Meta ad spend for Veloce Drone SDK. Reallocate $4,000 from underperforming social retargeting to high-converting developer search queries.",
      workLogs: [
        { cmd: "stripe-api — fetch customer conversion cohorts", status: "✓ 1,420 cohorts synced" },
        { cmd: "meta-ads — pause AdSet #8412 (CPA > $85 on broad social)", status: "✓ paused" },
        { cmd: "google-ads — reallocate $4,000 to search campaign #102 ('edge drone cv sdk')", status: "✓ executed" }
      ],
      reasoning: "CAC on developer intent search queries is $28.40 vs $94.20 on broad social. Reallocating $4,000 will yield an estimated 141 additional trial signups this sprint. Handoff event ready for Ledger Automator.",
      responseMsg: "Budget reallocation complete. Paused 2 high-CPA ad sets and increased bids on developer intent search terms. Handing off financial audit to Ledger Automator for runway projection.",
      handoff: {
        toAgent: "Ledger Automator",
        toAgentId: "ledger-automator",
        task: "Audit Q3 runway model with adjusted $4,000 ad allocation"
      }
    },
    {
      id: "finance",
      agentId: "ledger-automator",
      agentName: "Ledger Automator",
      dept: "Finance & FP&A",
      title: "Stripe ARR Reconciliation & 18-Month Burn Runway",
      badge: "Idle",
      time: "12m ago",
      model: "GPT 5.6 Sol",
      userMsg: "Reconcile June Stripe merchant payouts against Mercury bank accounts and project 18-month rolling burn runway.",
      workLogs: [
        { cmd: "mercury-bank — pull settled wire statements", status: "✓ $482,100 balance verified" },
        { cmd: "stripe-api — compute net ARR & logo churn rate", status: "✓ $184.2k ARR (1.2% churn)" }
      ],
      reasoning: "Monthly gross burn is $42,000 with $184,200 annual recurring revenue. Net effective runway is 21.4 months at current headcount trajectory.",
      responseMsg: "Financial close complete. Reconciled all Mercury wire deposits. Net ARR is $184.2k with 21.4 months safe runway."
    },
    {
      id: "engineering",
      agentId: "builder-prime",
      agentName: "Builder Prime",
      dept: "Hardware & Systems",
      title: "GCT USB4110 Receptacle Footprint & 6-Layer DRC",
      badge: "Idle",
      time: "45m ago",
      model: "Claude Sonnet 5",
      userMsg: "Refactor drone flight controller USB receptacle footprint for 6-layer high-density tolerances. Ensure staggered ground pad pitch passes JLCPCB manufacturing rules.",
      workLogs: [
        { cmd: "git-worktree — add /srv/worktrees/task-482 feat/usb-c-drc", status: "✓ isolated" },
        { cmd: "kicad-drc — run 6-layer high density clearance assertions", status: "✓ 24/24 passed" }
      ],
      reasoning: "Inner-ground plane isolation requires 0.65mm staggered offsets on the shield ground pins to prevent solder bridging on 0.50mm outer pitch traces.",
      responseMsg: "Updated flight controller footprint with 0.65mm staggered offsets. All 24 DRC assertions passed without clearance conflicts."
    },
    {
      id: "incidents",
      agentId: "incident-commander",
      agentName: "Incident Commander",
      dept: "Reliability & SRE",
      title: "CloudWatch 502 Edge Telemetry Ingress Alarm",
      badge: "Idle",
      time: "2h ago",
      model: "Claude Opus 4.8",
      userMsg: "Investigate 502 Bad Gateway spike on /v1/telemetry/stream endpoint reported by CloudWatch.",
      workLogs: [
        { cmd: "cloudwatch-sentry — pull p99 latency & error traces", status: "✓ isolated upstream pool exhaustion" },
        { cmd: "git-pr-stage — open PR #480 with keep-alive socket tuning", status: "✓ merged & deployed" }
      ],
      reasoning: "Edge proxy connection pool exhausted under burst telemetry packets from drone fleet. Tuned keep-alive timeout and pool size.",
      responseMsg: "Incident resolved. Merged PR #480 to expand connection pool capacity. Error rate returned to 0.00%."
    }
  ];

  // Tasks Kanban Data
  const kanbanColumns = [
    {
      id: "todo",
      title: "Todo",
      icon: <Circle size={13} className="text-slate-400" />,
      tasks: [
        {
          id: "TASK-485",
          title: "Setup Caddy TLS reverse proxy for enterprise custom drone subdomains",
          project: "Veloce / Cloud",
          agentId: "chief-of-staff",
          agentName: "Chief of Staff",
          time: "Queued"
        },
        {
          id: "TASK-484",
          title: "Prepare automated 1099 hardware contractor payout batch in Mercury",
          project: "Veloce / Finance",
          agentId: "ledger-automator",
          agentName: "Ledger Automator",
          time: "Scheduled"
        }
      ]
    },
    {
      id: "running",
      title: "Running",
      icon: <CircleDashed size={13} className="text-indigo-600 animate-spin" />,
      tasks: [
        {
          id: "TASK-482",
          title: "Q3 Developer Acquisition Funnel & Paid Ad Budget Rebalance",
          project: "Veloce / Growth",
          agentId: "growth-sentry",
          agentName: "Growth Sentry",
          time: "142 t/s"
        },
        {
          id: "TASK-481",
          title: "Execute automated Playwright E2E matrix on drone simulator stream",
          project: "Veloce / QA",
          agentId: "support-scout",
          agentName: "Support Scout",
          time: "Step 4/6"
        }
      ]
    },
    {
      id: "completed",
      title: "Completed",
      icon: <CheckCircle2 size={13} className="text-emerald-600" />,
      tasks: [
        {
          id: "TASK-480",
          title: "Stripe ARR Reconciliation & June Burn Runway projection",
          project: "Veloce / Finance",
          agentId: "ledger-automator",
          agentName: "Ledger Automator",
          time: "12m ago"
        },
        {
          id: "TASK-479",
          title: "GCT USB4110 Flight Controller Footprint & JLCPCB DRC Check",
          project: "Veloce / Hardware",
          agentId: "builder-prime",
          agentName: "Builder Prime",
          time: "45m ago"
        },
        {
          id: "TASK-478",
          title: "Patch 502 CloudWatch edge gateway timeout in telemetry proxy",
          project: "Veloce / SRE",
          agentId: "incident-commander",
          agentName: "Incident Commander",
          time: "2h ago"
        }
      ]
    }
  ];

  // Activity Reports Data
  const activityReports = [
    {
      id: "REPORT-104",
      title: "Drone Fleet Telemetry Ingress Latency & Cluster Scalability Audit",
      agentId: "incident-commander",
      agentName: "Incident Commander",
      project: "Veloce / Reliability",
      time: "22m ago",
      summary: "Resolved p99 latency spike across 45 active edge drones. Scaled worker connection pool from 256 to 1,024 sockets.",
      markdown: "Telemetry stream analysis showed socket starvation during burst LIDAR payload uploads. Applied keep-alive connection pooling in PR #480. p99 latency decreased from 410ms to 18ms."
    },
    {
      id: "REPORT-103",
      title: "Q3 Paid Acquisition Funnel & Developer Intent Search Audit",
      agentId: "growth-sentry",
      agentName: "Growth Sentry",
      project: "Veloce / Growth",
      time: "1h ago",
      summary: "Reallocated $4,000 from broad social retargeting to developer intent search queries. Anticipated trial increase: +141 accounts.",
      markdown: "Analyzed CAC metrics across 1,420 user cohorts. Developer search campaigns yield a $28.40 CAC compared to $94.20 on broad social channels. Paused AdSet #8412 and boosted bids on top search queries."
    },
    {
      id: "REPORT-102",
      title: "June Financial Close & 18-Month Runway Projection",
      agentId: "ledger-automator",
      agentName: "Ledger Automator",
      project: "Veloce / Finance",
      time: "3h ago",
      summary: "Stripe ARR stands at $184.2k with 1.2% net logo churn. Bank deposits in Mercury reconciled with 0 variances.",
      markdown: "Reconciled all settled merchant wire payouts against Mercury operational bank accounts. Projected safe runway is 21.4 months with a conservative $42,000 monthly gross burn rate."
    }
  ];

  // Incidents Data
  const incidents = [
    {
      id: "INC-48",
      title: "CloudWatch 502 Gateway Timeout Spike on Telemetry Stream Endpoint",
      severity: "high",
      status: "Resolved",
      commanderId: "incident-commander",
      commanderName: "Incident Commander",
      time: "2h ago",
      description: "Edge proxy connections dropped under burst traffic. Automated patch PR #480 merged with keep-alive connection pool tuning."
    },
    {
      id: "INC-47",
      title: "Stripe Webhook Signature Verification Flake in EU-West Ingress",
      severity: "medium",
      status: "Mitigated",
      commanderId: "ledger-automator",
      commanderName: "Ledger Automator",
      time: "1d ago",
      description: "Clock skew on ingress node caused signature tolerance timeout. NTP synchronized across worker clusters."
    }
  ];

  // Agents Config Data
  const squadAgents = [
    {
      id: "growth-sentry",
      name: "Growth Sentry",
      role: "Growth & Acquisition",
      harness: "Cursor",
      model: "Grok 4.6",
      instructions: "Monitor Google & Meta ad spend, analyze customer acquisition cost (CAC) per cohort, and optimize developer onboarding funnels for Veloce Drone SDK.",
      skills: ["meta-ads", "google-ads", "stripe-api", "newsletter-dispatch"]
    },
    {
      id: "builder-prime",
      name: "Builder Prime",
      role: "Hardware & Systems",
      harness: "Claude Code",
      model: "Claude Sonnet 5",
      instructions: "Write fullstack Rust & TypeScript code, design KiCad PCB schematics, and execute automated DRC assertions in sandboxed Git worktrees.",
      skills: ["git-worktree", "ast-grep", "kicad-drc", "docker-runner"]
    },
    {
      id: "ledger-automator",
      name: "Ledger Automator",
      role: "Finance & FP&A",
      harness: "Codex",
      model: "GPT 5.6 Sol",
      instructions: "Reconcile Stripe billing with Mercury bank wires, audit monthly ARR, and maintain 18-month rolling burn projections.",
      skills: ["stripe-api", "mercury-bank", "excel-models", "tax-compliance"]
    },
    {
      id: "incident-commander",
      name: "Incident Commander",
      role: "Reliability & SRE",
      harness: "Claude Code",
      model: "Claude Opus 4.8",
      instructions: "Monitor CloudWatch telemetry and server health 24/7, triage stack traces, and stage automated PR fixes with zero human bottlenecks.",
      skills: ["cloudwatch-sentry", "systemd-runner", "git-pr-stage"]
    },
    {
      id: "support-scout",
      name: "Support Scout",
      role: "Customer Success",
      harness: "OpenCode",
      model: "GLM 3.7 Flash",
      instructions: "Triage enterprise drone fleet inquiries, reproduce firmware edge cases via Playwright simulations, and draft release notes.",
      skills: ["playwright-e2e", "github-issues", "zendesk-sync"]
    },
    {
      id: "chief-of-staff",
      name: "Chief of Staff",
      role: "Cross-Squad Dispatcher",
      harness: "OpenCode",
      model: "Kimi K3",
      instructions: "Orchestrate multi-agent task handoffs between Engineering, Marketing, and Finance, and compile daily CEO briefings for Alex Vance.",
      skills: ["task-dispatch", "sprint-planner", "slack-briefing"]
    }
  ];

  // Skills Catalog Data (Exact schema from real AiSevak app)
  const skillCatalog = [
    {
      id: "git-worktree",
      name: "git-worktree",
      description: "Manage physical Git worktrees under /srv/worktrees to run parallel agent turns without merge conflicts.",
      status: "default",
      enabled: true,
      platform_managed: true,
      path: "~/.config/aisevak/skills/git-worktree",
      instructions: `# Git Worktrees Skill

Use this skill to spawn isolated working directories for agent turns.
- Run \`git worktree add /srv/worktrees/<task-id> <branch>\` before editing code.
- Run test suites inside the dedicated worktree.
- Prune with \`git worktree remove --force\` after merge verification.`
    },
    {
      id: "ast-grep",
      name: "ast-grep",
      description: "Perform AST syntax-tree searching and structural refactoring across TypeScript, Rust, and Python.",
      status: "default",
      enabled: true,
      platform_managed: true,
      path: "~/.config/aisevak/skills/ast-grep",
      instructions: `# AST Grep Skill

Run structural syntax-tree queries and codemods without regex fragility.
- \`ast-grep scan --pattern 'function $NAME($ARGS) { $$$ }'\`
- Use pattern replacement to ensure type-safe syntax migrations.`
    },
    {
      id: "stripe-api",
      name: "stripe-api",
      description: "Direct API access to Stripe customer cohorts, invoices, payment intents, and MRR/ARR reconciliation metrics.",
      status: "enabled",
      enabled: true,
      platform_managed: false,
      path: "~/.config/aisevak/skills/stripe-api",
      instructions: `# Stripe API Skill

Query Stripe telemetry and financial ledger events.
- \`stripe-api cohorts --range 30d\`
- Fetch net ARR, logo churn rates, and pending payout wires.`
    },
    {
      id: "cloudwatch-sentry",
      name: "cloudwatch-sentry",
      description: "24/7 AWS CloudWatch log streaming, metric alarm monitoring, and automated stack trace root-cause analysis.",
      status: "enabled",
      enabled: true,
      platform_managed: false,
      path: "~/.config/aisevak/skills/cloudwatch-sentry",
      instructions: `# AWS CloudWatch Sentry Skill

Stream CloudWatch telemetry alarms and isolate ingress latency spikes.
- Poll \`/v1/telemetry/stream\` p99 metrics.
- Flag 502 Bad Gateway error bursts and stage connection pool adjustments.`
    }
  ];

  // Schedules Data
  const schedules = [
    {
      id: "SCHED-01",
      title: "Real-time CloudWatch 502 Sentry & Health Audit",
      agentId: "incident-commander",
      agentName: "Incident Commander",
      interval: "Every 15m",
      nextRun: "in 4m",
      runs: 1420
    },
    {
      id: "SCHED-02",
      title: "Daily Stripe ARR Sync & Executive Financial Briefing",
      agentId: "ledger-automator",
      agentName: "Ledger Automator",
      interval: "Daily at 9:00 AM",
      nextRun: "Tomorrow 9:00 AM",
      runs: 84
    },
    {
      id: "SCHED-03",
      title: "Google & Meta Ad Spend Efficiency & CAC Rebalance",
      agentId: "growth-sentry",
      agentName: "Growth Sentry",
      interval: "Every 4h",
      nextRun: "in 1h 20m",
      runs: 312
    },
    {
      id: "SCHED-04",
      title: "Drone Fleet Telemetry Ingress Capacity Check",
      agentId: "builder-prime",
      agentName: "Builder Prime",
      interval: "Every 1h",
      nextRun: "in 35m",
      runs: 480
    }
  ];

  // Calendar Days for Month View (June 2026)
  const calendarDays = [
    { day: 1, events: [] },
    { day: 2, events: [{ id: "e1", title: "Daily ARR Sync", agentId: "ledger-automator" }] },
    { day: 3, events: [] },
    { day: 4, events: [{ id: "e2", title: "Ad Spend Rebalance", agentId: "growth-sentry" }] },
    { day: 5, events: [] },
    { day: 6, events: [] },
    { day: 7, events: [] },
    { day: 8, events: [{ id: "e3", title: "CloudWatch Audit", agentId: "incident-commander" }] },
    { day: 9, events: [{ id: "e4", title: "Daily ARR Sync", agentId: "ledger-automator" }] },
    { day: 10, events: [{ id: "e5", title: "Drone PCB DRC Run", agentId: "builder-prime" }] },
    { day: 11, events: [] },
    { day: 12, events: [{ id: "e6", title: "Ad Spend Rebalance", agentId: "growth-sentry" }] },
    { day: 13, events: [] },
    { day: 14, events: [] },
    { day: 15, events: [{ id: "e7", title: "Mid-month FP&A Close", agentId: "ledger-automator" }] },
    { day: 16, events: [] },
    { day: 17, events: [{ id: "e8", title: "Sprint CEO Briefing", agentId: "chief-of-staff" }] },
    { day: 18, events: [] },
    { day: 19, events: [] },
    { day: 20, events: [] },
    { day: 21, events: [] }
  ];

  const currentThread = threads.find((t) => t.id === activeThreadId) || threads[0]!;
  const currentSelectedAgent = squadAgents.find((a) => a.id === selectedAgentId) || squadAgents[0]!;
  const currentSelectedSkill = skillCatalog.find((s) => s.id === selectedSkillId) || skillCatalog[0]!;

  return (
    <div className="window-frame font-sans text-left select-none text-xs leading-normal shadow-[0_20px_50px_rgba(0,0,0,0.09)] border border-black/[0.1] bg-white">
      {/* macOS Top Chrome (Buttons Only) */}
      <div className="window-header !py-2.5 !px-3.5 bg-[#f4f4f7] border-b border-black/[0.08] flex items-center">
        <div className="traffic-dots flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f56] opacity-90" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e] opacity-90" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f] opacity-90" />
        </div>
      </div>

      {/* Actual AiSevak Layout Frame */}
      <div className="flex min-h-[560px] h-[560px] bg-white text-[#09090b] overflow-hidden">
        {/* Real Exact AiSevak Sidebar */}
        <aside className="w-[210px] sm:w-[220px] bg-[#fafafc] border-r border-black/[0.08] flex flex-col justify-between shrink-0 hidden md:flex">
          {/* Top Brand & Nav */}
          <div className="p-2.5 space-y-3 overflow-y-auto">
            {/* Sidebar Brand */}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <div className="w-6 h-6 rounded-md bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                <Terminal size={14} weight="fill" />
              </div>
              <span className="font-semibold text-xs text-[#09090b] tracking-tight">Aisevak</span>
            </div>

            {/* Nav Label: Overview (Exact Wording from Real App) */}
            <div className="space-y-0.5">
              <div className="text-[10px] font-mono font-medium text-slate-400 uppercase tracking-wider px-2 py-1">
                Overview
              </div>
              
              <button
                type="button"
                onClick={() => setView("tasks")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  view === "tasks"
                    ? "bg-black/[0.07] text-black font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-black/[0.03] hover:text-black"
                }`}
              >
                <LayoutDashboard size={14} className={view === "tasks" ? "text-indigo-600" : ""} />
                <span>Tasks</span>
              </button>

              <button
                type="button"
                onClick={() => setView("activity")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  view === "activity"
                    ? "bg-black/[0.07] text-black font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-black/[0.03] hover:text-black"
                }`}
              >
                <Activity size={14} className={view === "activity" ? "text-indigo-600" : ""} />
                <span>Activity</span>
              </button>

              <button
                type="button"
                onClick={() => setView("incidents")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  view === "incidents"
                    ? "bg-black/[0.07] text-black font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-black/[0.03] hover:text-black"
                }`}
              >
                <CircleAlert size={14} className={view === "incidents" ? "text-indigo-600" : ""} />
                <span>Incidents</span>
              </button>

              <button
                type="button"
                onClick={() => setView("agents")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  view === "agents"
                    ? "bg-black/[0.07] text-black font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-black/[0.03] hover:text-black"
                }`}
              >
                <Bot size={14} className={view === "agents" ? "text-indigo-600" : ""} />
                <span>Agent setup</span>
              </button>

              <button
                type="button"
                onClick={() => setView("skills")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  view === "skills"
                    ? "bg-black/[0.07] text-black font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-black/[0.03] hover:text-black"
                }`}
              >
                <BookOpen size={14} className={view === "skills" ? "text-indigo-600" : ""} />
                <span>Skills</span>
              </button>

              <button
                type="button"
                onClick={() => setView("schedules")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  view === "schedules"
                    ? "bg-black/[0.07] text-black font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-black/[0.03] hover:text-black"
                }`}
              >
                <Calendar size={14} className={view === "schedules" ? "text-indigo-600" : ""} />
                <span>Schedule</span>
              </button>
            </div>

            {/* Nav Label: Threads Heading with + button */}
            <div className="pt-2 border-t border-black/[0.08] space-y-1">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[10px] font-mono font-medium text-slate-400 uppercase tracking-wider">
                  Threads
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setView("runs");
                    setActiveThreadId("growth");
                  }}
                  className="text-slate-500 hover:text-black p-0.5 rounded hover:bg-black/[0.05]"
                  title="New thread"
                >
                  <Plus size={11} />
                </button>
              </div>

              {threads.map((t) => {
                const isSelected = view === "runs" && t.id === activeThreadId;
                const isRunning = t.id === "growth" ? stepIndex < 3 : false;
                return (
                  <div
                    key={t.id}
                    onClick={() => {
                      setView("runs");
                      setActiveThreadId(t.id);
                    }}
                    className={`p-2 rounded-lg border flex items-start gap-2 cursor-pointer transition-all ${
                      isSelected
                        ? "bg-black/[0.06] border-black/[0.12] text-black font-semibold shadow-2xs"
                        : "border-transparent hover:bg-black/[0.03] text-slate-600 hover:text-black"
                    }`}
                  >
                    <AgentAvatar
                      agentId={t.agentId}
                      agentName={t.agentName}
                      className="w-5 h-5 mt-0.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] truncate font-semibold text-[#09090b]">
                        {t.title}
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 mt-0.5 flex items-center justify-between">
                        <span className="truncate">{t.agentName}</span>
                        <span className={isRunning ? "text-emerald-600 font-semibold shrink-0" : "text-slate-400 shrink-0"}>
                          {isRunning ? "Active" : t.id === "growth" ? "Just now" : t.time}
                        </span>
                      </div>
                    </div>
                    {isRunning && (
                      <DotMatrixLoader size={9} className="text-indigo-600 shrink-0 mt-1" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sidebar Footer Real Founder User Chip (Alex Vance — Veloce Robotics) */}
          <div className="p-2.5 border-t border-black/[0.08] bg-[#f4f4f7] flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-full bg-indigo-600 text-white font-bold text-[10px] flex items-center justify-center shrink-0 shadow-xs">
                AV
              </div>
              <div className="min-w-0 truncate">
                <div className="text-[11px] font-semibold text-[#09090b] truncate leading-tight">
                  Alex Vance
                </div>
                <div className="text-[9.5px] font-mono text-slate-500 truncate leading-tight">
                  Veloce Robotics
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 text-slate-500">
              <button
                type="button"
                onClick={() => setView("settings")}
                className="p-1 hover:text-black transition-colors"
                title="Settings"
              >
                <SettingsIcon size={13} />
              </button>
            </div>
          </div>
        </aside>

        {/* Dynamic Main Content Stage */}
        <main className="flex-1 flex flex-col min-w-0 bg-white relative overflow-hidden">
          
          {/* VIEW 1: THREADS / LIVE OPERATIONS */}
          {view === "runs" && (
            <div className="flex-1 flex flex-col min-h-0">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white/90 backdrop-blur-md shrink-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <AgentAvatar
                    agentId={currentThread.agentId}
                    agentName={currentThread.agentName}
                    className="w-6 h-6 shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-[10.5px] font-mono text-slate-500 flex items-center gap-1.5 truncate">
                      <span>{currentThread.dept}</span>
                      <span className="text-slate-300">/</span>
                      <span className="text-slate-800 font-medium">{currentThread.agentName}</span>
                    </div>
                    <h1 className="text-xs font-semibold text-[#09090b] truncate">
                      {currentThread.title}
                    </h1>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {currentThread.id === "growth" && stepIndex < 3 ? (
                    <div className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
                      <span>Working</span>
                    </div>
                  ) : (
                    <div className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-slate-50 text-slate-600 border border-slate-200 flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                      <span>Ready</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn-outline text-[11px] !py-1 !px-2.5 flex items-center gap-1 text-slate-700 hover:text-black"
                  >
                    <Square size={10} />
                    <span>Stop</span>
                  </button>
                </div>
              </header>

              {/* Chat Timeline Stage with Animated Execution Steps */}
              <div className="flex-1 p-4 sm:p-5 overflow-y-auto space-y-3 max-w-3xl mx-auto w-full">
                {/* User Message */}
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[#f4f4f7] border border-black/[0.06] p-3 text-xs text-[#09090b] shadow-xs leading-relaxed">
                    {currentThread.userMsg}
                    <div className="text-[9.5px] font-mono text-slate-400 mt-1 text-right">
                      10:42 AM • Alex Vance
                    </div>
                  </div>
                </div>

                {/* Animated Work Logs */}
                <div className="rounded-lg bg-[#fafafc] border border-black/[0.08] overflow-hidden text-xs">
                  <div className="px-3 py-1.5 bg-[#f4f4f7] border-b border-black/[0.06] text-[11px] font-mono text-slate-600 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Terminal size={12} className="text-indigo-600" />
                      <span className="font-semibold text-slate-800">
                        Autonomous actions ({Math.min(stepIndex, currentThread.workLogs.length)}/{currentThread.workLogs.length})
                      </span>
                    </div>
                    <span className="text-[10px] text-emerald-700 font-medium">
                      {stepIndex >= currentThread.workLogs.length ? "All tasks completed" : "Executing..."}
                    </span>
                  </div>

                  <div className="divide-y divide-black/[0.04] font-mono text-[11px]">
                    {currentThread.workLogs.slice(0, stepIndex).map((log, i) => (
                      <div key={i} className="px-3 py-1.5 flex items-center justify-between text-slate-600 hover:bg-black/[0.01]">
                        <span className="truncate">{log.cmd}</span>
                        <span className="text-emerald-700 text-[10px] font-medium shrink-0">{log.status}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Thinking Reasoning Stream */}
                <div className="aicss-tr-card">
                  <div className="aicss-tr-header">
                    <div className="aicss-tr-header-left">
                      <AgentOrb variant="thinking" size={14} color="#6366f1" />
                      <span className="text-xs font-medium aicss-shimmer">
                        Synthesizing company telemetry & cross-system logic...
                      </span>
                    </div>
                    <div className="aicss-tr-meta">
                      <span>142 t/s</span>
                      <span>•</span>
                      <span>1.8s</span>
                    </div>
                  </div>
                  <div className="aicss-tr-body text-[11.5px] leading-relaxed">
                    {currentThread.reasoning}
                  </div>
                </div>

                {/* Assistant Response */}
                <div className="p-3 rounded-lg bg-transparent text-xs text-slate-800 leading-relaxed font-sans">
                  {currentThread.responseMsg}
                </div>

                {/* Cross-Agent Dispatch / Handoff Banner (Triggering another agent) */}
                {currentThread.handoff && (
                  <div
                    onClick={() => {
                      setActiveThreadId("finance");
                    }}
                    className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-200/80 text-xs flex items-center justify-between cursor-pointer hover:bg-indigo-50 transition-all shadow-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar agentId={currentThread.handoff.toAgentId} agentName={currentThread.handoff.toAgent} className="w-6 h-6" />
                      <div>
                        <div className="text-[11.5px] font-semibold text-indigo-950 flex items-center gap-1.5">
                          <span>Dispatched turn to {currentThread.handoff.toAgent}</span>
                          <span className="text-[9.5px] font-mono px-1.5 py-0.2 rounded bg-indigo-200 text-indigo-800">Triggered</span>
                        </div>
                        <div className="text-[10.5px] text-indigo-700">{currentThread.handoff.task}</div>
                      </div>
                    </div>
                    <ArrowRight size={14} className="text-indigo-600" />
                  </div>
                )}
              </div>

              {/* Floating Prompt Composer */}
              <div className="p-3 sm:p-4 bg-gradient-to-t from-white via-white to-transparent shrink-0">
                <div className="max-w-2xl mx-auto rounded-xl border border-black/[0.12] bg-white shadow-md overflow-hidden focus-within:border-indigo-600 transition-all">
                  <input
                    type="text"
                    placeholder={`Instruct ${currentThread.agentName} (or type / for skills, agents, company tools)...`}
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    className="w-full bg-transparent px-3.5 py-2.5 text-xs text-[#09090b] placeholder:text-slate-400 outline-none font-sans"
                  />
                  <div className="px-3 py-2 bg-[#f8f8fa] border-t border-black/[0.06] flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <div className="px-2 py-1 rounded-md bg-white border border-black/[0.08] text-slate-700 hover:text-black flex items-center gap-1.5 text-[10.5px] font-mono cursor-pointer shadow-xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />
                        <span>{currentThread.model}</span>
                        <ChevronDown size={11} />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="w-6 h-6 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center font-bold transition-all shadow-xs"
                    >
                      <ArrowUp size={13} weight="bold" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 2: TASKS (KANBAN PIPELINE) */}
          {view === "tasks" && (
            <div className="flex-1 flex flex-col min-h-0 bg-[#fbfbfe]">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <LayoutDashboard size={15} className="text-indigo-600" />
                  <h1 className="text-xs font-semibold text-[#09090b]">Tasks & Company Pipeline</h1>
                  <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">7 Total</span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded bg-[#f4f4f7] border border-black/[0.06] text-[11px] text-slate-500 font-mono">
                    <Search size={11} />
                    <span>Search tasks ⌘K</span>
                  </div>
                  <button type="button" className="btn-primary text-[11px] !py-1 !px-2.5 flex items-center gap-1">
                    <Plus size={11} />
                    <span>New Task</span>
                  </button>
                </div>
              </header>

              <div className="flex-1 p-3.5 overflow-x-auto flex gap-3">
                {kanbanColumns.map((col) => (
                  <div key={col.id} className="w-64 shrink-0 flex flex-col bg-[#f4f4f7]/70 rounded-xl border border-black/[0.06] p-2.5 space-y-2">
                    <div className="flex items-center justify-between px-1 text-xs font-semibold text-slate-700">
                      <div className="flex items-center gap-1.5">
                        {col.icon}
                        <span>{col.title}</span>
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-white text-slate-500 border border-black/[0.06]">
                        {col.tasks.length}
                      </span>
                    </div>

                    <div className="space-y-2 overflow-y-auto flex-1">
                      {col.tasks.map((task) => (
                        <div
                          key={task.id}
                          onClick={() => {
                            setView("runs");
                            setActiveThreadId("growth");
                          }}
                          className="p-2.5 rounded-lg bg-white border border-black/[0.08] hover:border-black/20 shadow-xs cursor-pointer space-y-2 transition-all"
                        >
                          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                            <span>{task.id}</span>
                            <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{task.project}</span>
                          </div>
                          <div className="text-[11.5px] font-medium text-[#09090b] leading-snug">
                            {task.title}
                          </div>
                          <div className="pt-1.5 border-t border-black/[0.04] flex items-center justify-between text-[10.5px]">
                            <div className="flex items-center gap-1.5 text-slate-600">
                              <AgentAvatar agentId={task.agentId} agentName={task.agentName} className="w-4 h-4" />
                              <span className="truncate">{task.agentName}</span>
                            </div>
                            <span className="text-indigo-600 font-mono text-[9.5px]">{task.time}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VIEW 3: ACTIVITY REPORTS */}
          {view === "activity" && (
            <div className="flex-1 flex flex-col min-h-0 bg-[#fbfbfe]">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <Activity size={15} className="text-indigo-600" />
                  <h1 className="text-xs font-semibold text-[#09090b]">Activity Reports</h1>
                </div>
                <button type="button" className="btn-outline text-[11px] !py-1 !px-2.5 flex items-center gap-1 text-slate-600">
                  <RefreshCw size={11} />
                  <span>Refresh</span>
                </button>
              </header>

              <div className="flex-1 p-4 overflow-y-auto space-y-3 max-w-3xl mx-auto w-full">
                {activityReports.map((report) => (
                  <div key={report.id} className="rounded-xl bg-white border border-black/[0.08] shadow-xs overflow-hidden">
                    <div className="p-3 bg-[#f8f8fa] border-b border-black/[0.06] flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <AgentAvatar agentId={report.agentId} agentName={report.agentName} className="w-5 h-5" />
                        <span className="font-semibold text-[#09090b]">{report.agentName}</span>
                        <span className="text-slate-400">•</span>
                        <span className="text-[10.5px] font-mono text-slate-500">{report.project}</span>
                      </div>
                      <span className="text-[10px] font-mono text-slate-400">{report.time}</span>
                    </div>

                    <div className="p-4 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <h2 className="text-xs sm:text-[13px] font-bold text-[#09090b]">{report.title}</h2>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold">{report.id}</span>
                      </div>
                      <div className="p-2.5 rounded-md bg-[#f4f4f7] text-[11.5px] text-slate-700 leading-relaxed border-l-2 border-indigo-600">
                        {report.summary}
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed font-sans">
                        {report.markdown}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VIEW 4: INCIDENTS */}
          {view === "incidents" && (
            <div className="flex-1 flex flex-col min-h-0 bg-[#fbfbfe]">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <CircleAlert size={15} className="text-indigo-600" />
                  <h1 className="text-xs font-semibold text-[#09090b]">Incidents</h1>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">All Systems Normal</span>
              </header>

              <div className="flex-1 p-4 overflow-y-auto space-y-3 max-w-3xl mx-auto w-full">
                {incidents.map((inc) => (
                  <div key={inc.id} className="rounded-xl bg-white border border-black/[0.08] shadow-xs p-4 space-y-2 relative overflow-hidden">
                    <div className={`absolute top-0 bottom-0 left-0 w-1 ${inc.severity === "high" ? "bg-rose-500" : "bg-amber-500"}`} />
                    
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 pl-1">
                        <span className="font-mono font-bold text-[11px] text-slate-500">{inc.id}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded uppercase font-semibold bg-slate-100 text-slate-700">{inc.severity}</span>
                        <span className="text-[10px] font-mono text-slate-400">• {inc.time}</span>
                      </div>
                      <span className="text-[10px] font-mono font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">{inc.status}</span>
                    </div>

                    <h2 className="text-xs sm:text-[13px] font-bold text-[#09090b] pl-1">{inc.title}</h2>
                    <p className="text-xs text-slate-600 leading-relaxed font-sans pl-1">{inc.description}</p>
                    
                    <div className="pt-2 border-t border-black/[0.04] flex items-center gap-2 text-[11px] text-slate-500 pl-1">
                      <span>Commander:</span>
                      <AgentAvatar agentId={inc.commanderId} agentName={inc.commanderName} className="w-4 h-4" />
                      <span className="font-medium text-slate-800">{inc.commanderName}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VIEW 5: AGENT SETUP */}
          {view === "agents" && (
            <div className="flex-1 flex flex-col min-h-0 bg-white">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <Bot size={15} className="text-indigo-600" />
                  <h1 className="text-xs font-semibold text-[#09090b]">Agent setup</h1>
                </div>
                <button type="button" className="btn-primary text-[11px] !py-1 !px-2.5 flex items-center gap-1">
                  <Plus size={11} />
                  <span>New Agent</span>
                </button>
              </header>

              <div className="flex-1 flex min-h-0 divide-x divide-black/[0.08]">
                {/* Agents List (Left) */}
                <div className="w-[180px] sm:w-[210px] p-2 space-y-1 overflow-y-auto bg-[#fafafc]">
                  {squadAgents.map((agent) => {
                    const isSelected = agent.id === selectedAgentId;
                    return (
                      <div
                        key={agent.id}
                        onClick={() => setSelectedAgentId(agent.id)}
                        className={`p-2 rounded-lg border flex items-center gap-2 cursor-pointer transition-all ${
                          isSelected
                            ? "bg-white border-black/[0.12] shadow-xs text-black font-semibold"
                            : "border-transparent hover:bg-black/[0.02] text-slate-600"
                        }`}
                      >
                        <AgentAvatar agentId={agent.id} agentName={agent.name} className="w-6 h-6 shrink-0" />
                        <div className="min-w-0 flex-1 truncate">
                          <div className="text-[11.5px] truncate">{agent.name}</div>
                          <div className="text-[9.5px] font-mono text-slate-400 truncate">{agent.role}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Agent Config Details (Right) */}
                <div className="flex-1 p-4 overflow-y-auto space-y-3.5 text-xs text-left">
                  <div className="flex items-center gap-3 pb-3 border-b border-black/[0.06]">
                    <AgentAvatar agentId={currentSelectedAgent.id} agentName={currentSelectedAgent.name} className="w-9 h-9 shrink-0" />
                    <div>
                      <div className="font-bold text-[13px] text-[#09090b]">{currentSelectedAgent.name}</div>
                      <div className="text-[11px] font-mono text-slate-500">{currentSelectedAgent.role}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] font-mono font-medium text-slate-500 uppercase">Harness</label>
                      <div className="p-2 rounded-md bg-[#f8f8fa] border border-black/[0.08] font-mono text-slate-800 text-[11px] truncate">
                        {currentSelectedAgent.harness}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-mono font-medium text-slate-500 uppercase">Configured Model</label>
                      <div className="p-2 rounded-md bg-[#f8f8fa] border border-black/[0.08] font-mono text-slate-800 text-[11px] truncate">
                        {currentSelectedAgent.model}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-mono font-medium text-slate-500 uppercase">System Instructions</label>
                    <div className="p-2.5 rounded-md bg-[#f8f8fa] border border-black/[0.08] font-mono text-[11px] text-slate-700 leading-relaxed">
                      {currentSelectedAgent.instructions}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] font-mono font-medium text-slate-500 uppercase">Enabled Skills ({currentSelectedAgent.skills.length})</label>
                    <div className="flex flex-wrap gap-1.5">
                      {currentSelectedAgent.skills.map((skill) => (
                        <span key={skill} className="px-2 py-0.5 rounded bg-slate-100 border border-black/[0.06] text-[10.5px] font-mono text-slate-700">
                          ✓ {skill}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 6: SKILLS */}
          {view === "skills" && (
            <div className="flex-1 flex flex-col min-h-0 bg-white">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <BookOpen size={15} className="text-indigo-600" />
                  <h1 className="text-xs font-semibold text-[#09090b]">Skills</h1>
                </div>
                <button type="button" className="btn-primary text-[11px] !py-1 !px-2.5 flex items-center gap-1">
                  <Plus size={11} />
                  <span>New Skill</span>
                </button>
              </header>

              <div className="flex-1 flex min-h-0 divide-x divide-black/[0.08]">
                {/* Skills List (Left) */}
                <div className="w-[180px] sm:w-[210px] p-2 space-y-1 overflow-y-auto bg-[#fafafc]">
                  {skillCatalog.map((skill) => {
                    const isSelected = skill.id === selectedSkillId;
                    return (
                      <div
                        key={skill.id}
                        onClick={() => setSelectedSkillId(skill.id)}
                        className={`p-2 rounded-lg border flex items-start gap-2 cursor-pointer transition-all ${
                          isSelected
                            ? "bg-white border-black/[0.12] shadow-xs text-black font-semibold"
                            : "border-transparent hover:bg-black/[0.02] text-slate-600"
                        }`}
                      >
                        <BookOpen size={13} className="text-indigo-600 shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[11.5px] font-mono font-medium text-[#09090b] truncate">${skill.name}</div>
                          <div className="text-[10px] text-slate-400 truncate mt-0.5">{skill.description}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Skill Details (Right - Faithful to real app SkillEditor) */}
                <div className="flex-1 p-4 overflow-y-auto space-y-3 text-xs text-left">
                  {/* Info Callout */}
                  <div className="p-2.5 rounded-lg bg-[#f8f8fa] border border-black/[0.08] flex items-start gap-2 text-xs">
                    <Info size={14} className="shrink-0 text-slate-500 mt-0.5" />
                    <div className="text-[11px] text-slate-600 leading-relaxed">
                      <div>
                        Installed at <code className="px-1 py-0.5 rounded bg-black/[0.05] font-mono text-[10.5px] text-slate-800">{currentSelectedSkill.path}</code>.
                        {currentSelectedSkill.platform_managed ? " Aisevak updates this skill automatically with application releases." : " Changes here sync back to the local installed directory."}
                      </div>
                      {currentSelectedSkill.platform_managed && (
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          This skill is available to every agent by default. Only its availability can be changed.
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Form Grid */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10.5px] font-mono font-medium text-slate-500 uppercase">Name</label>
                      <div className="p-2 rounded-md bg-[#f8f8fa] border border-black/[0.08] font-mono text-slate-800 text-[11px]">
                        {currentSelectedSkill.name}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10.5px] font-mono font-medium text-slate-500 uppercase">Status</label>
                      <div className="p-2 rounded-md bg-[#f8f8fa] border border-black/[0.08] text-slate-800 text-[11px] flex items-center justify-between">
                        <span className="font-mono text-[10.5px] uppercase font-medium">{currentSelectedSkill.status}</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10.5px] font-mono font-medium text-slate-500 uppercase">Description</label>
                    <div className="p-2 rounded-md bg-[#f8f8fa] border border-black/[0.08] text-slate-700 text-xs leading-relaxed">
                      {currentSelectedSkill.description}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10.5px] font-mono font-medium text-slate-500 uppercase">Instructions</label>
                    <div className="p-2.5 rounded-md bg-[#f8f8fa] border border-black/[0.08] font-mono text-[10.5px] text-slate-700 leading-relaxed whitespace-pre-wrap max-h-[160px] overflow-y-auto">
                      {currentSelectedSkill.instructions}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 7: SCHEDULE (CALENDAR & AGENDA TOGGLE LIKE REAL APP) */}
          {view === "schedules" && (
            <div className="flex-1 flex flex-col min-h-0 bg-[#fbfbfe]">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <Calendar size={15} className="text-indigo-600" />
                    <h1 className="text-xs font-semibold text-[#09090b]">Schedule</h1>
                  </div>

                  {/* Calendar / Agenda View Mode Toggle (Exact from Real App) */}
                  <div className="flex items-center rounded-md bg-[#f4f4f7] p-0.5 border border-black/[0.06]">
                    <button
                      type="button"
                      onClick={() => setScheduleViewMode("calendar")}
                      className={`px-2 py-0.5 text-[10.5px] font-medium rounded transition-colors ${
                        scheduleViewMode === "calendar"
                          ? "bg-white text-black shadow-2xs"
                          : "text-slate-600 hover:text-black"
                      }`}
                    >
                      Calendar
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleViewMode("agenda")}
                      className={`px-2 py-0.5 text-[10.5px] font-medium rounded transition-colors ${
                        scheduleViewMode === "agenda"
                          ? "bg-white text-black shadow-2xs"
                          : "text-slate-600 hover:text-black"
                      }`}
                    >
                      Agenda
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button type="button" className="btn-primary text-[11px] !py-1 !px-2.5 flex items-center gap-1">
                    <Plus size={11} />
                    <span>New Schedule</span>
                  </button>
                </div>
              </header>

              {/* SCHEDULE SUB-VIEW A: MONTHLY CALENDAR GRID */}
              {scheduleViewMode === "calendar" && (
                <div className="flex-1 p-3.5 flex flex-col min-h-0">
                  {/* Month header & navigation */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-bold text-slate-800">June 2026</div>
                    <div className="flex items-center gap-1">
                      <button type="button" className="p-1 rounded hover:bg-slate-200/60 text-slate-600">
                        <ChevronLeft size={13} />
                      </button>
                      <button type="button" className="p-1 rounded hover:bg-slate-200/60 text-slate-600">
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Days of week */}
                  <div className="grid grid-cols-7 gap-1 text-[10px] font-mono text-slate-400 mb-1 text-center font-medium">
                    <div>Mon</div>
                    <div>Tue</div>
                    <div>Wed</div>
                    <div>Thu</div>
                    <div>Fri</div>
                    <div>Sat</div>
                    <div>Sun</div>
                  </div>

                  {/* Calendar Day Grid */}
                  <div className="grid grid-cols-7 gap-1 flex-1 overflow-y-auto">
                    {calendarDays.map((cDay) => (
                      <div
                        key={cDay.day}
                        className="rounded-lg bg-white border border-black/[0.06] p-1.5 flex flex-col justify-between min-h-[58px] shadow-2xs"
                      >
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 font-medium">
                          <span>{cDay.day}</span>
                          {cDay.day === 12 && (
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" title="Today" />
                          )}
                        </div>

                        <div className="space-y-0.5">
                          {cDay.events.map((evt) => (
                            <div
                              key={evt.id}
                              className="px-1 py-0.5 rounded bg-indigo-50 border border-indigo-100 text-[9px] font-mono text-indigo-900 truncate flex items-center gap-1"
                            >
                              <span className="w-1 h-1 rounded-full bg-indigo-600 shrink-0" />
                              <span className="truncate">{evt.title}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* SCHEDULE SUB-VIEW B: AGENDA INTERVAL TABLE */}
              {scheduleViewMode === "agenda" && (
                <div className="flex-1 p-4 overflow-y-auto space-y-2.5 max-w-3xl mx-auto w-full">
                  {schedules.map((sched) => (
                    <div key={sched.id} className="p-3 rounded-xl bg-white border border-black/[0.08] shadow-xs flex items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0">
                          <Calendar size={14} />
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-[#09090b] truncate">{sched.title}</div>
                          <div className="text-[10.5px] font-mono text-slate-500 mt-0.5 flex items-center gap-2">
                            <span>{sched.agentName}</span>
                            <span>•</span>
                            <span className="text-indigo-600">{sched.interval}</span>
                          </div>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-semibold">Active</span>
                        <div className="text-[9.5px] font-mono text-slate-400 mt-1">Next: {sched.nextRun}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* VIEW 8: SETTINGS */}
          {view === "settings" && (
            <div className="flex-1 flex flex-col min-h-0 bg-white text-xs">
              <header className="h-12 border-b border-black/[0.08] px-4 flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <SettingsIcon size={15} className="text-indigo-600" />
                  <h1 className="text-xs font-semibold text-[#09090b]">Settings</h1>
                </div>
              </header>

              <div className="flex border-b border-black/[0.06] px-4 gap-4 bg-[#fbfbfe]">
                <button
                  type="button"
                  onClick={() => setSettingsTab("codex")}
                  className={`py-2 text-xs font-semibold border-b-2 transition-colors ${
                    settingsTab === "codex" ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-500 hover:text-black"
                  }`}
                >
                  Agent Harnesses &amp; Auth
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("connectors")}
                  className={`py-2 text-xs font-semibold border-b-2 transition-colors ${
                    settingsTab === "connectors" ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-500 hover:text-black"
                  }`}
                >
                  Connected Systems
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("apikeys")}
                  className={`py-2 text-xs font-semibold border-b-2 transition-colors ${
                    settingsTab === "apikeys" ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-500 hover:text-black"
                  }`}
                >
                  External API Keys
                </button>
              </div>

              <div className="flex-1 p-5 overflow-y-auto space-y-4 max-w-xl mx-auto w-full text-left">
                {settingsTab === "codex" && (
                  <div className="space-y-3">
                    <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 size={15} className="text-emerald-600" />
                        <span className="font-semibold">Device-Code Authentication Active</span>
                      </div>
                      <span className="font-mono text-[10px] bg-white px-2 py-0.5 rounded border border-emerald-300">$0 Markup</span>
                    </div>
                    <div className="space-y-1 font-mono text-[11px] text-slate-600">
                      <div>Active Provider: <strong>OpenAI Codex / Claude Code</strong></div>
                      <div>Account: <strong>alex@veloce.ai</strong></div>
                      <div>Token Markup Fee: <strong className="text-emerald-700">$0.00 / 1M tokens</strong></div>
                    </div>
                  </div>
                )}

                {settingsTab === "connectors" && (
                  <div className="space-y-2">
                    <div className="p-2.5 rounded-lg border border-black/[0.08] flex items-center justify-between">
                      <div className="flex items-center gap-2 font-medium">
                        <Github size={15} />
                        <span>GitHub Worktrees (github.com/veloce-ai/drone-os)</span>
                      </div>
                      <span className="text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Connected</span>
                    </div>
                    <div className="p-2.5 rounded-lg border border-black/[0.08] flex items-center justify-between">
                      <div className="flex items-center gap-2 font-medium">
                        <CreditCard size={15} />
                        <span>Stripe Billing & Subscriptions</span>
                      </div>
                      <span className="text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Connected</span>
                    </div>
                    <div className="p-2.5 rounded-lg border border-black/[0.08] flex items-center justify-between">
                      <div className="flex items-center gap-2 font-medium">
                        <TrendUp size={15} />
                        <span>Google & Meta Ad Accounts</span>
                      </div>
                      <span className="text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Connected</span>
                    </div>
                  </div>
                )}

                {settingsTab === "apikeys" && (
                  <div className="space-y-2">
                    <div className="p-2.5 rounded-lg bg-[#f8f8fa] border border-black/[0.08] flex items-center justify-between font-mono text-[11px]">
                      <span>veloce_live_sk_89412...</span>
                      <span className="text-slate-400">Created 4d ago</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

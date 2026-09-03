import { useState } from "react";
import { Copy, Check } from "./icons";

interface CliTab {
  id: string;
  title: string;
  command: string;
  output: string[];
}

const CLI_TABS: CliTab[] = [
  {
    id: "agent-handoff",
    title: "agent handoff",
    command: `aisevak handoff --from "Growth Sentry" --to "Ledger Automator" --context "CAC spike detected"`,
    output: [
      "✓ Serialized turn context & memory snapshot",
      "✓ Dispatched reactive wakeup to Ledger Automator (PID 41210)",
      "→ Ledger Automator: \"Auditing query CAC vs gross margin for runway impact...\""
    ]
  },
  {
    id: "tasks-dispatch",
    title: "tasks dispatch",
    command: `aisevak tasks dispatch --title "Fix 502 Gateway Timeout" --assign "Builder Prime" --worktree`,
    output: [
      "✓ Provisioned isolated worktree at /srv/worktrees/task-502",
      "✓ Builder Prime assigned (Harness: Claude Code • Claude 3.7 Sonnet)",
      "→ Turn active: AST inspection started on packages/edge-proxy"
    ]
  },
  {
    id: "squad-status",
    title: "squad status",
    command: "aisevak squad status",
    output: [
      "AGENT               HARNESS       STATE      ACTIVE THREAD              UPTIME",
      "──────────────────────────────────────────────────────────────────────────────",
      "Builder Prime       Claude Code   WORKING    #480-edge-timeout-patch    18m 42s",
      "Growth Sentry       Cursor        IDLE       waiting for next turn      4h 12m",
      "Ledger Automator    Codex         WORKING    #482-cac-runway-audit      2m 15s"
    ]
  },
  {
    id: "threads-broadcast",
    title: "threads broadcast",
    command: `aisevak threads broadcast --tag "incident" --body "PR #480 merged on staging VM"`,
    output: [
      "✓ Emitted broadcast event to 3 subscribed agents",
      "→ Incident Commander: Triggered automated canary smoke suite",
      "→ Support Scout: Updated customer status board to 'Resolved'"
    ]
  }
];

export function CliShowcase() {
  const [activeTabId, setActiveTabId] = useState("agent-handoff");
  const [copied, setCopied] = useState(false);

  const activeTab = CLI_TABS.find((t) => t.id === activeTabId) ?? CLI_TABS[0]!;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeTab.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <section id="cli" className="py-20 md:py-28 border-t border-black/[0.06] bg-[#fafafc]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 text-left">
        <div className="mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#09090b] mb-2">
            The agent collaboration layer.
          </h2>
          <p className="text-sm sm:text-base text-slate-600 max-w-2xl">
            Agent harnesses communicate and coordinate best through simple text commands and standard I/O sockets. Instead of fragile multi-agent frameworks, AiSevak provides lightweight native primitives for task delegation, handoffs, and squad coordination.
          </p>
        </div>

        <div className="window-frame font-mono text-xs shadow-lg !bg-[#09090b] !border-black/20">
          {/* Header */}
          <div className="window-header !py-2.5 !px-3.5 !bg-[#121217] !border-b !border-white/[0.08]">
            <div className="flex items-center gap-1.5">
              {CLI_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveTabId(tab.id);
                    setCopied(false);
                  }}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${
                    activeTabId === tab.id
                      ? "bg-white/10 text-white font-medium"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {tab.title}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCopy}
              className="text-xs text-slate-400 hover:text-white flex items-center gap-1 px-2.5 py-1 rounded bg-white/[0.04] transition-colors"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>

          {/* Body */}
          <div className="p-4 sm:p-5 bg-[#09090b] space-y-3">
            <div className="text-white flex items-center gap-2 text-xs sm:text-[13px]">
              <span className="text-slate-500 select-none">$</span>
              <span>{activeTab.command}</span>
            </div>

            <div className="space-y-1 text-slate-400 border-t border-white/[0.04] pt-3 text-[11.5px] leading-relaxed">
              {activeTab.output.map((line, idx) => (
                <div
                  key={idx}
                  className={
                    line.startsWith("✓") || line.startsWith("●")
                      ? "text-emerald-400"
                      : line.startsWith("→")
                      ? "text-[#c7c2ff]"
                      : line.startsWith("AGENT")
                      ? "text-white font-semibold"
                      : "text-slate-400"
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

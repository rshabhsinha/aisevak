import { useState } from "react";
import { AgentAvatar } from "./agent-avatar";
import { GazeBlobGrid } from "./GazeBlobGrid";
import {
  FolderGit2,
  KeyRound,
  ChatsIcon,
  TrendUp
} from "./icons";

export function Features() {
  return (
    <section id="features" className="py-20 md:py-28 border-t border-black/[0.06] space-y-16 bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 space-y-16">
        
        {/* 1. Clean Feature List: Engineered for autonomous work */}
        <div className="text-left space-y-6">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#09090b] mb-2">
              Engineered for autonomous work.
            </h2>
            <p className="text-sm sm:text-base text-slate-600 max-w-2xl">
              From isolated Git worktrees to cross-functional company utilities, built with durable state and zero token markup.
            </p>
          </div>

          <div className="divide-y divide-black/[0.06] border-y border-black/[0.06]">
            {/* Item 1: Host-Native Git Worktrees */}
            <div className="py-5 sm:py-6 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="flex items-start gap-3.5 max-w-2xl">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0 mt-0.5">
                  <FolderGit2 size={16} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-[#09090b]">
                    Host-Native Git Worktrees
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                    Agents execute AST syntax transforms, run test suites, and write code inside isolated physical worktrees under <code className="px-1 py-0.5 rounded bg-black/[0.04] font-mono text-[11px]">/srv/worktrees</code> with zero merge conflicts.
                  </p>
                </div>
              </div>
              <div className="sm:text-right shrink-0">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-100 font-mono text-[11px] text-slate-600 border border-black/[0.05]">
                  /srv/worktrees
                </span>
              </div>
            </div>

            {/* Item 2: Bring Your Own Harnesses */}
            <div className="py-5 sm:py-6 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="flex items-start gap-3.5 max-w-2xl">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0 mt-0.5">
                  <KeyRound size={16} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-[#09090b]">
                    Bring Your Own Harnesses
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                    Connect your existing Cursor, Claude Code, OpenAI Codex, or OpenCode harnesses directly—configured with whatever models they offer. AiSevak charges $0 on token throughput.
                  </p>
                </div>
              </div>
              <div className="sm:text-right shrink-0">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-emerald-50 font-mono text-[11px] text-emerald-700 border border-emerald-200">
                  $0 token markup
                </span>
              </div>
            </div>

            {/* Item 3: Durable Multi-Agent Threads */}
            <div className="py-5 sm:py-6 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="flex items-start gap-3.5 max-w-2xl">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0 mt-0.5">
                  <ChatsIcon size={16} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-[#09090b]">
                    Durable Multi-Agent Threads
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                    Background turns persist across server restarts. Agents coordinate work via serialized handoffs, event-driven reactive wakeups, and full transcript logging.
                  </p>
                </div>
              </div>
              <div className="sm:text-right shrink-0">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-100 font-mono text-[11px] text-slate-600 border border-black/[0.05]">
                  Persistent turns
                </span>
              </div>
            </div>

            {/* Item 4: Company Operations */}
            <div className="py-5 sm:py-6 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="flex items-start gap-3.5 max-w-2xl">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0 mt-0.5">
                  <TrendUp size={16} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-[#09090b]">
                    Company Operations
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                    Beyond software engineering, automate operational workflows: reconcile Stripe subscriptions, rebalance marketing budgets, and triage cloud infrastructure.
                  </p>
                </div>
              </div>
              <div className="sm:text-right shrink-0">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-100 font-mono text-[11px] text-slate-600 border border-black/[0.05]">
                  Cross-functional
                </span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

import { useState } from "react";
import { AppWindowMockup } from "./AppWindowMockup";
import { ArrowRight, Copy, Check, Terminal } from "./icons";
import { CursorIcon, ClaudeIcon, CodexIcon, OpenCodeIcon } from "./harness-icons";

interface HeroProps {
  onOpenWaitlist: () => void;
}

export function Hero({ onOpenWaitlist }: HeroProps) {
  const [copied, setCopied] = useState(false);
  const installCmd = "curl -fsSL aisevak.com/install.sh | bash";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <section className="pt-28 pb-16 md:pt-36 md:pb-24 relative overflow-hidden bg-gradient-to-b from-[#fafafd] to-[#ffffff]">
      {/* Ambient background glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-indigo-500/[0.07] blur-[120px] rounded-full pointer-events-none" />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 text-center relative z-10">
        {/* Stacked Agent Logos Badge (Above headline) */}
        <div className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-white/90 border border-black/[0.08] shadow-xs mb-6 hover:border-black/20 transition-all">
          {/* Overlapping Stacked Logo Avatars */}
          <div className="flex items-center -space-x-1.5 shrink-0">
            <div
              className="w-5.5 h-5.5 sm:w-6 sm:h-6 rounded-full bg-[#09090b] border-2 border-white shadow-xs p-1 flex items-center justify-center ring-1 ring-black/[0.06] hover:scale-110 hover:z-10 transition-transform cursor-default"
              title="Cursor"
            >
              <CursorIcon className="w-full h-full" />
            </div>
            <div
              className="w-5.5 h-5.5 sm:w-6 sm:h-6 rounded-full bg-[#fdf8f6] border-2 border-white shadow-xs p-1 flex items-center justify-center ring-1 ring-black/[0.06] hover:scale-110 hover:z-10 transition-transform cursor-default"
              title="Claude Code"
            >
              <ClaudeIcon className="w-full h-full" />
            </div>
            <div
              className="w-5.5 h-5.5 sm:w-6 sm:h-6 rounded-full bg-[#ffffff] border-2 border-white shadow-xs p-1 flex items-center justify-center ring-1 ring-black/[0.06] hover:scale-110 hover:z-10 transition-transform cursor-default"
              title="OpenAI Codex"
            >
              <CodexIcon className="w-full h-full" />
            </div>
            <div
              className="w-5.5 h-5.5 sm:w-6 sm:h-6 rounded-full bg-[#131010] border-2 border-white shadow-xs p-1 flex items-center justify-center ring-1 ring-black/[0.06] hover:scale-110 hover:z-10 transition-transform cursor-default"
              title="OpenCode"
            >
              <OpenCodeIcon className="w-full h-full" />
            </div>
          </div>

          <span className="text-xs sm:text-[13px] text-slate-600 font-normal tracking-normal whitespace-nowrap">
            Works with <strong className="font-semibold text-slate-900">Cursor</strong>, <strong className="font-semibold text-slate-900">Claude Code</strong>, <strong className="font-semibold text-slate-900">Codex</strong> &amp; <strong className="font-semibold text-slate-900">OpenCode</strong>
          </span>
        </div>

        {/* Headline */}
        <h1 className="text-3xl sm:text-5xl lg:text-[54px] font-bold tracking-tight text-[#09090b] max-w-4xl mx-auto mb-4 leading-[1.14]">
          Run persistent AI agents in the cloud. Monitor from anywhere.
        </h1>

        {/* Subtitle */}
        <p className="text-sm sm:text-base md:text-[16px] text-slate-600 max-w-2xl mx-auto mb-10 sm:mb-12 leading-relaxed font-normal">
          Deploy to any cloud VM in seconds. Bring your existing agent harnesses—configured with whatever models they offer—with $0 markup. While local tools stop when you close your laptop, AiSevak runs persistent squads 24/7 on your server.
        </p>

        {/* Hero Control Room Window */}
        <div className="max-w-5xl mx-auto">
          <AppWindowMockup />
        </div>

        {/* Action Group (Below AiSevak UI) */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10 sm:mt-12 max-w-xl mx-auto">
          <button
            type="button"
            onClick={onOpenWaitlist}
            className="btn-primary w-full sm:w-auto !py-2.5 !px-5 text-xs sm:text-[13px] font-semibold shadow-sm whitespace-nowrap shrink-0"
          >
            <span className="whitespace-nowrap">Join the Waitlist</span>
            <ArrowRight size={13} className="shrink-0" />
          </button>

          <button
            type="button"
            onClick={handleCopy}
            className="w-full sm:w-auto flex items-center justify-between sm:justify-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-[#f4f4f6] border border-black/[0.08] hover:border-black/20 transition-all text-xs font-mono text-slate-700 hover:text-black shadow-xs whitespace-nowrap shrink-0"
          >
            <div className="flex items-center gap-2 truncate">
              <Terminal size={13} className="text-indigo-600 shrink-0" />
              <span className="truncate">{installCmd}</span>
            </div>
            <span className="shrink-0 text-slate-400">
              {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}


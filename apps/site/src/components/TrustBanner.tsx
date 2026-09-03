import { ArrowUpRight, ShieldCheck, Sparkle } from "./icons";

export function TrustBanner() {
  return (
    <section className="py-20 border-t border-white/[0.08] relative overflow-hidden bg-[#0a0a0d]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="glass-card rounded-2xl p-8 sm:p-10 border border-white/[0.1] relative">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
            {/* Left: Origin Story & Pedigree (7 cols) */}
            <div className="md:col-span-7 space-y-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-mono text-[#c7c2ff]">
                <ShieldCheck size={13} weight="fill" className="text-emerald-400" />
                <span>PromptLabs & Embedr Engineering Lineage</span>
              </div>

              <blockquote className="text-base sm:text-lg text-white font-medium leading-relaxed italic">
                “We built AiSevak because our hardware engineers and AI agents kept stepping on each other’s toes across multi-board embedded systems. Giving agents dedicated Git worktrees and host-native execution changed everything.”
              </blockquote>

              <div className="pt-2">
                <div className="text-sm font-semibold text-white">Rishabh Sinha</div>
                <div className="text-xs text-muted-foreground font-mono">
                  Co-founder & CEO, PromptLabs Pvt Ltd • Embedr
                </div>
              </div>
            </div>

            {/* Right: Lineage Links & Details (5 cols) */}
            <div className="md:col-span-5 bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 space-y-4">
              <div>
                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                  Parent Company
                </div>
                <a
                  href="https://promptlabs.link"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-bold text-white hover:text-[#c7c2ff] transition-colors inline-flex items-center gap-1.5 group"
                >
                  <span>PromptLabs Pvt Ltd</span>
                  <ArrowUpRight size={13} className="text-muted-foreground group-hover:text-white" />
                </a>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Board of Directors: Rishabh Sinha & Amit Kumar Modi
                </div>
              </div>

              <div className="pt-3 border-t border-white/[0.06]">
                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                  Flagship Product
                </div>
                <a
                  href="https://embedr.app"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-bold text-white hover:text-[#c7c2ff] transition-colors inline-flex items-center gap-1.5 group"
                >
                  <span>Embedr (embedr.app)</span>
                  <ArrowUpRight size={13} className="text-muted-foreground group-hover:text-white" />
                </a>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  AI-powered IDE for embedded hardware & firmware
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

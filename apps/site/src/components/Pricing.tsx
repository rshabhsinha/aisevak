import { useState } from "react";
import { Check, Lightning, Star, ShieldCheck, Sparkle, ArrowRight } from "./icons";

interface PricingProps {
  onOpenWaitlist: () => void;
}

export function Pricing({ onOpenWaitlist }: PricingProps) {
  return (
    <section id="pricing" className="py-24 border-t border-white/[0.08] relative">
      {/* Background ambient lighting */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[350px] bg-[#7c72ff]/10 blur-[130px] rounded-full pointer-events-none -z-10" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-mono text-[#c7c2ff] mb-4">
            <Lightning size={13} weight="fill" />
            <span>Transparent Workspace Pricing</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight text-white mb-4">
            Predictable per-workspace pricing. <br />
            <span className="bg-gradient-to-r from-white via-[#e2e0ff] to-[#7c72ff] bg-clip-text text-transparent">
              Zero token markup.
            </span>
          </h2>
          <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
            We price by dedicated cloud host compute, not per-seat. Connect your existing API keys and pay $0 middleman fee on tokens.
          </p>
        </div>

        {/* 3 Pricing Columns */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto items-stretch">
          {/* Tier 1: Community Open Source */}
          <div className="glass-card rounded-2xl p-6 sm:p-7 border border-white/[0.08] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-wider">
                  Community
                </span>
                <span className="text-[11px] font-mono text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded">
                  MIT License
                </span>
              </div>

              <div className="mb-6">
                <div className="text-4xl font-extrabold text-white font-mono">$0</div>
                <div className="text-xs text-muted-foreground mt-1">Free forever • Self-hosted on your VM</div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed pb-6 border-b border-white/[0.06] mb-6">
                Full source code for developers running sovereign multi-agent squads on their own hardware.
              </p>

              <ul className="space-y-3 text-xs text-white/90">
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>100% full source code (MIT)</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>Unlimited agents & durable threads</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>Isolated Git worktree system</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>Direct CLI socket coordination</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>BYO Codex / Claude subscriptions</span>
                </li>
              </ul>
            </div>

            <div className="pt-8">
              <a
                href="https://github.com/rshabhsinha/aisevak"
                target="_blank"
                rel="noreferrer"
                className="btn-secondary w-full justify-center text-xs py-2.5"
              >
                View on GitHub →
              </a>
            </div>
          </div>

          {/* Tier 2: Founding Member Cloud (Featured) */}
          <div className="glass-card rounded-2xl p-6 sm:p-7 border border-[#7c72ff]/50 bg-gradient-to-b from-[#181824] to-[#101017] shadow-[0_0_40px_rgba(124,114,255,0.25)] flex flex-col justify-between relative scale-[1.02]">
            {/* Urgency Badge */}
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-[#7c72ff] text-black font-mono text-[11px] font-bold uppercase tracking-wider shadow-lg">
              🔥 42 of 50 Spots Reserved
            </div>

            <div>
              <div className="flex items-center justify-between mb-4 mt-2">
                <span className="text-sm font-mono font-semibold text-[#c7c2ff] uppercase tracking-wider">
                  Founding Member Cloud
                </span>
                <span className="text-[11px] font-mono text-[#7c72ff] bg-[#7c72ff]/15 border border-[#7c72ff]/30 px-2 py-0.5 rounded">
                  21-Day Free Trial
                </span>
              </div>

              <div className="mb-6">
                <div className="flex items-baseline gap-2">
                  <div className="text-4xl font-extrabold text-white font-mono">$79</div>
                  <div className="text-xs text-muted-foreground font-mono">/ month (locked for life)</div>
                </div>
                <div className="text-xs text-emerald-400 mt-1">Dedicated 4 vCPU / 8GB NVMe VM included</div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed pb-6 border-b border-white/[0.08] mb-6">
                Dedicated single-tenant cloud instance with automated zero-downtime updates and direct founder support.
              </p>

              <ul className="space-y-3 text-xs text-white/90">
                <li className="flex items-center gap-2.5 font-medium">
                  <Check size={14} className="text-[#7c72ff] shrink-0" />
                  <span>Dedicated single-tenant NVMe instance</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-[#7c72ff] shrink-0" />
                  <span>Custom <code className="text-[#c7c2ff]">you.aisevak.com</code> subdomain</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-[#7c72ff] shrink-0" />
                  <span>Zero-downtime rolling upgrades</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-[#7c72ff] shrink-0" />
                  <span>Encrypted daily S3 backups</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-[#7c72ff] shrink-0" />
                  <span>Direct WhatsApp / Slack with founders</span>
                </li>
              </ul>
            </div>

            <div className="pt-8">
              <button
                type="button"
                onClick={onOpenWaitlist}
                className="btn-primary w-full justify-center text-xs py-3 font-bold"
              >
                Claim Founding Member Spot →
              </button>
            </div>
          </div>

          {/* Tier 3: Team / Enterprise Cloud */}
          <div className="glass-card rounded-2xl p-6 sm:p-7 border border-white/[0.08] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-wider">
                  Team Cloud
                </span>
                <span className="text-[11px] font-mono text-purple-400 bg-purple-400/10 border border-purple-400/20 px-2 py-0.5 rounded">
                  Enterprise SLA
                </span>
              </div>

              <div className="mb-6">
                <div className="flex items-baseline gap-2">
                  <div className="text-4xl font-extrabold text-white font-mono">$199</div>
                  <div className="text-xs text-muted-foreground font-mono">/ month</div>
                </div>
                <div className="text-xs text-muted-foreground mt-1">Dedicated 8 vCPU / 16GB NVMe VM</div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed pb-6 border-b border-white/[0.06] mb-6">
                For scaling product teams requiring custom domains, multi-user RBAC, Tailscale routing, and SLAs.
              </p>

              <ul className="space-y-3 text-xs text-white/90">
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>Custom apex domain connection</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>Multi-user RBAC & SSO integration</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>VPC peering / Tailscale subnet routing</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>99.9% Uptime SLA & priority support</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>Custom tool sandbox provisioning</span>
                </li>
              </ul>
            </div>

            <div className="pt-8">
              <button
                type="button"
                onClick={onOpenWaitlist}
                className="btn-secondary w-full justify-center text-xs py-2.5"
              >
                Inquire for Team Cloud →
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useRef } from "react";
import { Blobatar } from "@blobatar/react";
import { HarnessLogo } from "./harness-icons";
import "blobatar/motion.css";
import "blobatar/gaze.css";

interface SquadMember {
  id: string;
  name: string;
  role: string;
  harness: "Claude Code" | "Cursor" | "Codex" | "OpenCode";
  model: string;
  description: string;
}

const SQUAD_PERSONAS: SquadMember[] = [
  {
    id: "builder-prime",
    name: "Builder Prime",
    role: "Engineering & Architecture",
    harness: "Claude Code",
    model: "Claude Sonnet 5",
    description: "Writes fullstack code, executes AST refactors, and compiles test suites in isolated Git worktrees."
  },
  {
    id: "growth-sentry",
    name: "Growth Sentry",
    role: "Marketing & Acquisition",
    harness: "Cursor",
    model: "Grok 4.6",
    description: "Analyzes ad spend across Meta/Google, manages conversion funnels, and drafts launch copy."
  },
  {
    id: "ledger-automator",
    name: "Ledger Automator",
    role: "Finance & Accounting",
    harness: "Codex",
    model: "GPT 5.6 Sol",
    description: "Reconciles Stripe subscriptions against bank wires, audits ARR, and generates rolling burn forecasts."
  },
  {
    id: "incident-commander",
    name: "Incident Commander",
    role: "24/7 Ops & Reliability",
    harness: "Claude Code",
    model: "Claude Opus 4.8",
    description: "Monitors CloudWatch alarms and server logs around the clock, isolating errors and staging fix PRs."
  },
  {
    id: "support-scout",
    name: "Support Scout",
    role: "Customer Success",
    harness: "OpenCode",
    model: "GLM 3.7 Flash",
    description: "Triages enterprise customer inquiries, reproduces reported edge cases, and communicates resolutions."
  },
  {
    id: "chief-of-staff",
    name: "Chief of Staff",
    role: "Squad Orchestrator",
    harness: "OpenCode",
    model: "Kimi K3",
    description: "Coordinates inter-agent handoffs, balances squad workload, and publishes daily executive briefings."
  },
  {
    id: "security-sentry",
    name: "Security Sentry",
    role: "AppSec & Auditing",
    harness: "Claude Code",
    model: "Claude Opus 4.8",
    description: "Performs dependency vulnerability scans, audits secret access, and hardens cloud firewall rules."
  },
  {
    id: "pipeline-pilot",
    name: "Pipeline Pilot",
    role: "CI/CD & DevOps",
    harness: "Codex",
    model: "GPT 5.6 Luna",
    description: "Optimizes Docker build caches, manages staging ephemeral environments, and verifies canary rollouts."
  }
];

export function SquadMarquee() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    interface CardTracker {
      eyesEl: SVGGraphicsElement;
      itemEl: HTMLElement;
      currX: number;
      currY: number;
      targetX: number;
      targetY: number;
    }

    const trackers: CardTracker[] = [];
    const items = containerRef.current.querySelectorAll<HTMLElement>(".squad-blob-item");

    items.forEach((item) => {
      const eyes = item.querySelector<SVGGraphicsElement>(".mo-eyes");
      if (eyes) {
        trackers.push({
          eyesEl: eyes,
          itemEl: item,
          currX: 0,
          currY: 0,
          targetX: 0,
          targetY: 0
        });
      }
    });

    if (!trackers.length) return;

    let rafId: number | null = null;
    let mouseX = -9999;
    let mouseY = -9999;
    let isTracking = false;

    const tick = () => {
      let isMoving = false;

      for (const t of trackers) {
        if (isTracking && mouseX > -9000) {
          const rect = t.itemEl.getBoundingClientRect();
          if (rect.right > 0 && rect.left < window.innerWidth) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = mouseX - cx;
            const dy = mouseY - cy;
            const dist = Math.hypot(dx, dy);

            if (dist > 1) {
              const angle = Math.atan2(dy, dx);
              const factor = Math.min(1, dist / 32);
              const maxExcursion = 4.8;
              t.targetX = Math.cos(angle) * maxExcursion * factor;
              t.targetY = Math.sin(angle) * maxExcursion * factor;
            } else {
              t.targetX = 0;
              t.targetY = 0;
            }
          } else {
            t.targetX = 0;
            t.targetY = 0;
          }
        } else {
          t.targetX = 0;
          t.targetY = 0;
        }

        const diffX = t.targetX - t.currX;
        const diffY = t.targetY - t.currY;

        if (Math.abs(diffX) > 0.02 || Math.abs(diffY) > 0.02) {
          t.currX += diffX * 0.22;
          t.currY += diffY * 0.22;
          isMoving = true;
        } else {
          t.currX = t.targetX;
          t.currY = t.targetY;
        }

        t.eyesEl.style.transform = `translate3d(${t.currX.toFixed(2)}px, ${t.currY.toFixed(2)}px, 0)`;
      }

      if (isTracking || isMoving) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      if (!isTracking) {
        isTracking = true;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(tick);
      }
    };

    const handleMouseLeave = () => {
      mouseX = -9999;
      mouseY = -9999;
      isTracking = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave, { passive: true });

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // Double the array for seamless infinite marquee scrolling
  const marqueeList = [...SQUAD_PERSONAS, ...SQUAD_PERSONAS];

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden py-4 select-none group">
      {/* Left Edge Gradient Fade */}
      <div className="absolute left-0 top-0 bottom-0 w-12 sm:w-24 bg-gradient-to-r from-white via-white/80 to-transparent z-20 pointer-events-none" />

      {/* Right Edge Gradient Fade */}
      <div className="absolute right-0 top-0 bottom-0 w-12 sm:w-24 bg-gradient-to-l from-white via-white/80 to-transparent z-20 pointer-events-none" />

      {/* Marquee Track (flowing right to left, pauses on hover) */}
      <div className="animate-marquee flex items-stretch gap-4 sm:gap-5">
        {marqueeList.map((member, idx) => (
          <div
            key={`${member.id}-${idx}`}
            className="clean-card w-[290px] sm:w-[325px] shrink-0 p-5 space-y-3 flex flex-col justify-between hover:border-black/25 hover:shadow-md transition-all duration-200 bg-white"
          >
            <div>
              <div className="flex items-start justify-between gap-2.5 mb-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="squad-blob-item w-8 h-8 shrink-0 rounded-full overflow-hidden flex items-center justify-center pointer-events-none">
                    <Blobatar
                      animate="always"
                      className="w-full h-full object-contain block pointer-events-none"
                      name={member.name}
                      title={`${member.name} avatar`}
                    />
                  </div>
                  <div className="truncate">
                    <div className="text-[13px] font-bold text-[#09090b] tracking-tight truncate">
                      {member.name}
                    </div>
                    <div className="text-[10.5px] font-mono text-slate-500 truncate">
                      {member.role}
                    </div>
                  </div>
                </div>

                {/* Harness Logo */}
                <HarnessLogo harness={member.harness} className="w-3.5 h-3.5" />
              </div>

              <p className="text-xs text-slate-600 leading-relaxed mb-3">
                {member.description}
              </p>
            </div>

            <div className="pt-2 border-t border-black/[0.04] flex items-center justify-between text-[11px] font-mono text-slate-600">
              <span className="text-slate-400">Model</span>
              <span className="font-semibold text-slate-800">{member.model}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

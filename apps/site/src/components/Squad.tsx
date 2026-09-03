import { SquadMarquee } from "./SquadMarquee";

export function Squad() {
  return (
    <section id="squad" className="py-20 md:py-28 border-t border-black/[0.06] bg-white overflow-hidden">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 text-left mb-8">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#09090b] mb-2">
          Meet your autonomous workforce.
        </h2>
        <p className="text-sm sm:text-base text-slate-600 max-w-2xl">
          Self-organizing squads configured across your chosen harnesses (Claude Code, Cursor, Codex, OpenCode) with next-generation reasoning models.
        </p>
      </div>

      {/* Infinite Self-Scrolling Marquee Track */}
      <div className="w-full">
        <SquadMarquee />
      </div>
    </section>
  );
}

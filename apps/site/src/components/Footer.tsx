import { ArrowUpRight, Github } from "./icons";

export function Footer() {
  return (
    <footer className="border-t border-black/[0.08] text-slate-500 text-xs sm:text-[13px] pt-16 pb-12 bg-[#fafafc]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 pb-12 border-b border-black/[0.06] text-left">
          {/* Col 1 */}
          <div className="space-y-2.5">
            <div className="text-[#09090b] font-semibold text-xs sm:text-sm">Product</div>
            <ul className="space-y-1.5 text-xs sm:text-[13px]">
              <li>
                <a href="#features" className="hover:text-black transition-colors">
                  Capabilities
                </a>
              </li>
              <li>
                <a href="#squad" className="hover:text-black transition-colors">
                  Squad Personas
                </a>
              </li>
              <li>
                <a href="#cli" className="hover:text-black transition-colors">
                  Agent Protocol
                </a>
              </li>
              <li>
                <a
                  href="https://aisevak.embedr.dev"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-black transition-colors inline-flex items-center gap-1"
                >
                  <span>Live Demo</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
            </ul>
          </div>

          {/* Col 2 */}
          <div className="space-y-2.5">
            <div className="text-[#09090b] font-semibold text-xs sm:text-sm">Open Source</div>
            <ul className="space-y-1.5 text-xs sm:text-[13px]">
              <li>
                <a
                  href="https://github.com/rshabhsinha/aisevak"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-black transition-colors inline-flex items-center gap-1"
                >
                  <Github size={13} />
                  <span>GitHub</span>
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/rshabhsinha/aisevak/blob/main/LICENSE"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-black transition-colors"
                >
                  MIT License
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/rshabhsinha/aisevak/blob/main/CONTRIBUTING.md"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-black transition-colors"
                >
                  Contributing
                </a>
              </li>
            </ul>
          </div>

          {/* Col 3 */}
          <div className="space-y-2.5">
            <div className="text-[#09090b] font-semibold text-xs sm:text-sm">Company</div>
            <ul className="space-y-1.5 text-xs sm:text-[13px]">
              <li>
                <a
                  href="https://promptlabs.link"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-black transition-colors inline-flex items-center gap-1"
                >
                  <span>PromptLabs Pvt Ltd</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
              <li>
                <a
                  href="https://embedr.app"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-black transition-colors inline-flex items-center gap-1"
                >
                  <span>Embedr</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
              <li>
                <a
                  href="https://newsletter.embedr.app"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-black transition-colors inline-flex items-center gap-1"
                >
                  <span>Newsletter</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
            </ul>
          </div>

          {/* Col 4 */}
          <div className="space-y-2.5">
            <div className="text-[#09090b] font-semibold text-xs sm:text-sm">Origin</div>
            <p className="text-xs text-slate-500 leading-relaxed font-sans">
              Built by PromptLabs to allow autonomous AI agents to run companies end-to-end without human bottlenecks.
            </p>
          </div>
        </div>

        {/* Bottom */}
        <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400 font-mono">
          <div>
            © {new Date().getFullYear()} PromptLabs Pvt Ltd. All rights reserved.
          </div>
          <div>
            100% open-source (MIT).
          </div>
        </div>
      </div>
    </footer>
  );
}

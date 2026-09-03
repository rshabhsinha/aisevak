import { useState, useEffect } from "react";
import { Github, ListIcon, X } from "./icons";

interface NavbarProps {
  onOpenWaitlist: () => void;
}

export function Navbar({ onOpenWaitlist }: NavbarProps) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-150 ${
        scrolled
          ? "bg-white/90 backdrop-blur-md border-b border-black/[0.06] shadow-sm"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Brand */}
        <a href="#" className="flex items-center gap-2 text-[#09090b] font-medium text-base tracking-tight hover:opacity-85 transition-opacity">
          <span className="font-bold tracking-tight">aisevak</span>
        </a>

        {/* Center Nav */}
        <nav className="hidden md:flex items-center gap-8 text-sm text-slate-500">
          <a href="#features" className="hover:text-black transition-colors font-medium">
            Capabilities
          </a>
          <a href="#squad" className="hover:text-black transition-colors font-medium">
            Squad
          </a>
          <a href="#cli" className="hover:text-black transition-colors font-medium">
            Protocol
          </a>
          <a href="#faq" className="hover:text-black transition-colors font-medium">
            Docs & FAQ
          </a>
          <a
            href="https://aisevak.embedr.dev"
            target="_blank"
            rel="noreferrer"
            className="hover:text-black transition-colors font-medium"
          >
            Live Demo
          </a>
        </nav>

        {/* Right Actions */}
        <div className="hidden sm:flex items-center gap-4">
          <a
            href="https://github.com/rshabhsinha/aisevak"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-slate-500 hover:text-black flex items-center gap-2 transition-colors font-medium"
          >
            <Github size={17} />
            <span>GitHub</span>
          </a>

          <button
            type="button"
            onClick={onOpenWaitlist}
            className="btn-primary text-xs font-semibold !py-2 !px-4"
          >
            <span>Join Waitlist</span>
          </button>
        </div>

        {/* Mobile toggle */}
        <div className="flex md:hidden items-center">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 text-slate-600 hover:text-black"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X size={20} /> : <ListIcon size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="md:hidden px-6 py-5 bg-white border-b border-black/[0.06] space-y-4 text-sm shadow-md">
          <a
            href="#features"
            onClick={() => setMobileMenuOpen(false)}
            className="block text-slate-600 hover:text-black py-1 font-medium"
          >
            Capabilities
          </a>
          <a
            href="#squad"
            onClick={() => setMobileMenuOpen(false)}
            className="block text-slate-600 hover:text-black py-1 font-medium"
          >
            Squad
          </a>
          <a
            href="#cli"
            onClick={() => setMobileMenuOpen(false)}
            className="block text-slate-600 hover:text-black py-1 font-medium"
          >
            Protocol
          </a>
          <a
            href="#faq"
            onClick={() => setMobileMenuOpen(false)}
            className="block text-slate-600 hover:text-black py-1 font-medium"
          >
            FAQ
          </a>
          <div className="pt-3 border-t border-black/[0.06] flex items-center justify-between">
            <a
              href="https://github.com/rshabhsinha/aisevak"
              target="_blank"
              rel="noreferrer"
              className="text-slate-600 hover:text-black flex items-center gap-2 text-sm font-medium"
            >
              <Github size={16} /> GitHub
            </a>
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                onOpenWaitlist();
              }}
              className="btn-primary text-xs"
            >
              Join Waitlist
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

import { useState, type FormEvent } from "react";
import { Check, ArrowRight } from "./icons";

export function Waitlist() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes("@")) return;

    setLoading(true);
    try {
      await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          status: "enabled",
          lists: [7],
          preconfirm_subscriptions: true,
          attribs: {
            signup_source: "aisevak.com"
          }
        })
      });
      setSubmitted(true);
    } catch {
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section id="waitlist" className="pt-24 pb-20 md:pt-32 md:pb-28 border-t border-black/[0.06] text-center relative overflow-hidden bg-gradient-to-b from-[#ffffff] to-[#f8f8fb]">
      {/* Light Mode Arc Wireframe */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[680px] h-[280px] pointer-events-none opacity-25">
        <svg viewBox="0 0 800 360" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
          <ellipse cx="400" cy="360" rx="380" ry="240" stroke="url(#arc-gradient-light)" strokeWidth="1" />
          <ellipse cx="400" cy="360" rx="280" ry="180" stroke="url(#arc-gradient-light)" strokeWidth="1" />
          <ellipse cx="400" cy="360" rx="160" ry="100" stroke="url(#arc-gradient-light)" strokeWidth="1" />
          <defs>
            <linearGradient id="arc-gradient-light" x1="0" y1="360" x2="800" y2="360" gradientUnits="userSpaceOnUse">
              <stop stopColor="#6366f1" stopOpacity="0" />
              <stop offset="0.5" stopColor="#4f46e5" stopOpacity="0.8" />
              <stop offset="1" stopColor="#6366f1" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      <div className="max-w-xl mx-auto px-4 sm:px-6 relative z-10">
        <h2 className="text-3xl sm:text-4xl lg:text-[44px] font-bold tracking-tight text-[#09090b] mb-3.5 leading-tight">
          Deploy your autonomous workforce.
        </h2>
        <p className="text-sm sm:text-base text-slate-600 mb-8 leading-relaxed">
          Get early access to dedicated AiSevak cloud instances and local runner binaries.
        </p>

        {!submitted ? (
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-center gap-2.5 max-w-md mx-auto">
            <input
              type="email"
              required
              placeholder="Enter your work email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full sm:flex-1 h-10 px-3.5 rounded-md bg-white border border-black/[0.12] focus:border-indigo-600 text-xs sm:text-[13px] text-[#09090b] placeholder:text-slate-400 outline-none font-sans shadow-xs"
            />
            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full sm:w-auto h-10 px-5 text-xs sm:text-[13px] shrink-0 font-semibold"
            >
              <span>{loading ? "Joining..." : "Join Waitlist"}</span>
              <ArrowRight size={13} />
            </button>
          </form>
        ) : (
          <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-mono text-emerald-900 inline-flex items-center gap-2">
            <Check size={14} className="text-emerald-600" />
            <span>You're on the list ({email}). We'll reach out shortly.</span>
          </div>
        )}
      </div>
    </section>
  );
}

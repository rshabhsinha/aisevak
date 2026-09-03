import { useState } from "react";
import { ChevronDown, ChevronRight } from "./icons";

interface FaqItem {
  question: string;
  answer: string;
}

const FAQ_DATA: FaqItem[] = [
  {
    question: "How is AiSevak different from local agent tools like Claude Code or OpenCode?",
    answer:
      "Local assistants run on your laptop and terminate as soon as your machine sleeps or you close your terminal. AiSevak deploys directly to your own Cloud VM (AWS, GCP, Hetzner, or VPS) with a single command, keeping persistent multi-agent squads running 24/7 in the cloud. You get real-time monitoring, worktree inspection, and task dispatch from any web browser without draining your machine's battery."
  },
  {
    question: "Where do credentials and company data reside?",
    answer:
      "Your data and API tokens never route through a third-party multi-tenant middleman. Self-hosted instances run entirely on your hardware or cloud VM; managed instances run on dedicated single-tenant NVMe VMs with encrypted PostgreSQL vaults."
  },
  {
    question: "How does the Zero Token Markup model work?",
    answer:
      "You connect your existing agent harnesses—such as Cursor, Claude Code, OpenAI Codex (device-code auth), or OpenCode—configured with whatever underlying models they support. AiSevak orchestrates the harness execution and charges $0 on token throughput."
  },
  {
    question: "Can agents execute mutating actions safely?",
    answer:
      "All turns execute inside isolated workspace sandboxes. You can require human approval for financial transactions, ad budget changes, or codebase merges, or permit host-native autonomous execution on sandboxed instances."
  },
  {
    question: "Can I connect open-source harnesses or local endpoints?",
    answer:
      "Yes. Any harness supporting OpenAI-compatible endpoints, Ollama, or local vLLM instances can be bound to specific agent personas in your workspace configuration."
  }
];

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggle = (idx: number) => {
    setOpenIndex(openIndex === idx ? null : idx);
  };

  return (
    <section id="faq" className="py-20 md:py-28 border-t border-black/[0.06] bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 text-left">
        <div className="mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#09090b] mb-2">
            Frequently Asked Questions
          </h2>
          <p className="text-sm sm:text-base text-slate-600">
            Key details on architecture, sandboxing, and security.
          </p>
        </div>

        <div className="divide-y divide-black/[0.08] border-y border-black/[0.08]">
          {FAQ_DATA.map((item, idx) => {
            const isOpen = openIndex === idx;
            return (
              <div key={idx} className="py-4 sm:py-5">
                <button
                  type="button"
                  onClick={() => toggle(idx)}
                  className="w-full text-left flex items-center justify-between gap-4 text-sm sm:text-[15px] font-medium text-[#09090b] hover:text-indigo-600 transition-colors"
                >
                  <span>{item.question}</span>
                  <span className="text-slate-400 shrink-0">
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </span>
                </button>

                {isOpen && (
                  <p className="text-xs sm:text-sm text-slate-600 mt-2.5 leading-relaxed font-sans">
                    {item.answer}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

import { Check, X, ShieldCheck, HardDrives } from "./icons";

interface FeatureRow {
  name: string;
  category: string;
  selfHosted: string | boolean;
  managedCloud: string | boolean;
}

const COMPARISON_DATA: FeatureRow[] = [
  {
    category: "Core Engine",
    name: "100% Full Source Code (MIT License)",
    selfHosted: true,
    managedCloud: true
  },
  {
    category: "Core Engine",
    name: "Multi-Agent Durable Threads & Orchestration",
    selfHosted: "Unlimited",
    managedCloud: "Unlimited"
  },
  {
    category: "Core Engine",
    name: "Isolated Git Worktrees & Ast-Grep Tooling",
    selfHosted: true,
    managedCloud: true
  },
  {
    category: "Core Engine",
    name: "$0 Token Fee (Bring Your Own API Keys)",
    selfHosted: true,
    managedCloud: true
  },
  {
    category: "Cloud Operations",
    name: "Zero-Downtime Automated Rolling Upgrades",
    selfHosted: "Manual bash script",
    managedCloud: "Automated via SSM"
  },
  {
    category: "Cloud Operations",
    name: "Dedicated Custom Subdomain (`you.aisevak.com`)",
    selfHosted: "Self-configured DNS",
    managedCloud: "Instant 1-Click Provisioning"
  },
  {
    category: "Cloud Operations",
    name: "Encrypted Daily S3 Database & Workspace Backups",
    selfHosted: "Manual cron",
    managedCloud: "Automated & Verified"
  },
  {
    category: "Infrastructure",
    name: "Dedicated Single-Tenant High-Speed NVMe VM",
    selfHosted: "Your own AWS/GCP/Mac",
    managedCloud: "Dedicated 4-8 vCPU included"
  },
  {
    category: "Support",
    name: "Support Channel",
    selfHosted: "Community GitHub & Discord",
    managedCloud: "Direct Slack/WhatsApp with Founders"
  }
];

export function OpenSource() {
  return (
    <section className="py-24 border-t border-white/[0.08] relative">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-mono text-[#c7c2ff] mb-4">
            <HardDrives size={13} weight="fill" />
            <span>Deployment Architecture</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white mb-4">
            Self-host on your metal, <br />
            <span className="text-muted-foreground font-normal">or run on dedicated cloud.</span>
          </h2>
          <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
            AiSevak is 100% open-source under the MIT license. Choose between full self-hosting freedom or zero-maintenance managed single-tenant infrastructure.
          </p>
        </div>

        {/* Matrix Comparison Table */}
        <div className="glass-card rounded-2xl border border-white/[0.1] overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] bg-[#121217]">
                  <th className="py-4 px-5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Feature & Capability
                  </th>
                  <th className="py-4 px-5 text-xs font-semibold text-white uppercase tracking-wider text-center w-1/3">
                    Community Self-Host
                  </th>
                  <th className="py-4 px-5 text-xs font-semibold text-[#c7c2ff] uppercase tracking-wider text-center w-1/3 bg-[#7c72ff]/5 border-l border-white/[0.06]">
                    Managed Cloud (Founding)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {COMPARISON_DATA.map((row, idx) => (
                  <tr
                    key={idx}
                    className="hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-3.5 px-5 font-medium text-white/90">
                      {row.name}
                    </td>

                    <td className="py-3.5 px-5 text-center text-muted-foreground font-mono text-xs">
                      {typeof row.selfHosted === "boolean" ? (
                        row.selfHosted ? (
                          <Check size={16} className="text-emerald-400 mx-auto" />
                        ) : (
                          <X size={16} className="text-rose-400 mx-auto" />
                        )
                      ) : (
                        <span>{row.selfHosted}</span>
                      )}
                    </td>

                    <td className="py-3.5 px-5 text-center font-mono text-xs bg-[#7c72ff]/5 border-l border-white/[0.06] text-white">
                      {typeof row.managedCloud === "boolean" ? (
                        row.managedCloud ? (
                          <Check size={16} className="text-emerald-400 mx-auto" />
                        ) : (
                          <X size={16} className="text-rose-400 mx-auto" />
                        )
                      ) : (
                        <span className="text-[#c7c2ff] font-semibold">{row.managedCloud}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

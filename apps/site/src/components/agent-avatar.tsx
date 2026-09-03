import { Blobatar } from "@blobatar/react";
import { agentAvatarSeed } from "../agentAvatar";
import { cn } from "../lib/utils";
import { type OrbVariant } from "./aicss/agent-orbs";

export function AgentAvatar(props: {
  agentId: string;
  agentName: string;
  className?: string;
  motion?: "hover" | "always";
  orbVariant?: OrbVariant;
}) {
  const seed = agentAvatarSeed(props.agentId, props.agentName);
  const label = `${props.agentName || "Agent"} avatar`;
  const isWorking = props.orbVariant && props.orbVariant !== "idle";

  return (
    <div className={cn("agent-avatar relative inline-flex shrink-0 items-center justify-center select-none", props.className)}>
      <div className="agent-avatar-inner w-full h-full rounded-full overflow-hidden flex items-center justify-center pointer-events-none">
        <Blobatar
          animate={props.motion ?? "always"}
          className="w-full h-full object-contain block pointer-events-none"
          data-agent-avatar={seed}
          name={seed}
          title={label}
        />
      </div>
      {isWorking ? (
        <span
          className="agent-avatar-badge absolute -bottom-0.5 -right-0.5 z-10 flex items-center justify-center rounded-full bg-[#09090b] border border-white/15 shadow-sm pointer-events-none"
          style={{ width: "36%", height: "36%", minWidth: 7, minHeight: 7, maxWidth: 14, maxHeight: 14 }}
          title="Agent is working"
        >
          <span className="relative flex w-full h-full items-center justify-center">
            <span className="absolute inline-flex w-full h-full animate-ping rounded-full bg-[#7c72ff] opacity-75" />
            <span className="relative inline-flex w-2/3 h-2/3 rounded-full bg-[#7c72ff]" />
          </span>
        </span>
      ) : null}
    </div>
  );
}

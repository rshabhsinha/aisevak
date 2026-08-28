import { Blobatar } from "@blobatar/react";
import { agentAvatarSeed } from "../agentAvatar";
import { cn } from "../lib/utils";
import { AgentOrb, type OrbVariant } from "./aicss/agent-orbs";

export function AgentAvatar(props: {
  agentId: string;
  agentName: string;
  className?: string;
  motion?: "hover" | "always";
  orbVariant?: OrbVariant;
}) {
  const seed = agentAvatarSeed(props.agentId, props.agentName);
  const label = `${props.agentName || "Agent"} profile picture`;
  const isWorking = props.orbVariant && props.orbVariant !== "idle";

  return (
    <div className={cn("agent-avatar relative inline-flex shrink-0 items-center justify-center", props.className)}>
      <div className="agent-avatar-inner w-full h-full rounded-full overflow-hidden flex items-center justify-center pointer-events-none">
        <Blobatar
          animate={props.motion ?? "hover"}
          className="w-full h-full object-contain block pointer-events-none"
          data-agent-avatar={seed}
          name={seed}
          title={label}
        />
      </div>
      {isWorking ? (
        <span
          className="agent-avatar-badge absolute -bottom-0.5 -right-0.5 z-10 flex items-center justify-center rounded-full bg-background border border-border shadow-xs pointer-events-none"
          style={{ width: "38%", height: "38%", minWidth: 6, minHeight: 6, maxWidth: 12, maxHeight: 12 }}
          title="Agent is working"
        >
          <span className="relative flex w-full h-full items-center justify-center">
            <span className="absolute inline-flex w-full h-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex w-2/3 h-2/3 rounded-full bg-primary" />
          </span>
        </span>
      ) : null}
    </div>
  );
}

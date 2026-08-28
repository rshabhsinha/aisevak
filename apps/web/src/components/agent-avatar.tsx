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

  return (
    <div className={cn("agent-avatar relative inline-flex shrink-0 items-center justify-center overflow-hidden", props.className)}>
      <Blobatar
        animate={props.motion ?? "hover"}
        className="w-full h-full object-contain block pointer-events-none"
        data-agent-avatar={seed}
        name={seed}
        title={label}
      />
      {props.orbVariant && props.orbVariant !== "idle" && (
        <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center p-0.5 rounded-full bg-card border border-border shadow-xs">
          <AgentOrb variant={props.orbVariant} size={9} color="var(--primary)" />
        </span>
      )}
    </div>
  );
}

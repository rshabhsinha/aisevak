import { describeAgentAvatar } from "../agentAvatar";
import { cn } from "../lib/utils";

export function AgentAvatar(props: {
  agentId: string;
  agentName: string;
  className?: string;
}) {
  const avatar = describeAgentAvatar(props.agentId);

  return (
    <svg
      aria-label={`${props.agentName} profile picture`}
      className={cn("agent-avatar", props.className)}
      data-agent-avatar={props.agentId}
      role="img"
      viewBox="0 0 5 5"
    >
      <rect width="5" height="5" fill={avatar.background} />
      <g shapeRendering="crispEdges">
        {avatar.cells.map((cell) => (
          <rect
            fill={avatar.color}
            height="1"
            key={`${cell.x}-${cell.y}`}
            width="1"
            x={cell.x}
            y={cell.y}
          />
        ))}
      </g>
    </svg>
  );
}

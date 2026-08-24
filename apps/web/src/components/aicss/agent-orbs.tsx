import type { CSSProperties, ReactElement } from "react";

export type OrbVariant = "thinking" | "processing" | "working" | "searching" | "finalizing" | "idle";

interface AgentOrbProps {
  variant?: OrbVariant;
  size?: number;
  className?: string;
  color?: string;
  label?: string;
}

// 3x3 matrix offsets and animation deltas
const LATTICE_NODES = [
  { id: "c0", left: 0, top: 0, delay: 0, ax: "-3px", ay: "4px", bx: "4px", by: "-3px" },
  { id: "c1", left: 5, top: 0, delay: 150, ax: "-4px", ay: "1px", bx: "4px", by: "1px" },
  { id: "c2", left: 10, top: 0, delay: 300, ax: "-4px", ay: "-3px", bx: "3px", by: "4px" },
  { id: "c3", left: 0, top: 5, delay: 150, ax: "1px", ay: "4px", bx: "1px", by: "-4px" },
  { id: "c4", left: 5, top: 5, delay: 0, ax: "0px", ay: "0px", bx: "0px", by: "0px", isCenter: true },
  { id: "c5", left: 10, top: 5, delay: 450, ax: "-1px", ay: "-4px", bx: "-1px", by: "4px" },
  { id: "c6", left: 0, top: 10, delay: 300, ax: "4px", ay: "3px", bx: "-3px", by: "-4px" },
  { id: "c7", left: 5, top: 10, delay: 450, ax: "4px", ay: "-1px", bx: "-4px", by: "-1px" },
  { id: "c8", left: 10, top: 10, delay: 600, ax: "3px", ay: "-4px", bx: "-4px", by: "3px" }
];

export function AgentOrb({
  variant = "thinking",
  size = 14,
  className = "",
  color,
  label
}: AgentOrbProps): ReactElement {
  const isIdle = variant === "idle";
  const scale = size / 14;

  return (
    <span
      className={`aicss-orb-lattice ${className}`}
      role="img"
      aria-label={label ?? `Agent state: ${variant}`}
      style={{
        width: size,
        height: size,
        color: color ?? "currentColor"
      }}
    >
      <span
        style={{
          display: "block",
          position: "relative",
          width: 14,
          height: 14,
          transform: `scale(${scale})`,
          transformOrigin: "top left"
        }}
      >
        {LATTICE_NODES.map((node) => {
          const style: CSSProperties = {
            left: node.left,
            top: node.top,
            animationDelay: isIdle ? "0ms" : `${node.delay}ms`,
            animationPlayState: isIdle ? "paused" : "running",
            opacity: isIdle ? 0.35 : undefined,
            // Custom properties for keyframe interpolation
            ["--orb-ax" as string]: node.ax,
            ["--orb-ay" as string]: node.ay,
            ["--orb-bx" as string]: node.bx,
            ["--orb-by" as string]: node.by
          };

          return <span key={node.id} className="aicss-orb-cell" style={style} />;
        })}
      </span>
    </span>
  );
}

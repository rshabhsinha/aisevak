import type { CSSProperties, ReactElement } from "react";

interface DotMatrixLoaderProps {
  size?: number;
  className?: string;
  color?: string;
}

const DOT_DELAYS = [0, 100, 200, 300, 400, 500, 600, 700, 800];

export function DotMatrixLoader({
  size = 14,
  className = "",
  color
}: DotMatrixLoaderProps): ReactElement {
  const style: CSSProperties = {
    width: size,
    height: size,
    color: color ?? "var(--primary)"
  };

  return (
    <div className={`aicss-matrix-loader ${className}`} style={style}>
      <div className="aicss-matrix-grid">
        {DOT_DELAYS.map((delay, i) => (
          <div
            key={i}
            className="aicss-matrix-dot"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

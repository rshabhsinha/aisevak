import type { CSSProperties, ReactElement } from "react";

interface DotMatrixLoaderProps {
  size?: number;
  className?: string;
  color?: string;
  label?: string;
}

const MATRIX_CELLS = [
  { id: "00", delay: 0 },
  { id: "01", delay: 120 },
  { id: "02", delay: 240 },
  { id: "10", delay: 120 },
  { id: "11", delay: 240 },
  { id: "12", delay: 360 },
  { id: "20", delay: 240 },
  { id: "21", delay: 360 },
  { id: "22", delay: 480 }
];

export function DotMatrixLoader({
  size = 16,
  className = "",
  color,
  label = "Loading…"
}: DotMatrixLoaderProps): ReactElement {
  const style: CSSProperties = {
    width: size,
    height: size,
    color: color ?? "currentColor"
  };

  return (
    <span
      className={`aicss-matrix-loader ${className}`}
      role="status"
      aria-label={label}
      style={style}
    >
      <span className="aicss-matrix-grid">
        {MATRIX_CELLS.map((cell) => (
          <span
            key={cell.id}
            className="aicss-matrix-dot"
            style={{
              animationDelay: `${cell.delay}ms`
            }}
          />
        ))}
      </span>
    </span>
  );
}

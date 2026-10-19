import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";

// Adapted from AICSS Reasoning Effort (https://www.aicss.dev/components/reasoning-effort):
// a stepped track whose label grows out of the shell while dragging. Changes from
// the original: controlled value, any number of levels from the harness, the
// model name passed in, and theme tokens via `.aicss-re` in composer.css.

export interface ReasoningLevel {
  id: string;
  label: string;
}

const TRACK = 224;
const HEIGHT = 32;
const RADIUS = HEIGHT / 2;
const BUMP_H = 20;
const REST_W = 27.2;
const DRAG_W = 33.6;
const REST_H = 27.2;
const EDGE_PAD = (HEIGHT - REST_H) / 2;
const LEFT_SHOULDER = 23.572;
/** Space from each glyph edge to the foot of the label shoulder. */
const TEXT_SIDE = 20;
/** How far the outer foot walks down the cap once it passes the crown. */
const PHI_MAX = 0.6;
const PHI_REACH = 36;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

function smoothstep(t: number) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function plateauFor(textW: number) {
  return Math.max(8, textW + TEXT_SIDE * 2 - LEFT_SHOULDER * 2);
}

function capFoot(side: -1 | 1, phi: number) {
  const crown = side === -1 ? RADIUS : TRACK - RADIUS;
  return { x: crown + side * RADIUS * Math.sin(phi), y: BUMP_H + RADIUS * (1 - Math.cos(phi)) };
}

function shellGeom(cx: number, plateauW: number) {
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  let topL = cx - plateauW / 2;
  let topR = topL + plateauW;
  let phiL = 0;
  let phiR = 0;

  const overflowL = crownL - (topL - LEFT_SHOULDER);
  if (overflowL > 0) {
    phiL = PHI_MAX * smoothstep(overflowL / PHI_REACH);
    const foot = capFoot(-1, phiL);
    const minTopL = foot.x + LEFT_SHOULDER * Math.cos(phiL);
    if (topL < minTopL) {
      topR += minTopL - topL;
      topL = minTopL;
    }
  }

  const overflowR = topR + LEFT_SHOULDER - crownR;
  if (overflowR > 0) {
    phiR = PHI_MAX * smoothstep(overflowR / PHI_REACH);
    const foot = capFoot(1, phiR);
    const maxTopR = foot.x - LEFT_SHOULDER * Math.cos(phiR);
    if (topR > maxTopR) {
      topL -= topR - maxTopR;
      topR = maxTopR;
    }
  }

  const insetL = phiL > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiL)) : 0;
  const insetR = phiR > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiR)) : 0;
  topR += insetL;
  topL -= insetR;
  return { topL, topR, phiL, phiR, insetL, insetR };
}

function shoulderCmds(footX: number, footY: number, platX: number, platY: number, phi: number, dir: 1 | -1) {
  const xScale = Math.abs(platX - footX) / LEFT_SHOULDER;
  const yScale = Math.max(0.001, (footY - platY) / 20);
  const tangent = { x: dir * Math.cos(phi), y: -Math.sin(phi) };
  const map = (lx: number, ly: number) => ({ x: footX + dir * lx * xScale, y: footY + (ly - 20) * yScale });
  const h1 = 5.398 * xScale;
  const p0 = { x: footX, y: footY };
  const c1 = { x: footX + tangent.x * h1, y: footY + tangent.y * h1 };
  const c2 = map(10.012, 16.114);
  const p1 = map(10.93, 10.794);
  const c3 = map(11.916, 4.577);
  const c4 = map(17.277, 0);
  const p3 = { x: platX, y: platY };
  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  if (dir === 1) return `C${fmt(c1)} ${fmt(c2)} ${fmt(p1)}C${fmt(c3)} ${fmt(c4)} ${fmt(p3)}`;
  return `C${fmt(c4)} ${fmt(c3)} ${fmt(p1)}C${fmt(c2)} ${fmt(c1)} ${fmt(p0)}`;
}

function shellPath(cx: number, open: number, plateauW: number) {
  const trackTop = BUMP_H;
  const trackBot = BUMP_H + HEIGHT;
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  if (open < 0.012) {
    return `M${crownL} ${trackTop}H${crownR}A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}H${crownL}A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}Z`;
  }
  const bumpTop = BUMP_H * (1 - open);
  const { topL, topR, phiL, phiR } = shellGeom(cx, plateauW);
  const cmds = [`M${crownL} ${trackBot}`];
  if (phiL > 0.001) {
    const foot = capFoot(-1, phiL);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${foot.x.toFixed(2)} ${foot.y.toFixed(2)}`);
    cmds.push(shoulderCmds(foot.x, foot.y, topL, bumpTop, phiL, 1));
  } else {
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}`);
    const footL = topL - LEFT_SHOULDER;
    if (footL > crownL + 0.4) cmds.push(`H${footL.toFixed(2)}`);
    cmds.push(shoulderCmds(footL, trackTop, topL, bumpTop, 0, 1));
  }
  if (topR > topL + 0.4) cmds.push(`H${topR.toFixed(2)}`);
  if (phiR > 0.001) {
    const foot = capFoot(1, phiR);
    cmds.push(shoulderCmds(foot.x, foot.y, topR, bumpTop, phiR, -1));
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  } else {
    const footR = topR + LEFT_SHOULDER;
    cmds.push(shoulderCmds(footR, trackTop, topR, bumpTop, 0, -1));
    if (footR < crownR - 0.4) cmds.push(`H${crownR}`);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  }
  cmds.push(`H${crownL}Z`);
  return cmds.join("");
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ReasoningEffort({
  levels,
  value,
  onChange,
  modelLabel,
  disabled = false
}: {
  levels: ReasoningLevel[];
  value: string;
  onChange: (id: string) => void;
  modelLabel: string;
  disabled?: boolean;
}): ReactElement {
  const max = Math.max(1, levels.length - 1);
  const centerFor = (index: number) => RADIUS + (index / max) * (TRACK - RADIUS * 2);
  const valueIndex = Math.max(0, levels.findIndex((level) => level.id === value));

  const trackRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(valueIndex);
  const displayRef = useRef(valueIndex);
  const openRef = useRef(0);
  const draggingRef = useRef(false);
  const [display, setDisplay] = useState(valueIndex);
  const [open, setOpen] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [textW, setTextW] = useState(64);
  const plateauTarget = plateauFor(textW);
  const plateauRef = useRef(plateauTarget);
  const [plateauW, setPlateauW] = useState(plateauTarget);
  const revealRef = useRef(0);
  const [reveal, setReveal] = useState(0);
  const gradId = useId().replace(/:/g, "");

  // Follow the controlled value when it changes from outside.
  useEffect(() => {
    if (draggingRef.current) return;
    valueRef.current = valueIndex;
    displayRef.current = valueIndex;
    setDisplay(valueIndex);
  }, [valueIndex]);

  useEffect(() => {
    const toOpen = dragging ? 1 : 0;
    const fromOpen = openRef.current;
    const fromValue = displayRef.current;
    const targetValue = dragging ? fromValue : Math.round(valueRef.current);
    if (prefersReducedMotion()) {
      openRef.current = toOpen;
      setOpen(toOpen);
      if (!dragging) {
        valueRef.current = targetValue;
        displayRef.current = targetValue;
        setDisplay(targetValue);
      }
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 220);
      const e = easeOut(t);
      const nextOpen = fromOpen + (toOpen - fromOpen) * e;
      openRef.current = nextOpen;
      setOpen(nextOpen);
      if (!dragging) {
        const nextValue = fromValue + (targetValue - fromValue) * e;
        displayRef.current = nextValue;
        setDisplay(nextValue);
        if (t === 1) {
          valueRef.current = targetValue;
          displayRef.current = targetValue;
        }
      }
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [dragging]);

  useEffect(() => {
    const from = plateauRef.current;
    const to = plateauTarget;
    if (prefersReducedMotion() || Math.abs(to - from) < 0.3) {
      plateauRef.current = to;
      setPlateauW(to);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 90);
      const next = from + (to - from) * easeOut(t);
      plateauRef.current = next;
      setPlateauW(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [plateauTarget]);

  useEffect(() => {
    const to = dragging ? 1 : 0;
    const from = revealRef.current;
    if (prefersReducedMotion()) {
      revealRef.current = to;
      setReveal(to);
      return;
    }
    const delay = dragging ? 85 : 0;
    const duration = dragging ? 132 : 90;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const elapsed = now - start - delay;
      if (elapsed < 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      const t = Math.min(1, elapsed / duration);
      const next = from + (to - from) * easeOut(t);
      revealRef.current = next;
      setReveal(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [dragging]);

  function commit(next: number) {
    valueRef.current = next;
    displayRef.current = next;
    setDisplay(next);
  }

  function valueFrom(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return valueRef.current;
    const t = (clientX - rect.left - RADIUS) / (rect.width - RADIUS * 2);
    return clamp(t * max, 0, max);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0) return;
    draggingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer capture needs a trusted event. */
    }
    setDragging(true);
    commit(valueFrom(event.clientX));
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    commit(valueFrom(event.clientX));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* Ignore when the event was not trusted. */
    }
    setDragging(false);
    const level = levels[Math.round(valueRef.current)];
    if (level && level.id !== value) onChange(level.id);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const current = Math.round(valueRef.current);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(max, current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    event.stopPropagation();
    commit(next);
    const level = levels[next];
    if (level && level.id !== value) onChange(level.id);
  }

  const center = centerFor(display);
  const thumbW = REST_W + (DRAG_W - REST_W) * open;
  let thumbLeft = center - thumbW / 2;
  let thumbRight = thumbLeft + thumbW;
  if (thumbLeft < EDGE_PAD) {
    thumbLeft = EDGE_PAD;
    thumbRight = thumbLeft + thumbW;
  }
  if (thumbRight > TRACK - EDGE_PAD) {
    thumbRight = TRACK - EDGE_PAD;
    thumbLeft = thumbRight - thumbW;
  }
  const fillW = Math.min(TRACK, thumbRight + EDGE_PAD);
  const active = Math.round(display);
  const level = levels[active]?.label ?? "";
  const plateau = shellGeom(center, plateauW);
  const labelX = (plateau.topL + plateau.topR) / 2 + (plateau.insetL - plateau.insetR) / 2;

  useLayoutEffect(() => {
    const width = labelRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0 && Math.abs(width - textW) > 0.4) setTextW(width);
  }, [level, textW]);

  return (
    <div className="aicss-re" data-dragging={dragging ? "true" : "false"} data-disabled={disabled ? "true" : "false"}>
      <svg className="aicss-re-shell" viewBox={`0 0 ${TRACK} ${BUMP_H + HEIGHT}`} aria-hidden>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--re-shell)" />
            <stop offset="1" stopColor="var(--re-shell-2)" />
          </linearGradient>
        </defs>
        <path
          d={shellPath(center, open, plateauW)}
          fill={`url(#${gradId})`}
          stroke="var(--re-line)"
          strokeWidth="0.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div
        ref={labelRef}
        className="aicss-re-label"
        style={{
          left: labelX,
          opacity: reveal,
          filter: reveal > 0.98 ? undefined : `blur(${((1 - reveal) * 3).toFixed(2)}px)`,
          transform: `translate(-50%, ${3 * (1 - open)}px)`
        }}
      >
        <span key={level} className="aicss-re-swap">
          <span className="aicss-re-current">{modelLabel}</span>
          <span className="aicss-re-next">{level}</span>
        </span>
      </div>
      <div
        ref={trackRef}
        className="aicss-re-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Reasoning effort"
        aria-disabled={disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={active}
        aria-valuetext={level}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="aicss-re-fill" style={{ width: fillW }} />
        <div className="aicss-re-thumb" style={{ left: thumbLeft, width: thumbW, height: REST_H, marginTop: -REST_H / 2 }} />
        {levels.map((entry, index) => {
          const x = centerFor(index);
          const onThumb = x >= thumbLeft + 0.5 && x <= thumbRight - 0.5;
          return (
            <span
              key={entry.id}
              className="aicss-re-tick"
              data-on-thumb={onThumb ? "true" : "false"}
              data-active={index === active && !onThumb ? "true" : "false"}
              style={{ left: x, height: 4.8 + (index / max) * 4.8 }}
            />
          );
        })}
      </div>
    </div>
  );
}

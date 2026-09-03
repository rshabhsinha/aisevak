import { useEffect, useRef } from "react";
import { Blobatar } from "@blobatar/react";
import "blobatar/motion.css";
import "blobatar/gaze.css";

const BLOB_SQUAD = [
  "Atlas", "Sentry", "Zephyr", "Titan", "Solaris", "Nebula", "Ledger",
  "Vector", "Cipher", "Echo", "Beacon", "Apex", "Flux", "Prism",
  "Pulse", "Vortex", "Aura", "Nova", "Helios", "Strata", "Kite",
  "Orbit", "Quark", "Zenith", "Loom", "Forge", "Drift", "Onyx"
];

export function GazeBlobGrid() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    interface BlobTracker {
      eyesEl: SVGGraphicsElement;
      rect: DOMRect;
      currX: number;
      currY: number;
      targetX: number;
      targetY: number;
    }

    const trackers: BlobTracker[] = [];
    const items = containerRef.current.querySelectorAll<HTMLDivElement>(".gaze-blob-item");

    items.forEach((item) => {
      const eyes = item.querySelector<SVGGraphicsElement>(".mo-eyes");
      if (eyes) {
        trackers.push({
          eyesEl: eyes,
          rect: item.getBoundingClientRect(),
          currX: 0,
          currY: 0,
          targetX: 0,
          targetY: 0
        });
      }
    });

    if (!trackers.length) return;

    const updateRects = () => {
      trackers.forEach((tracker, i) => {
        const item = items[i];
        if (item) {
          tracker.rect = item.getBoundingClientRect();
        }
      });
    };

    let rafId: number | null = null;
    let mouseX = -9999;
    let mouseY = -9999;
    let isTracking = false;

    const tick = () => {
      let isMoving = false;

      for (const t of trackers) {
        if (isTracking && mouseX > -9000) {
          const cx = t.rect.left + t.rect.width / 2;
          const cy = t.rect.top + t.rect.height / 2;
          const dx = mouseX - cx;
          const dy = mouseY - cy;
          const dist = Math.hypot(dx, dy);

          if (dist > 1) {
            const angle = Math.atan2(dy, dx);
            // Near-field smoothing so direction doesn't jump when directly above
            const factor = Math.min(1, dist / 32);
            const maxExcursion = 4.8;
            t.targetX = Math.cos(angle) * maxExcursion * factor;
            t.targetY = Math.sin(angle) * maxExcursion * factor;
          } else {
            t.targetX = 0;
            t.targetY = 0;
          }
        } else {
          t.targetX = 0;
          t.targetY = 0;
        }

        // Smooth pursuit lerp
        const diffX = t.targetX - t.currX;
        const diffY = t.targetY - t.currY;

        if (Math.abs(diffX) > 0.02 || Math.abs(diffY) > 0.02) {
          t.currX += diffX * 0.22;
          t.currY += diffY * 0.22;
          isMoving = true;
        } else {
          t.currX = t.targetX;
          t.currY = t.targetY;
        }

        t.eyesEl.style.transform = `translate(${t.currX.toFixed(2)}px, ${t.currY.toFixed(2)}px)`;
        t.eyesEl.style.animation = "none";
      }

      if (isMoving || isTracking) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
      }
    };

    const startLoop = () => {
      if (!rafId) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      isTracking = true;
      startLoop();
    };

    const onPointerLeave = () => {
      isTracking = false;
      startLoop();
    };

    const onResize = () => {
      updateRects();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("scroll", onResize, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });

    // Initial rect pass
    updateRects();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("scroll", onResize);
      window.removeEventListener("resize", onResize);
      trackers.forEach((t) => {
        t.eyesEl.style.transform = "";
        t.eyesEl.style.animation = "";
      });
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative select-none p-1"
      style={
        {
          "--mo-track-travel": "4.5px"
        } as React.CSSProperties
      }
    >
      <div className="grid grid-cols-7 gap-1 sm:gap-1.5 md:gap-2">
        {BLOB_SQUAD.map((name) => (
          <div
            key={name}
            className="gaze-blob-item w-7 h-7 sm:w-8 sm:h-8 md:w-9 md:h-9 flex items-center justify-center transition-transform duration-150 hover:scale-130 z-0 hover:z-10 cursor-pointer"
            title={name}
          >
            <Blobatar
              name={name}
              animate="always"
              className="w-full h-full object-contain block pointer-events-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

import { cloneElement, isValidElement } from "react";
import type { ReactElement } from "react";

export function AnimatedIcon({ icon, active = false }: { icon: ReactElement; active?: boolean }) {
  if (!isValidElement(icon)) return icon;
  return (
    <span className={`animated-icon ${active ? "is-active" : ""}`} aria-hidden="true">
      {cloneElement(icon as ReactElement<{ weight?: string }>, { weight: active ? "fill" : "regular" })}
    </span>
  );
}

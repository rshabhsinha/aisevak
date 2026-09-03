import * as React from "react";
import { OpenAILogo } from "./openai-logo";

export function CursorLogo({ size = 16, className, ...props }: React.SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className} aria-hidden="true" {...props}>
      <path d="M4 4l16 8-16 8 4.5-8L4 4z" />
    </svg>
  );
}

export function OpenCodeLogo({ size = 16, className, ...props }: React.SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" className={className} aria-hidden="true" {...props}>
      <rect x="5" y="5" width="14" height="14" stroke="currentColor" strokeWidth="2" />
      <rect x="8" y="8" width="8" height="8" fill="currentColor" />
    </svg>
  );
}

export function HarnessMark({ driver, size = 14 }: { driver: string; size?: number }) {
  if (driver === "cursor") return <CursorLogo size={size} />;
  if (driver === "opencode") return <OpenCodeLogo size={size} />;
  return <OpenAILogo size={size} />;
}

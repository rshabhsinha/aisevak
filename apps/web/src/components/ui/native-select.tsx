import { CaretDown } from "../icons";
import * as React from "react";
import { cn } from "../../lib/utils";

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => (
    <span className={cn("select-shell", className)}>
      <select ref={ref} {...props}>{children}</select>
      <CaretDown aria-hidden="true" size={13} weight="bold" />
    </span>
  )
);
NativeSelect.displayName = "NativeSelect";

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A status lamp: a dot and its text, so the colour is never the only carrier —
// "Telemetry silent" reads the same in greyscale. The dot is lit in steel when all is well, in
// amber (and the state word with it) when something needs attention, and hollow when there is
// nothing to say. The optional tooltip explains the word on hover; it adds no tab stop, so the
// Play button stays within four Tabs of page load.

import type { ComponentProps } from "react";

import type { LampVariant } from "@/components/status-bar/status-words";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const DOT_CLASS: Readonly<Record<LampVariant, string>> = {
  ok: "bg-primary",
  warn: "bg-accent-signal",
  off: "border border-muted-foreground bg-transparent",
};

export interface LampProps extends Omit<ComponentProps<"span">, "children"> {
  variant: LampVariant;
  /** What the lamp watches: "Link", "Telemetry", "Decisions". */
  label: string;
  /** Its state in one or two words: "open", "silent", "no model". */
  state: string;
  /** One or two sentences on what the state means. */
  tooltip?: string;
}

export function Lamp({ variant, label, state, tooltip, className, ...props }: LampProps) {
  const lamp = (
    <span
      data-lamp={variant}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-meta whitespace-nowrap",
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[variant])} />
      <span>{label}</span>
      <span className={variant === "warn" ? "text-accent-signal" : "text-muted-foreground"}>
        {state}
      </span>
    </span>
  );
  if (tooltip === undefined) {
    return lamp;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{lamp}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

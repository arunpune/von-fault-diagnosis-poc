// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A severity level as a badge: the level's word is always visible and the level's colour tints
// the text and the outline, so colour is never the only carrier.

import type { ComponentProps } from "react";

import type { SeverityLevel } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { severityLabel, severityTone } from "@/lib/severity";
import { cn } from "@/lib/utils";

export interface SeverityBadgeProps extends Omit<
  ComponentProps<typeof Badge>,
  "children" | "variant" | "asChild"
> {
  /** A contract level; an unknown one is shown as its own text in the lowest tone. */
  level: SeverityLevel | (string & {});
}

export function SeverityBadge({ level, className, ...props }: SeverityBadgeProps) {
  const label = severityLabel(level);
  return (
    <Badge
      variant="outline"
      data-severity={level}
      title={`Severity: ${label}`}
      className={cn("rounded-sm bg-card", severityTone(level), className)}
      {...props}
    >
      {label}
    </Badge>
  );
}

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A ticket's status and its technician verdict as badges. The word is always shown, so colour is
// never the only carrier: review is amber (attention that is not an error), open is steel,
// resolved and closed are quiet; a correct verdict takes the primary tone and a wrong one the
// destructive tone. No verdict reads "—".

import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { statusLabel, verdictLabel } from "@/features/tickets/ticket-format";
import { NO_VALUE } from "@/lib/format";
import { cn } from "@/lib/utils";

// Full class names, so Tailwind's scanner sees each one.
const STATUS_TONES: Readonly<Record<string, string>> = {
  review: "border-accent-signal text-accent-signal",
  open: "border-primary text-primary",
  resolved: "text-muted-foreground",
  closed: "text-foreground",
};

const QUIET_TONE = "text-muted-foreground";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const VERDICT_VARIANTS: Readonly<Record<string, BadgeVariant>> = {
  correct: "default",
  wrong: "destructive",
};

export interface TicketStatusBadgeProps {
  /** A contract status; an unknown one is shown as its own text in the quiet tone. */
  status: string;
  className?: string;
}

export function TicketStatusBadge({ status, className }: TicketStatusBadgeProps) {
  const label = statusLabel(status);
  return (
    <Badge
      variant="outline"
      data-status={status}
      title={`Status: ${label}`}
      className={cn("rounded-sm bg-card", STATUS_TONES[status] ?? QUIET_TONE, className)}
    >
      {label}
    </Badge>
  );
}

export interface VerdictBadgeProps {
  /** The closure's verdict, or null while the ticket has none. */
  verdict: string | null;
  className?: string;
}

export function VerdictBadge({ verdict, className }: VerdictBadgeProps) {
  if (verdict === null) {
    return (
      <span className={cn("text-muted-foreground", className)} title="No verdict yet">
        {NO_VALUE}
      </span>
    );
  }
  const label = verdictLabel(verdict);
  return (
    <Badge
      variant={VERDICT_VARIANTS[verdict] ?? "outline"}
      data-verdict={verdict}
      title={`Verdict: ${label}`}
      className={cn("rounded-sm", className)}
    >
      {label}
    </Badge>
  );
}

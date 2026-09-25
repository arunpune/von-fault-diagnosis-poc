// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What a panel shows when there is nothing yet: one sentence that says what to do next —
// "No alerts yet. Press Play, or jump to a known failure." — and, when the next step is a
// control, that control.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** The directive sentence. */
  children: ReactNode;
  /** A control that takes the next step, shown under the sentence. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ children, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-start gap-3 px-4 py-6", className)}>
      <p className="max-w-[72ch] text-sm text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

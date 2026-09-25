// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One section of the decision sheet: a level-three heading under the sheet's title, and a
// region named by it, so a screen reader can list and jump between Confidence, Candidates,
// Severity, Evidence, Ticket and Cost.

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface DecisionSectionProps {
  title: string;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function DecisionSection({
  title,
  children,
  className,
  "data-testid": testId,
}: DecisionSectionProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={cn("space-y-2.5", className)}
    >
      <h3 id={headingId} className="text-sm font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Where a statement comes from in the operator manual, as the sheets cite it:
// "§8.3 Low line pressure, p. 41".

import type { ManualReference } from "@/api/types";
import { fmtManualRef } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ManualRefProps {
  reference: ManualReference;
  className?: string;
}

export function ManualRef({ reference, className }: ManualRefProps) {
  return (
    <cite className={cn("text-[0.8125rem] not-italic text-muted-foreground", className)}>
      {fmtManualRef(reference)}
    </cite>
  );
}

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What a panel shows when its data failed to load: what failed, in the interface's voice
// ("Couldn't load tickets."), the reason when there is one, and a Retry button wired to the
// query's refetch. It is an alert, so a screen reader hears it at once.

import RotateCcwIcon from "lucide-react/dist/esm/icons/rotate-ccw";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  /** What failed: "Couldn't load tickets." */
  message: string;
  /** Why, when known: usually the ApiError's message. */
  detail?: string;
  /** Retries the failed load; no button without it. */
  onRetry?: () => void;
  className?: string;
}

const RETRY_ICON = <RotateCcwIcon aria-hidden="true" />;

export function ErrorState({ message, detail, onRetry, className }: ErrorStateProps) {
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-2 px-4 py-4", className)}>
      <p className="text-sm font-medium text-destructive">{message}</p>
      {detail === undefined ? null : (
        <p className="max-w-[72ch] text-[0.8125rem] text-muted-foreground">{detail}</p>
      )}
      {onRetry === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {RETRY_ICON}
          Retry
        </Button>
      )}
    </div>
  );
}

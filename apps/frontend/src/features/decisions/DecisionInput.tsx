// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The state the decision backend was given, as the backend stored it: closed until asked for, then
// pretty-printed. It holds words and buckets only — the backend never sees a raw time series — and
// no key or header ever reaches it: secrets stay in the environment. The sheet renders this section
// only when `GET /api/decisions/:id` returned a state.

import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { tid } from "@/lib/testids";

const CHEVRON = (
  <ChevronRightIcon
    aria-hidden="true"
    className="transition-transform group-data-[state=open]/trigger:rotate-90"
  />
);

export interface DecisionInputProps {
  state: unknown;
}

export function DecisionInput({ state }: DecisionInputProps) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const json = useMemo(() => (open ? JSON.stringify(state, null, 2) : ""), [open, state]);
  return (
    <section aria-labelledby={headingId} data-testid={tid.decision.input}>
      <Collapsible open={open} onOpenChange={setOpen} className="space-y-2.5">
        <h3 id={headingId} className="text-sm font-medium">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group/trigger -ml-2 px-2 text-sm font-medium"
            >
              {CHEVRON}
              Decision input
            </Button>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="space-y-2">
          <p className="text-meta text-muted-foreground">This is what the decision model saw.</p>
          <pre className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {json}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

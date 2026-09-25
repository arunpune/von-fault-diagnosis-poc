// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The injections running right now, from the live store: one badge per instance,
// "Oil cooler fouling since 2020-06-05 08:00:00", its label resolved through the catalog. The
// swatch is the colour of the recorder's injected-fault band, so a badge and its band read as
// one thing. "Clear injections" stops them all and rests while none runs.

import { useId, useMemo } from "react";

import type { InjectionDef, RunningInstance } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSimAction } from "@/features/simulation/use-sim-action";
import { tid } from "@/lib/testids";
import { fmtSim } from "@/lib/time";
import { useActiveInjections } from "@/store/live-store";

export interface ActiveInjectionsProps {
  /** The catalog's injections, for the labels; undefined while the catalog loads. */
  injections: readonly InjectionDef[] | undefined;
}

export function ActiveInjections({ injections }: ActiveInjectionsProps) {
  const titleId = useId();
  const active = useActiveInjections();
  const labels = useMemo(
    () => new Map((injections ?? []).map((entry) => [entry.injection_id, entry.label])),
    [injections],
  );
  const { run, pending } = useSimAction();

  function clear(): void {
    run({ cmd: "clear", args: {} }, { success: "Injections cleared" });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span id={titleId} className="text-sm text-muted-foreground">
          Injected faults
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="ml-auto"
          disabled={pending || active.length === 0}
          onClick={clear}
          data-testid={tid.sim.clear}
        >
          Clear injections
        </Button>
      </div>
      <div data-testid={tid.sim.active}>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">None running.</p>
        ) : (
          <ul aria-labelledby={titleId} className="flex flex-wrap gap-1.5">
            {active.map((instance) => (
              <li key={instance.instance_id}>
                <InjectionBadge
                  instance={instance}
                  label={labels.get(instance.injection_id) ?? instance.injection_id}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface InjectionBadgeProps {
  instance: RunningInstance;
  label: string;
}

function InjectionBadge({ instance, label }: InjectionBadgeProps) {
  return (
    <Badge
      variant="outline"
      className="h-auto rounded-sm text-left whitespace-normal"
      title={`Runs until ${fmtSim(instance.ends_sim_ts)}`}
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-[2px] bg-overlay-injection-line"
      />
      <span>
        {label}{" "}
        <span className="text-muted-foreground tabular-nums">
          since {fmtSim(instance.started_sim_ts)}
        </span>
      </span>
    </Badge>
  );
}

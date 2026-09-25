// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// "Inject fault": the catalog's injections, each its label over the fault id it stands for,
// tagged "benign" when the cause is harmless. An injection that is running is shown checked and
// cannot be chosen again. Every catalog entry declares at least one tunable parameter, so
// choosing one opens the parameter dialog; its "Inject" button sends
// `POST /api/sim/inject { args: { injection_id, params: { magnitude, duration_sim_min } } }` and
// the toast repeats the label.

import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import { useId, useMemo, useState } from "react";

import type { InjectArgs, InjectionDef } from "@/api/types";
import { Code } from "@/components/common/Code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InjectDialog } from "@/features/simulation/InjectDialog";
import { useSimAction } from "@/features/simulation/use-sim-action";
import { tid } from "@/lib/testids";
import { useActiveInjections } from "@/store/live-store";

const CHEVRON_ICON = <ChevronDownIcon aria-hidden="true" className="ml-auto" />;

export interface InjectMenuProps {
  injections: readonly InjectionDef[];
}

export function InjectMenu({ injections }: InjectMenuProps) {
  const active = useActiveInjections();
  const running = useMemo(() => new Set(active.map((instance) => instance.injection_id)), [active]);
  /** The entry the dialog shows; kept after closing so the dialog can animate out. */
  const [chosen, setChosen] = useState<InjectionDef | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { run, pending } = useSimAction();

  function choose(entry: InjectionDef): void {
    setChosen(entry);
    setDialogOpen(true);
  }

  function inject(entry: InjectionDef, args: InjectArgs): void {
    setDialogOpen(false);
    run({ cmd: "inject", args }, { success: `Injected ${entry.label}` });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={pending || injections.length === 0}
            data-testid={tid.sim.inject}
          >
            Inject fault
            {CHEVRON_ICON}
          </Button>
        </DropdownMenuTrigger>
        {/* The trigger sits at the rail's right edge, so the list opens towards the recorder. */}
        <DropdownMenuContent align="end" className="w-auto min-w-64">
          {injections.map((entry) => (
            <InjectItem
              key={entry.injection_id}
              entry={entry}
              running={running.has(entry.injection_id)}
              onChoose={choose}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <InjectDialog
        entry={chosen}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onInject={inject}
      />
    </>
  );
}

interface InjectItemProps {
  entry: InjectionDef;
  running: boolean;
  onChoose: (entry: InjectionDef) => void;
}

function InjectItem({ entry, running, onChoose }: InjectItemProps) {
  const labelId = useId();
  const detailId = useId();
  return (
    <DropdownMenuCheckboxItem
      className="items-start"
      checked={running}
      disabled={running}
      aria-labelledby={labelId}
      aria-describedby={detailId}
      data-testid={tid.sim.injectItem(entry.injection_id)}
      data-injection-id={entry.injection_id}
      onSelect={() => onChoose(entry)}
    >
      <span className="flex flex-col">
        <span id={labelId}>{entry.label}</span>
        <span id={detailId} className="flex items-center gap-1.5 text-muted-foreground">
          <Code value={entry.fault_id} className="text-xs" />
          {entry.benign ? (
            <Badge variant="outline" className="rounded-sm">
              benign
            </Badge>
          ) : null}
          {running ? <span className="text-xs">running</span> : null}
        </span>
      </span>
    </DropdownMenuCheckboxItem>
  );
}

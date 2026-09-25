// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// "Jump to": the catalog's presets in two sections, each item its label verbatim
// ("Air leak – 5 Jun 2020") over the sim time it shows. Choosing one sends
// `POST /api/sim/jump { args: { preset_id } }`; the replay lands a lead-in before that instant,
// and the toast repeats the label. The label is each item's accessible name and the time its
// description, so the tour finds an item by role and name as well as by test id.

import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import { useId, useMemo } from "react";

import type { PresetDef } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { groupPresets, type PresetGroup } from "@/features/simulation/presets";
import { useSimAction } from "@/features/simulation/use-sim-action";
import { tid } from "@/lib/testids";
import { fmtSim } from "@/lib/time";

const CHEVRON_ICON = <ChevronDownIcon aria-hidden="true" className="ml-auto" />;

export interface JumpMenuProps {
  presets: readonly PresetDef[];
}

export function JumpMenu({ presets }: JumpMenuProps) {
  const groups = useMemo(() => groupPresets(presets), [presets]);
  const { run, pending } = useSimAction();

  function jump(preset: PresetDef): void {
    run(
      { cmd: "jump", args: { preset_id: preset.preset_id } },
      { success: `Jumped to ${preset.label}` },
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" disabled={pending} data-testid={tid.sim.jump}>
          Jump to
          {CHEVRON_ICON}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto min-w-64">
        {groups.map((group, index) => (
          <PresetSection key={group.title} group={group} separated={index > 0} onJump={jump} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface PresetSectionProps {
  group: PresetGroup;
  /** A rule above every section but the first. */
  separated: boolean;
  onJump: (preset: PresetDef) => void;
}

function PresetSection({ group, separated, onJump }: PresetSectionProps) {
  const titleId = useId();
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuGroup aria-labelledby={titleId}>
        <DropdownMenuLabel id={titleId}>{group.title}</DropdownMenuLabel>
        {group.presets.map((preset) => (
          <PresetItem key={preset.preset_id} preset={preset} onJump={onJump} />
        ))}
      </DropdownMenuGroup>
    </>
  );
}

interface PresetItemProps {
  preset: PresetDef;
  onJump: (preset: PresetDef) => void;
}

function PresetItem({ preset, onJump }: PresetItemProps) {
  const labelId = useId();
  const timeId = useId();
  return (
    <DropdownMenuItem
      className="flex-col items-start gap-0"
      aria-labelledby={labelId}
      aria-describedby={timeId}
      data-testid={tid.sim.jumpItem(preset.preset_id)}
      data-preset-id={preset.preset_id}
      onSelect={() => onJump(preset)}
    >
      <span id={labelId}>{preset.label}</span>
      <span id={timeId} className="text-xs text-muted-foreground tabular-nums">
        {fmtSim(preset.sim_ts)}
      </span>
    </DropdownMenuItem>
  );
}

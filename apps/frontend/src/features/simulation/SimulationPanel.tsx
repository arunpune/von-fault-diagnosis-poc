// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The simulation controls at the top of the right rail. App.tsx imports this default export from
// this fixed path. Every control sends one command to the simulator through the backend and reads
// the result back from the live store, so the panel never shows a state the simulator has not
// acknowledged, and it never blocks: a failed command is a toast and every control stays usable.
// The presets and the injections come from the overlay catalog; until it loads, the two menus are
// placeholders, and a failed load offers a retry. Top to bottom: the replay (play, speed), where
// to go (jump, inject), what is injected, and the reset last, so the play button stays among the
// first stops of the tab order.

import { useOverlayCatalog } from "@/api/queries";
import type { OverlayCatalog } from "@/api/types";
import { Panel } from "@/components/app-shell/Panel";
import { ErrorState } from "@/components/common/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { ActiveInjections } from "@/features/simulation/ActiveInjections";
import { InjectMenu } from "@/features/simulation/InjectMenu";
import { JumpMenu } from "@/features/simulation/JumpMenu";
import { PlayPause } from "@/features/simulation/PlayPause";
import { ResetReplay } from "@/features/simulation/ResetReplay";
import { SpeedControl } from "@/features/simulation/SpeedControl";

const MENUS_LOADING = (
  <div role="status" className="grid grid-cols-2 gap-2">
    <span className="sr-only">Loading the presets and faults</span>
    <Skeleton className="h-8" />
    <Skeleton className="h-8" />
  </div>
);

export default function SimulationPanel() {
  const catalog = useOverlayCatalog();

  return (
    <Panel title="Simulation">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-center gap-3">
          <PlayPause />
          <SpeedControl />
        </div>
        <CatalogMenus
          catalog={catalog.data}
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
        <ActiveInjections injections={catalog.data?.injections} />
        <ResetReplay />
      </div>
    </Panel>
  );
}

interface CatalogMenusProps {
  catalog: OverlayCatalog | undefined;
  error: Error | null;
  onRetry: () => void;
}

/** "Jump to" and "Inject fault" once the catalog is here; a placeholder or the error before. */
function CatalogMenus({ catalog, error, onRetry }: CatalogMenusProps) {
  if (catalog !== undefined) {
    return (
      <div className="grid grid-cols-2 gap-2">
        <JumpMenu presets={catalog.presets.presets} />
        <InjectMenu injections={catalog.injections} />
      </div>
    );
  }
  if (error !== null) {
    return (
      <ErrorState
        className="px-0 py-0"
        message="Couldn't load the presets and faults."
        detail={error.message}
        onRetry={onRetry}
      />
    );
  }
  return MENUS_LOADING;
}

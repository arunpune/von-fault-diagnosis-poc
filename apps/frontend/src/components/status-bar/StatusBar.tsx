// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The status bar, left to right: the unit, the sim clock, the replay state and speed, the dataset
// position, the link / telemetry / decisions lamps (with the gateway's dropped samples), the
// decision backend and the theme toggle; the reconnecting banner hangs under it. The bar itself
// reads nothing from the live store: each part subscribes to what it shows, so a simulator status
// re-renders the clock, the state and the position only.
//
// Narrow screens drop what the page repeats elsewhere: the unit is named in full from 1280 px and
// by its id from 1024 px (the page title names it too), and the dataset bar and the speed go
// below 1024 px (the simulation panel shows the speed). The only tab stop is the theme toggle, so
// the recorder and the Play button stay within four Tabs of page load.

import { LiveBackendChip } from "@/components/status-bar/BackendChip";
import { DatasetProgress } from "@/components/status-bar/DatasetProgress";
import { ReconnectingBanner } from "@/components/status-bar/ReconnectingBanner";
import { ReplayState } from "@/components/status-bar/ReplayState";
import { SimClock } from "@/components/status-bar/SimClock";
import {
  DecisionsLamp,
  GatewayDropped,
  LinkLamp,
  TelemetryLamp,
} from "@/components/status-bar/StatusLamps";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { tid } from "@/lib/testids";

export default function StatusBar() {
  return (
    <div className="relative h-full">
      <div className="flex h-full min-w-0 items-center gap-3 overflow-hidden px-4 lg:gap-4">
        <span className="hidden shrink-0 text-base font-medium whitespace-nowrap xl:inline">
          CAU-7 compressed-air unit
        </span>
        <span className="hidden shrink-0 text-base font-medium lg:inline xl:hidden">CAU-7</span>
        <SimClock />
        <ReplayState />
        <DatasetProgress />
        <div role="group" aria-label="Health" className="flex shrink-0 items-center gap-3">
          <LinkLamp />
          <TelemetryLamp />
          <GatewayDropped />
          <DecisionsLamp />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LiveBackendChip />
          <ThemeToggle data-testid={tid.status.theme} />
        </div>
      </div>
      <ReconnectingBanner />
    </div>
  );
}

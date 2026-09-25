// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The replay state and speed: an icon, the word the simulator reports (stopped / playing /
// paused) and the speed as "600×". It subscribes to the two values only, so the once-a-second
// status that just moves the clock does not re-render it.

import PauseIcon from "lucide-react/dist/esm/icons/pause";
import PlayIcon from "lucide-react/dist/esm/icons/play";
import SquareIcon from "lucide-react/dist/esm/icons/square";
import type { ReactElement } from "react";

import type { SimulatorState } from "@/api/types";
import { selectSimSpeed, selectSimState } from "@/components/status-bar/status-words";
import { fmtSpeed } from "@/lib/format";
import { tid } from "@/lib/testids";
import { useLiveValue } from "@/store/live-store";

const ICON_CLASS = "size-3.5 shrink-0";

function stateIcon(state: SimulatorState): ReactElement | null {
  switch (state) {
    case "playing":
      return <PlayIcon aria-hidden="true" className={ICON_CLASS} />;
    case "paused":
      return <PauseIcon aria-hidden="true" className={ICON_CLASS} />;
    case "stopped":
      return <SquareIcon aria-hidden="true" className={ICON_CLASS} />;
    default:
      // A state a newer simulator may add: the word alone.
      return null;
  }
}

export function ReplayState() {
  const state = useLiveValue(selectSimState);
  const speed = useLiveValue(selectSimSpeed);
  return (
    <span
      data-testid={tid.status.state}
      data-state={state ?? "unknown"}
      className="inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap"
    >
      {state === null ? (
        <span className="text-muted-foreground">no replay yet</span>
      ) : (
        <>
          {stateIcon(state)}
          <span>{state}</span>
        </>
      )}
      {speed === null ? null : (
        <span className="hidden text-muted-foreground tabular-nums lg:inline">
          {fmtSpeed(speed)}
        </span>
      )}
    </span>
  );
}

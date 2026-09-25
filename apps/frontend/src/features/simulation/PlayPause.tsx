// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The one primary button of the page. It reads "Pause" while the replay plays and "Play"
// otherwise, and the acknowledgement's status flips it the moment the simulator applied the
// command. It rests while its request is in flight and while the live link is down. A disabled
// button takes neither pointer nor focus, so while the link is down the reason sits on a
// focusable wrapper that carries the tooltip.

import PauseIcon from "lucide-react/dist/esm/icons/pause";
import PlayIcon from "lucide-react/dist/esm/icons/play";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSimAction } from "@/features/simulation/use-sim-action";
import { tid } from "@/lib/testids";
import { useLinkState, useSimStatus } from "@/store/live-store";

const PLAY_ICON = <PlayIcon aria-hidden="true" />;
const PAUSE_ICON = <PauseIcon aria-hidden="true" />;

export function PlayPause() {
  const playing = useSimStatus()?.state === "playing";
  const linkDown = useLinkState() !== "open";
  const { run, pending } = useSimAction();

  function toggle(): void {
    run({ cmd: playing ? "pause" : "play", args: {} });
  }

  const button = (
    <Button
      type="button"
      className="w-24"
      disabled={pending || linkDown}
      aria-busy={pending}
      onClick={toggle}
      data-testid={tid.sim.play}
    >
      {playing ? PAUSE_ICON : PLAY_ICON}
      {playing ? "Pause" : "Play"}
    </Button>
  );

  if (!linkDown) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          tabIndex={0}
        >
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>Waiting for the backend</TooltipContent>
    </Tooltip>
  );
}

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The replay speed: a slider over the speed steps with the value beside it ("600×"). Dragging
// only moves a draft; the command goes out when the drag ends or a key moves the thumb
// (`onValueCommit`), so a drag across the scale is one command, not twelve. The committed draft
// is held until its command settles, so the thumb does not snap back to the old speed while the
// acknowledgement is on its way; after that the slider shows the simulator's speed again, whoever
// changed it.

import { useId, useState } from "react";

import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_SPEED,
  nearestSpeedIndex,
  speedAt,
  SPEED_STEPS,
} from "@/features/simulation/speed";
import { useSimAction } from "@/features/simulation/use-sim-action";
import { fmtSpeed, NO_VALUE } from "@/lib/format";
import { tid } from "@/lib/testids";
import { useSimStatus } from "@/store/live-store";

const LAST_STEP = SPEED_STEPS.length - 1;

export function SpeedControl() {
  const labelId = useId();
  const speed = useSimStatus()?.speed ?? null;
  /** The position being dragged, or committed and waiting for its acknowledgement. */
  const [draft, setDraft] = useState<number | null>(null);
  const { run } = useSimAction();

  const position = draft ?? nearestSpeedIndex(speed ?? DEFAULT_SPEED);
  const shown = draft === null ? speed : speedAt(draft);
  const valueText = shown === null ? NO_VALUE : fmtSpeed(shown);

  function change([index]: number[]): void {
    setDraft(index ?? null);
  }

  // A drag that ends where it started commits nothing, so letting go drops the draft; when the
  // drag did move, the commit that follows in the same event takes it back.
  function release(): void {
    setDraft(null);
  }

  // A key press commits before it reports the change, a drag reports first: either way the
  // committed position is the draft until its command settles.
  function commit([index]: number[]): void {
    if (index === undefined) {
      return;
    }
    setDraft(index);
    run(
      { cmd: "speed", args: { speed: speedAt(index) } },
      // A later drag or commit owns the draft now; only this command's own position is let go.
      { onSettled: () => setDraft((current) => (current === index ? null : current)) },
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-testid={tid.sim.speed}>
      <span id={labelId} className="text-sm text-muted-foreground">
        Speed
      </span>
      <Slider
        className="min-w-0 flex-1"
        min={0}
        max={LAST_STEP}
        step={1}
        value={[position]}
        disabled={speed === null}
        onValueChange={change}
        onValueCommit={commit}
        onPointerUp={release}
        onPointerCancel={release}
        thumbProps={{ "aria-labelledby": labelId, "aria-valuetext": valueText }}
      />
      {/* The thumb's value text says the same to assistive technology. */}
      <span aria-hidden="true" className="w-14 text-right text-sm tabular-nums">
        {valueText}
      </span>
    </div>
  );
}

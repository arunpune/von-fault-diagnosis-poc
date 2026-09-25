// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The sim clock: the data's own time, always UTC, in tabular figures so the digits do not
// jitter. It follows the recorder's latest point once the recorder publishes one and the
// simulator status before, so the clock and the chart agree.

import { NO_VALUE } from "@/lib/format";
import { tid } from "@/lib/testids";
import { fmtSim, toIsoMs } from "@/lib/time";
import { useSimNow } from "@/store/live-store";

export function SimClock() {
  const now = useSimNow();
  return (
    <span
      data-testid={tid.status.clock}
      title="Sim time: the recording's own clock"
      className="shrink-0 text-base font-semibold whitespace-nowrap tabular-nums lg:text-xl"
    >
      {now === null ? NO_VALUE : <time dateTime={toIsoMs(now)}>{fmtSim(now)}</time>}{" "}
      <span className="text-xs font-normal text-muted-foreground">UTC</span>
    </span>
  );
}

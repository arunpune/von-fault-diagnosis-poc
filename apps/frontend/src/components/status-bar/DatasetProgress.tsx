// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Where the replay stands in the dataset: a thin bar from the sim clock's place between the
// dataset's first and last row, with the dataset's extent in a tooltip and in the bar's accessible
// value. It re-renders in 0.1 % steps, not on every status. The shadcn Progress draws `value` but
// does not hand it to the Radix root, so the value is set here too.

import { selectDatasetPermille, selectDatasetRange } from "@/components/status-bar/status-words";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtNumber } from "@/lib/format";
import { useLiveValue } from "@/store/live-store";

const LABEL = "Dataset position";

export function DatasetProgress() {
  const permille = useLiveValue(selectDatasetPermille);
  const range = useLiveValue(selectDatasetRange);
  const percent = permille === null ? null : permille / 10;
  const valueText =
    percent === null
      ? "Not known yet"
      : `${fmtNumber(percent, 1)} % through ${range ?? "the dataset"}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="hidden w-20 shrink-0 lg:block">
          <Progress
            value={percent}
            aria-label={LABEL}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={valueText}
            className="h-1.5"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {range === null ? "Waiting for the simulator" : `Dataset ${range}`}
      </TooltipContent>
    </Tooltip>
  );
}

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// How serious the decision judged the situation: the level's badge, the score on the 0–3 scale as
// a four-segment meter in the level's colour, the confidence of the severity answer, and how the
// backend spread its probability over the four levels. The level is always written out; the meter
// repeats it for the eye.

import type { CSSProperties } from "react";

import type { Decision } from "@/api/types";
import { SeverityBadge } from "@/components/common/SeverityBadge";
import { fmtPct, fmtValue } from "@/lib/format";
import { SEVERITY_LEVELS, severityColor, severityLabel } from "@/lib/severity";
import { tid } from "@/lib/testids";
import { cn } from "@/lib/utils";

/** The highest score, `critical`; the meter has one segment per level from 0. */
const MAX_SCORE = SEVERITY_LEVELS.length - 1;

interface LevelShare {
  label: string;
  probability: number;
}

/** The severity probabilities, keyed by level index, in level order with the level's word. */
function levelShares(probabilities: Readonly<Record<string, number>>): LevelShare[] {
  return Object.entries(probabilities)
    .map(([key, probability]) => ({ key, probability, index: Number(key) }))
    .sort((a, b) => a.index - b.index || a.key.localeCompare(b.key))
    .map(({ key, index, probability }) => {
      const level = SEVERITY_LEVELS[index];
      return { label: level === undefined ? key : severityLabel(level), probability };
    });
}

export interface SeverityDetailProps {
  severity: Decision["severity"];
}

export function SeverityDetail({ severity }: SeverityDetailProps) {
  const filled = Math.round(severity.score);
  const fill: CSSProperties = { backgroundColor: severityColor(severity.level) };
  const score = fmtValue(severity.score);
  const shares = levelShares(severity.probabilities);
  return (
    <div data-testid={tid.decision.severity} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <SeverityBadge level={severity.level} />
        <span
          role="img"
          aria-label={`Severity score ${score} of ${MAX_SCORE}`}
          className="flex gap-0.5"
        >
          {SEVERITY_LEVELS.map((level, index) => (
            <span
              key={level}
              className={cn("h-2 w-7 rounded-xs", index <= filled ? undefined : "bg-muted")}
              style={index <= filled ? fill : undefined}
            />
          ))}
        </span>
        <span aria-hidden="true" className="text-meta text-muted-foreground tabular-nums">
          Score {score} of {MAX_SCORE}
        </span>
        <span className="text-meta tabular-nums">Confidence {fmtPct(severity.confidence)}</span>
      </div>
      {shares.length === 0 ? null : (
        <ul
          aria-label="Probability of each severity level"
          className="flex flex-wrap gap-x-4 text-meta text-muted-foreground tabular-nums"
        >
          {shares.map((share) => (
            <li key={share.label}>
              {share.label} {fmtPct(share.probability)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the decision cost: the tokens the backend reported, the dollars they came to, the prices
// used with the day they were read, and how long the call took. The rules backend calls no
// model, so it has no prices to show.

import type { Decision } from "@/api/types";
import { priceLine } from "@/features/decisions/decision-text";
import { fmtNumber, fmtTokens, fmtUsd } from "@/lib/format";

const MS_PER_SECOND = 1_000;

export interface DecisionCostProps {
  decision: Decision;
}

export function DecisionCost({ decision }: DecisionCostProps) {
  const { usage, cost } = decision;
  const modelCall = decision.backend !== "rules";
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-meta">
      <dt className="text-muted-foreground">Tokens</dt>
      <dd className="tabular-nums">
        {fmtTokens(usage.input_tokens)} in, {fmtTokens(usage.output_tokens)} out
      </dd>
      <dt className="text-muted-foreground">Cost</dt>
      <dd className="tabular-nums">{fmtUsd(cost.usd)}</dd>
      <dt className="text-muted-foreground">Prices</dt>
      <dd>{modelCall ? priceLine(cost) : "Rules backend: no model call, no cost."}</dd>
      <dt className="text-muted-foreground">Latency</dt>
      <dd className="tabular-nums">{fmtNumber(decision.latency_ms / MS_PER_SECOND, 2)} s</dd>
    </dl>
  );
}

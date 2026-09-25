// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { type Telemetry } from "@fdp/contracts";

export const GROUND_TRUTH_LABEL = "ground-truth";

export function labelOf(sample: Telemetry): string {
  return `${GROUND_TRUTH_LABEL}:${sample.unitId}`;
}

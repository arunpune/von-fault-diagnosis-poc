// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { type Telemetry } from "@fdp/contracts";

export function unitOf(sample: Telemetry): string {
  return sample.unitId;
}

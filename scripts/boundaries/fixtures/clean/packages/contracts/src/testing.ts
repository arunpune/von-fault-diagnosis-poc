// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { type Telemetry } from "./index.ts";

export function telemetrySample(): Telemetry {
  return { unitId: "cau-7", tsMs: 0 };
}

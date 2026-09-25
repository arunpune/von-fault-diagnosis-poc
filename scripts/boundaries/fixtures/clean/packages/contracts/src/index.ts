// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

export const CONTRACT_VERSION = "v1";

export interface Telemetry {
  readonly unitId: string;
  readonly tsMs: number;
}

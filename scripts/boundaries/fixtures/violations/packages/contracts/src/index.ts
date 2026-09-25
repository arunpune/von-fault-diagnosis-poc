// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Breaks `contracts-pure`: the contract package imports nothing from the workspace.
import { MIGRATION_TABLE } from "@fdp/db-migrate";

export const CONTRACT_VERSION = `v1+${MIGRATION_TABLE}`;

export interface Telemetry {
  readonly unitId: string;
  readonly tsMs: number;
}

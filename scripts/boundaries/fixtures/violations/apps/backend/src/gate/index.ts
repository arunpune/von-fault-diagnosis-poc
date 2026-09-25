// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Breaks `no-test-in-prod`: production code never imports a test module.
import { GATE_FIXTURE } from "./gate.test.ts";

export const GATE_NAME = `gate(${GATE_FIXTURE})`;

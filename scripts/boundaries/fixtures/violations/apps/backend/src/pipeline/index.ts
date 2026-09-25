// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Allowed on its own; it is the second hop of `no-gt-reachable-from-diagnosis`
// (pipeline -> detection -> @fdp/ground-truth).
import { DETECTION_NAME } from "../detection/index.ts";

export const PIPELINE_ENTRY = `pipeline -> ${DETECTION_NAME}`;

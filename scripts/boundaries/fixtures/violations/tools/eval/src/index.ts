// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Breaks `eval-only-pipeline-entry` (@fdp/backend exports ./pipeline and nothing else) and,
// because the exports map makes the deep path unreachable, `not-to-unresolvable`.
import { DETECTION_NAME } from "@fdp/backend/src/detection/index.ts";

console.log(`eval: ${DETECTION_NAME}`);

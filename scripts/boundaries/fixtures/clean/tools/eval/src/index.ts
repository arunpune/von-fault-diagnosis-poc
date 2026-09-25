// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { PIPELINE_ENTRY } from "@fdp/backend/pipeline";
import { GROUND_TRUTH_LABEL } from "@fdp/ground-truth";

console.log(`eval: ${PIPELINE_ENTRY} + ${GROUND_TRUTH_LABEL}`);

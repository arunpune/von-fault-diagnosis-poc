// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Breaks `no-gt-in-frontend` and, because the frontend package.json does not declare it,
// `not-to-unresolvable`.
import { GROUND_TRUTH_LABEL } from "@fdp/ground-truth";
// Breaks `frontend-contracts-types-only`: a value import, not `import type`.
import { CONTRACT_VERSION } from "@fdp/contracts";

export const BANNER = `${CONTRACT_VERSION} ${GROUND_TRUTH_LABEL}`;

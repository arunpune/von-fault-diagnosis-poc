// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Breaks `no-gt-in-backend`: the package.json of this fixture declares @fdp/ground-truth on
// purpose, so the import resolves and the transitive rule below has a real path to report.
import { GROUND_TRUTH_LABEL } from "@fdp/ground-truth";
// Breaks `no-overlay-in-diagnosis`.
import { OVERLAY_RECORDER } from "../overlay/recorder.ts";

export const DETECTION_NAME = `detection(${GROUND_TRUTH_LABEL},${OVERLAY_RECORDER})`;

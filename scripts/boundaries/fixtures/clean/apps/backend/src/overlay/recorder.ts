// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The overlay may read anything backend-internal; only the opposite direction is forbidden.
import { DETECTION_NAME } from "../detection/index.ts";

export const OVERLAY_RECORDER = `overlay records ${DETECTION_NAME}`;

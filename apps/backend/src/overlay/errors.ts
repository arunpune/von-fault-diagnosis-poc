// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `api-error` body of the overlay's routes.
 *
 * `api/index.ts` builds the same shape for the rest of the surface, and it
 * registers these two plugins; the overlay builds its own so that the
 * registration stays one-directional — a route file that imported the plugin
 * tree it is registered into would be a cycle, and the import boundary rules
 * are easier to trust without one.
 */

import type { ApiError } from "@fdp/contracts";

/** `{ error: { code, message, details? } }`, the one body the interface parses. */
export function overlayError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

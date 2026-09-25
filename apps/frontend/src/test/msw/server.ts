// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The msw server every test file shares. `src/test/setup.ts` starts it before the first test,
// resets per-test overrides after each and closes it at the end; a request no handler answers
// fails the test, so a view cannot reach a route the mock does not know. Override one route in
// a test with `server.use(http.get(…))`.

import { setupServer } from "msw/node";

import { handlers } from "@/test/msw/handlers";

export const server = setupServer(...handlers);

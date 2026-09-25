// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// @fdp/contracts is the first real consumer of the shared Vitest configuration and of the
// `@fdp/source` resolution condition it sets.
//
// The extra `include` adds the tests of the mock servers, which live beside their implementation in
// `mock/` rather than under `test/`. `fdpVitest` concatenates arrays, so the shared
// `src/**/*.test.ts` and `test/**/*.test.ts` patterns stay in force.

import { fdpVitest } from "../../vitest.base.ts";

export default fdpVitest({ test: { include: ["mock/**/*.test.ts"] } });

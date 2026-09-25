// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Unit and architecture tests of @fdp/backend (docs/development.md#the-tests).
//
// `fdpVitest()` brings the `@fdp/source` resolution condition, the
// `src/**/*.test.ts` and `test/**/*.test.ts` patterns and the exclusion of
// `**/integration/**`, so this suite stays offline and needs no Docker.
//
// The global setup pins the process time zone and turns a missing dataset into
// a skip or, under FDP_REQUIRE_DATASET, into a failure.
//
// `test/live/*.live.test.ts` also match `test/**/*.test.ts`; they are excluded
// here so a key exported in the shell can never turn `make test` into a live
// call. They run through `test:live` only.

import { fdpVitest } from "../../vitest.base.ts";

export default fdpVitest({
  test: { globalSetup: ["./test/global-setup.ts"], exclude: ["test/live/**"] },
});

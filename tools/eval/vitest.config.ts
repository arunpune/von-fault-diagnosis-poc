// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The offline suite of @fdp/eval: everything that needs neither Docker, nor a
// key, nor the MetroPT-3 download. The Docker-backed and live suites have
// their own config, `vitest.integration.config.ts`, and so do the smoke E2E
// (`test/e2e/**`) and the cassette round trip (`test/backends/**`): they
// replay the cut slices, and under FDP_REQUIRE_DATASET=1 they fail without
// them instead of skipping. The live smoke tests (`test/live/**`) run only
// through `test:live`.

import { fdpVitest } from "../../vitest.base.ts";

export default fdpVitest({
  test: { exclude: ["test/e2e/**", "test/backends/**", "test/live/**"] },
});

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The unit tests of @fdp/db-migrate: no Docker, no database.
// The Docker-backed suites live under test/integration/ and run through
// `pnpm run test:integration` with vitest.integration.config.ts.

import { fdpVitest } from "../../vitest.base.ts";

export default fdpVitest();

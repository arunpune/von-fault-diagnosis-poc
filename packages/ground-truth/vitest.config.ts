// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// @fdp/ground-truth is the first package that depends on @fdp/contracts, so its suite carries the
// standing regression for the `@fdp/source` resolution condition as well:
// `test/resolution.test.ts`.

import { fdpVitest } from "../../vitest.base.ts";

export default fdpVitest();

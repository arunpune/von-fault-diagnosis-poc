// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Ground-truth isolation, manifest layer (docs/architecture.md#ground-truth-isolation): the backend
// and the user interface never declare a dependency on this package, so pnpm's strict
// `node_modules` makes an import of it unresolvable in the first place. The module-graph layer is
// `.dependency-cruiser.cjs` and the source-text layer is `fdp-checks gt-paths`.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const MANIFESTS = ["apps/backend/package.json", "apps/frontend/package.json"];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

describe.each(MANIFESTS)("%s", (relative) => {
  const file = join(REPO_ROOT, relative);

  // In a checkout without the manifest the test reports itself as skipped rather than passing on
  // a file that is not there.
  it.runIf(existsSync(file))("does not depend on @fdp/ground-truth", () => {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const field of DEPENDENCY_FIELDS) {
      const declared = manifest[field];
      if (declared === undefined) continue;
      expect(Object.keys(declared as Record<string, string>)).not.toContain("@fdp/ground-truth");
    }
  });
});

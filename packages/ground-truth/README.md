<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# `@fdp/ground-truth`

What actually happened in the machine data: the corrected MetroPT-3 failure table, the replay
presets of the simulator's jump menu, and the injection catalog the simulator applies. How the
rest of the stack is kept away from it is in
[`docs/architecture.md`](../../docs/architecture.md#ground-truth-isolation).

## The isolation rule

[Ground rule 3](../../CONTRIBUTING.md#ground-rules): **diagnosis code may not import or read this
package.** The system under test has
to reach its answer from telemetry and the manual alone; anything that can see the label would
make the evaluation meaningless.

| May use it | How |
| --- | --- |
| `tools/eval` | Imports it in process; the only TypeScript consumer. |
| the `modbus-sim` image | Its Dockerfile copies `data/*.json` to `/gt` and the simulator reads them with the Go structs of `internal/contracts`. |
| the overlay of the user interface | Never from here: it subscribes to `gt/cau-7/#` on the broker, which the diagnosis credential cannot read. |
| `apps/backend`, `apps/frontend` | Never, in any form. |

Four guards keep that true, and only the first is ours: `test/no-consumers.test.ts` reads both
application manifests and fails if either declares this package; dependency-cruiser and ESLint
forbid the import path, including transitively through the pipeline entry; `fdp-checks gt-paths`
greps the sources and the Dockerfiles; the broker ACL denies `gt/#` to the diagnosis credential.
`make lint` runs the import and path checks, `make test` the no-consumers test, and
`make test-integration` the broker-ACL proof.

## What is in `data/`

| File | Schema | Written by |
| --- | --- | --- |
| `metropt3-failures.json` | `gt-failure-table` | `scripts/build-failure-table.ts`, from [`data/metropt3-first-month-stats.json`](../../data/metropt3-first-month-stats.json). |
| `presets.json` | `gt-presets` | By hand; the labels are the menu text of the user interface ([`docs/dataset.md`](../../docs/dataset.md#the-nine-presets)). |
| `injections.json` | `gt-injections` | By hand, with the simulator's injection code ([`docs/simulation.md`](../../docs/simulation.md)). It is the simulator's catalog; this package validates it, and its loaders would return `null` if it were absent. |

The failure table is generated, never edited: `pnpm --filter @fdp/ground-truth check-failure-table`
compares the committed bytes with what the statistics produce and fails on any drift, and the
test suite runs the same comparison in process. Regenerate it with
`pnpm --filter @fdp/ground-truth build-failure-table`. `packages/ground-truth/data` is outside
Prettier's reach (`.prettierignore`), so nothing reformats the output behind the generator.

The data carries the upstream authors' copyright as well as ours; `REUSE.toml` states the credit.

## Using it

```ts
import { labelAt, scoringWindows, precursorFrom } from "@fdp/ground-truth";

labelAt("2020-06-06T00:00:00.000Z");
// { failure_id: "F3", fault_id: "dryer_purge_leak",
//   accepted_fault_ids: ["dryer_purge_leak", "downstream_air_leak"],
//   excluded: false, reason: null, in_headline: true }

labelAt("2020-04-17T18:00:00.000Z");
// { …, excluded: true, reason: "frozen_logger" }   the logger was frozen, so nothing is scored
```

Windows are half-open — `start` inclusive, `end` exclusive — and `labelAt` gives a failure
window precedence over an excluded one, so a frozen block that reaches into a failure does not
unlabel its first minutes. `F4b` is a secondary positive: it is an excluded window until a caller
passes `{ includeSecondary: true }`, and never a false positive.

`buildGtCatalog()` assembles the retained message the simulator publishes on `gt/cau-7/catalog`:
the presets and the failure table verbatim, the injections cut down to what the menu needs, and
a digest over the files that produced it. `DATA_DIR` is the absolute path of `data/`, for the
Dockerfile and the evaluation scripts that read the files rather than import them.

## Commands

```sh
pnpm --filter @fdp/ground-truth test                  # data, referential and label tests
pnpm --filter @fdp/ground-truth typecheck
pnpm --filter @fdp/ground-truth check-failure-table   # the generated table is still current
pnpm --filter @fdp/ground-truth build                 # tsc -b, for the Docker images
```

The suite also carries the standing regression for the `@fdp/source` export condition, which
lets development and tests resolve workspace packages to their TypeScript source without a build
(`test/resolution.test.ts`): this is the first package that depends on `@fdp/contracts`, so it is
the first place where a broken condition would show up as a `dist/` import instead of the source.

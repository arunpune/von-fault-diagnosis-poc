<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Contributing

Thanks for your interest in Fault Diagnosis PoC. Bug reports, ideas and pull requests are welcome.
For anything larger than a small fix, open an issue first so that the approach can be agreed before you write the code.

Everything in this repository is driven from one entry point, the root `Makefile`: `make help` lists every target with a
one-line description, and this guide explains the rules those targets enforce. [docs/development.md](docs/development.md)
walks through a working session in more depth: the workspaces, running one piece outside Compose, and the tests.

Everyone taking part in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Security vulnerabilities are
reported privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Ground rules

These ten rules apply to every change. A change that breaks one is not merged, whatever the tests say.

1. **No third-party manuals in the repository.** Never commit, quote or paraphrase a real manufacturer's manual, not
   even as extracted text, index chunks or test fixtures. The bundled manual is fictional; a real manual enters only
   through the local, gitignored `data/byo-manual/` path, and only if you are allowed to use it.
2. **No real brands.** No manufacturer names, product lines, controller names, part numbers or model codes, whether in
   code, tests, the manual, documentation or commit messages. The machine and every identifier around it are fictional.
   The brand blocklist check (`make blocklist`) enforces this; see [section 7](#7-no-real-brand-names).
3. **Ground-truth isolation.** Fault-injection labels and the MetroPT-3 failure table live in their own package,
   `packages/ground-truth`. Diagnosis code (detection, retrieval, decisions, the gate) may not import or read them; only
   the evaluation harness, the simulator that injects the faults and the backend's read-only UI overlay may. Import
   boundaries, broker ACLs and database roles enforce it mechanically; see
   [docs/architecture.md](docs/architecture.md#ground-truth-isolation) and [section 8](#8-import-boundaries).
4. **Licensing layout.** Code and configuration are Apache-2.0; the manual, the fault catalog, synthetic data and the
   documentation are CC BY 4.0. Every file carries SPDX headers, or a `REUSE.toml` entry when its format has no
   comments, and the tree stays REUSE-compliant; see [section 6](#6-licences-and-spdx-headers).
5. **MetroPT-3 by download only.** The dataset is fetched at run time from `METROPT_URL`, with the UCI archive as the
   fallback, into a gitignored folder. No MetroPT-3 rows are committed: only slice definitions, hashes and derived
   statistics, credited to the dataset's authors (DOI 10.24432/C5VW3R, CC BY 4.0).
6. **No large files in Git.** GitHub refuses files over 100 MiB, and a repository should not need them. Large inputs
   such as the MetroPT-3 CSV land in gitignored folders and are checked against a committed SHA-256 (`data/SHA256SUMS`).
7. **Secrets via the environment only.** API keys reach the containers from the gitignored `.env` through Docker
   Compose. `.env.example` lists every variable without a secret value, and keys never enter images, logs, the UI,
   tests or commits. Tests use the mock decision services, never a live key.
8. **Verify dependencies before pinning.** Check the current version and licence of every new dependency at its
   registry when you add it. Never pin from memory; see [section 9](#9-adding-a-dependency).
9. **Permissive runtime dependencies.** No GPL or AGPL (or other strong copyleft) library in anything that ships in an
   image. Copyleft development tools are allowed, because they are never distributed. `make licenses` enforces the
   policy.
10. **Small, reviewable changes.** One concern per pull request, with its checks green and its user-visible changes
    described, so that the maintainers can review it and carry it into the [CHANGELOG](CHANGELOG.md).

## 1. Prerequisites and setup

| Tool                | Version                    | Needed for                                      |
| ------------------- | -------------------------- | ----------------------------------------------- |
| Node.js             | 24.21.0 (`.nvmrc`)         | the TypeScript workspace                        |
| pnpm                | 11.27.0 (`packageManager`) | installing and running it                       |
| Go                  | 1.27                       | `services/modbus`                               |
| uv                  | ≥ 0.12.12                  | the Python workspace and every repository check |
| Python              | 3.13                       | uv installs it if it is missing                 |
| GNU Make            | ≥ 3.81                     | the entry point (macOS ships 3.81)              |
| git                 | ≥ 2.31                     | the repository checks                           |
| golangci-lint       | 2.13.2                     | `make lint-go`                                  |
| Docker + Compose v2 | Compose 2.24 or newer      | `make up` and the integration tests             |
| shellcheck          | 0.11.0                     | shell scripts (optional, reported as a warning) |

Only Docker is needed to run the demo (see the README's [Quick start](README.md#quick-start)). To work on the code:

```bash
make doctor          # one line per tool with the version found; non-zero when one is missing or too old
make install         # pnpm, uv and Go dependencies, all from the lock files
make fetch-dataset   # once: MetroPT-3 into data/metropt3/, verified against data/SHA256SUMS
make fixtures        # the MetroPT-3 slices the tests and the evaluation read
make check           # lint and unit tests
make hooks           # optional: the pre-commit and commit-msg hooks (section 4)
```

`make doctor` never reads or prints an environment variable value, so its output is safe to paste into an issue.
Tests whose resource (a MetroPT-3 slice, the embedding model, WeasyPrint, Docker) is missing skip with a message;
[docs/development.md](docs/development.md) lists what each group needs.

## 2. The daily loop and the gate levels

```bash
make check       # before every commit: lint plus the unit tests
make check-int   # check plus the integration tests (Docker)
make ci          # the full gate; CI runs all of it but the init end-to-end test
```

| Gate        | Runs                                                                   | When                                                                                         |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `check`     | `lint test`                                                            | before every commit                                                                          |
| `check-int` | `check test-integration`                                               | before a pull request that touches the database, the broker or images                        |
| `ci`        | `lint test test-integration test-init-e2e reuse licenses check-manual` | before a larger pull request; CI runs these targets as separate jobs, except `test-init-e2e` |

`make check` is fast but runs **no** integration test: the database-role, broker-ACL, migration-conformance, container
and cross-language parity proofs all live behind `make test-integration`. `make ci` also needs Docker, WeasyPrint for
the manual checks and the network on cold caches.

`make lint` runs fast-first: `spdx`, `gt-paths`, `env-check`, `reuse-order` and `blocklist` (seconds), then
`compose-check` and `actionlint`, then `lint-ts`, `lint-py`, `lint-go` and `boundaries` (tens of seconds).
`make -k lint` shows every failure at once instead of stopping at the first. `make fmt` formats every language in place.

`scripts/foundation-smoke.sh` clones a revision into a temporary directory and runs `make install && make check` there
with nothing but the documented toolchain. Run it before you claim that a change works on a clean clone.

## 3. Branches and pull requests

1. Fork the repository on GitHub and clone your fork.
2. Create a feature branch from an up-to-date `main`, for example `fix/gateway-reconnect` or `feat/detection-new-rule`.
3. Make your change in small, focused commits (section 4), with tests and documentation alongside the code.
4. Run `make check`, plus the checks your change calls for (section 10), and push the branch to your fork.
5. Open a pull request against `main` of `meddleconnect/von-fault-diagnosis-poc` and fill in the template.
   CI runs on the pull request, and a maintainer reviews it.

The `quickstart` CI job is expected to stop at its ticket check, for the reason the README gives under
[Status and limitations](README.md#status-and-limitations); a pull request does not need to fix that.

Keep a pull request to one concern; unrelated fixes go in their own. Rebase on `main` rather than merging it into your
branch when you need to catch up, and regenerate lock files instead of hand-merging them (section 5).

## 4. Commits

Every commit is a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <subject>

<optional body: what changed and why>
```

- **Types**: `feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`, `refactor`, `perf`, `style`.
- **Scopes** (required): `repo`, `manual`, `pdf`, `contracts`, `gt`, `db`, `sim`, `gateway`, `init`, `backend`,
  `frontend`, `eval`, `infra`, `ci`, `deps`, `docs`, `data`. (`merge` is also accepted, for merge commits.)
- `!` after the scope marks a breaking change: `refactor(contracts)!: drop the legacy envelope`.
- The subject is lower-case, imperative and at most 72 characters after `: `.
- Merge and revert subjects that git writes itself are exempt.
- Stage explicit paths. Never `git add -A` or `git add .`, and never commit `.env`, `data/metropt3/*`, `node_modules`,
  `.venv` or build output.

```bash
make commits                       # checks origin/main..HEAD
make commits BASE=upstream/main    # in a fork, against the upstream remote
uv run fdp-checks commits --range upstream/main..HEAD
```

### Git hooks (opt-in)

```bash
make hooks   # git config core.hooksPath .githooks
```

`.githooks/pre-commit` runs `fdp-checks spdx --staged` and `fdp-blocklist scan --staged`; `.githooks/commit-msg` checks
the subject grammar of the message being written. Bypass them for one commit with `git commit --no-verify`, and switch
them off again with `git config --unset core.hooksPath`. CI runs the same checks either way.

## 5. Shared files

Some files are touched by many kinds of change. Keep their edits small and self-contained:

1. **Lock files** (`pnpm-lock.yaml`, `uv.lock`, `services/modbus/go.sum`) are regenerated, never hand-merged: on
   conflict take either side, then run `pnpm install`, `uv lock` or `go mod tidy` and commit the result.
2. **`Makefile`** edits add or replace whole targets, each with a `## help text` comment that `make help` prints.
3. **`.env.example` and the README's Configuration table** change together, in one commit, with the same defaults,
   groups and order; `make env-check` and `scripts/ops/readme.test.ts` check them.
4. **`REUSE.toml`** gains `[[annotations]]` tables only, appended below the marker line (section 6).
5. **`pnpm-workspace.yaml`** pins every Node dependency in its `catalog:` block; a version change is a `build(deps):`
   commit.

## 6. Licences and SPDX headers

Code and configuration are Apache-2.0; the manual, the fault catalog, synthetic data and documentation are CC BY 4.0;
trivial dotfiles, lock files and `.githooks/*` are CC0-1.0; fonts keep OFL-1.1 and copied `shadcn/ui` sources keep MIT.
The layout follows [REUSE](https://reuse.software/), so every file states its licence in a machine-readable way.
Every new file carries the two-line header in its own comment syntax:

<!-- REUSE-IgnoreStart -->

```text
SPDX-FileCopyrightText: 2026 Meddle S.r.l.
SPDX-License-Identifier: <id>
```

<!-- REUSE-IgnoreEnd -->

Use the identifier of the neighbouring files of the same kind, or look the path up with `reuse lint` and in `REUSE.toml`.
A format without comments (JSON, PDF, CSV, fonts) is covered by a `REUSE.toml` table or a `<file>.license` sidecar
instead.

### Licensing of contributions

Contributions are accepted under the licences of the files they touch ("inbound = outbound"): code and configuration
under the Apache License 2.0, as its section 5 provides for contributions submitted for inclusion, and the manual, the
catalog, synthetic data and documentation under CC BY 4.0. By opening a pull request you confirm that you have the right
to submit the work under those terms.

A new file carries `SPDX-FileCopyrightText: 2026 Meddle S.r.l.`, or your own copyright line beside it, for example
`SPDX-FileCopyrightText: 2026 Jane Doe <jane@example.com>`, plus the `SPDX-License-Identifier` of its kind. When you
substantially change an existing file you may add your own copyright line to it in the same way. Material you did not
write keeps its original holder and licence, and must be compatible with the file's licence.

**Adding a licence.** Fetch the SPDX text from `https://spdx.org/licenses/<id>.txt`, commit it verbatim as
`LICENSES/<id>.txt`, and use the identifier in the headers. `fdp-checks spdx` derives its allowed set from those file
names, and `reuse lint` fails both on a used-but-missing licence and on a committed licence nobody uses.

**`REUSE.toml` order is load-bearing.** REUSE resolves a path against the _last_ matching table, so append new tables
**below** the line

```text
# --- specific annotations: append below this line, never above ---
```

and never above it. `make reuse-order` resolves a committed expectation table (`tools/repo-checks/reuse-expected.toml`)
through the file and fails on a drifted licence, a general table below the marker or a missing marker; add an entry to
that table when your change introduces a new licence class or a new data directory.

```bash
make spdx          # fast offline header check (also runs in the pre-commit hook)
make reuse-order   # the ordering guard
make reuse         # the real `reuse lint` over the whole tree
```

## 7. No real brand names

Ground rule 2: no manufacturer, product line, controller name, model code or part number of a real machine may enter
this repository, not in code, not in tests, not in the manual, not in a commit message.

The term list is **hashed** before it is committed: `tools/blocklist/data/blocklist.sha256` holds salted digests of word
n-grams, so no real brand name is in Git, not even in the scanner's own data.

```bash
make blocklist                  # scan every tracked and untracked-not-ignored file
uv run fdp-blocklist list       # section names and term counts
uv run fdp-blocklist self-test  # matcher check with synthetic terms
```

If the scan flags your change, rename the identifier. A false positive, a word that happens to normalise onto a listed
term in one specific file, gets a line in `tools/blocklist/data/allow.txt` (`<path-glob> :: <term>  # reason`, the
reason mandatory); a real brand name is **removed from the file**, never exempted. The plain term list is kept by the
maintainers; if you spot a real brand name the scan misses, say so in an issue without repeating it more than needed.

## 8. Import boundaries

Ground-truth isolation (ground rule 3) is enforced mechanically in all three languages:

| Language   | Rule lives in                                                                                                                                   | Run with                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| TypeScript | `.dependency-cruiser.cjs` (forbidden rules) and `eslint.config.js`                                                                              | `pnpm run lint:boundaries`, `make lint-ts`    |
| Go         | `services/modbus/.golangci.yml` (`depguard`, per-file feedback) and `services/modbus/internal/arch/imports_test.go` (authoritative, transitive) | `make lint-go`, `go test ./internal/arch/...` |
| Python     | `[tool.importlinter]` in the root `pyproject.toml`                                                                                              | `uv run lint-imports`                         |

`make boundaries` runs all three, and `make gt-paths` additionally checks that no diagnosis path so much as reads a
ground-truth file. A new workspace member must be added to every list that names members: `root_packages`, the
independence contract's `modules`, `fdp_init`'s `forbidden_modules` and `[tool.mypy] packages`;
`tools/repo-checks/tests/test_import_linter.py` fails when one of them is missing. The allowed directions are described
in [docs/architecture.md](docs/architecture.md#import-boundaries).

## 9. Adding a dependency

Ground rules 8 and 9: **verify before pinning**, and runtime dependencies must be permissive.

1. Check the current version and licence at the registry (npm, PyPI, the Go module proxy, the GitHub releases API)
   _at the moment you add it_. Never pin from memory, and name the source you verified against in the commit body.
2. Runtime licences must be permissive: `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `0BSD`,
   `BlueOak-1.0.0`, `CC0-1.0`, `CC-BY-4.0`, `PostgreSQL`, `Python-2.0`, `PSF-2.0`, `OFL-1.1`, `MIT-0`, `MIT-CMU`, `Zlib`.
   `GPL-*`, `AGPL-*`, `SSPL-*`, `EUPL-*`, `CC-BY-SA-*` and `CC-BY-NC-*` are rejected in runtime scope; `MPL-2.0`,
   `Unlicense` and `LGPL-*` are flagged and need a reviewed entry with its reason in
   `tools/repo-checks/licenses-policy.toml`.
3. Copyleft **development-only** tools (for example `reuse`, `golangci-lint` and `shellcheck`) are allowed, because
   nothing of them ships in an image.
4. `make licenses` audits all three ecosystems and fails on a runtime violation or an unknown licence.

Per ecosystem:

```bash
# Node: pin the version in the catalog, reference it as catalog: in the package
#   pnpm-workspace.yaml   catalog:  <name>: <version>
#   <package>/package.json            "<name>": "catalog:"
pnpm install                     # regenerates pnpm-lock.yaml

# Python: one member at a time, never the virtual root
uv add --package fdp-init <name>==<version>
uv sync --all-packages --frozen

# Go: from services/modbus
go get <module>@<version> && go mod tidy
```

A package with a lifecycle script stays blocked until it is reviewed: `pnpm-workspace.yaml` carries an explicit
`allowBuilds:` entry per package with the reason in a comment. `allowBuilds: {}` is not a valid state, because
`pnpm install --frozen-lockfile` then refuses to install. `minimumReleaseAgeExclude` is written by pnpm itself; leave
it alone.

## 10. Tests

| Level                | Command                                      | Notes                                                                                                                        |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Unit and contract    | `make test` (`test-node test-go test-py`)    | No network, no Docker, no clock; deterministic.                                                                              |
| Integration          | `make test-integration`                      | Docker and testcontainers; part of `check-int` and `ci`.                                                                     |
| init end to end      | `make test-init-e2e`                         | Builds the init image and runs it; Docker, and the network on a cold model cache.                                            |
| End-to-end (browser) | `make e2e-mock`, `make e2e-perf`, `make e2e` | Mocked backends (`e2e-perf` runs the streaming budget alone), or the CI stack `make smoke SMOKE_ARGS=--keep` leaves running. |
| Stack smoke          | `make smoke`, `make smoke-quickstart`        | Its own stack on ephemeral ports, with the mock decision service or the rules backend.                                       |
| Evaluation           | `make eval`                                  | Replays scenarios with known ground truth; run it when you touch the diagnosis.                                              |
| Manual               | `make check-manual`                          | The manual's acceptance checks ([docs/manual.md](docs/manual.md#acceptance-checks)).                                         |

`make smoke-live` and the evaluation's live mode make paid calls with your own keys; they are opt-in, and CI never runs
them.

Markers and tags:

- Python: `@pytest.mark.integration` (needs Docker); `uv run pytest -m integration` selects it, and the plain
  `uv run pytest` of `make test-py` deselects it. `@pytest.mark.network` (needs the internet on a cold cache) is not
  deselected: those tests run in `make test-py` and skip themselves when what they need is missing, such as an
  uncached embedding model without `FDP_REQUIRE_MODEL=1`.
- Go: the `integration` build tag; `go test -tags integration ./...`.
- Node: a package's own `test:integration` script, picked up by `pnpm -r run --if-present test:integration`.

Tests are deterministic: fake clocks, seeded randomness, committed fixtures, random host ports and a unique Compose
project name, so parallel runs do not collide. Tests never contain a real brand name, and they never call a live API:
the decision backend in tests is the mock TypeSafe server.

## 11. Security and conduct

- **Vulnerabilities**: report them privately as [SECURITY.md](SECURITY.md) describes, never in a public issue or pull
  request.
- **Code of conduct**: everyone taking part follows the [Contributor Covenant](CODE_OF_CONDUCT.md); report conduct
  issues to the maintainers privately, as it describes.

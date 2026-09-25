<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Licence-audit fixtures

Where each file came from, so that a shape change in a tool can be told apart
from a bug in the parser. Captured on 2026-09-20 with the tool versions named
below.

| File | Source |
| --- | --- |
| `pnpm-dev.json` | `pnpm licenses list --json --dev` (pnpm 11.27.0) at the repository root, trimmed to one entry per licence key. The `paths` key of each entry was removed: it holds absolute paths of the machine that ran the capture, and no parser reads it. |
| `python-metadata.json` | `importlib.metadata` over the synced uv workspace environment, as `licenses_python.Distribution` records it, trimmed to ten distributions. It keeps the interesting shapes: PEP 639 `License-Expression`, a legacy `License` field spelled `BSD 2-Clause License`, a licence that only a trove classifier states, the workspace member `fdp-init` that the audit must skip, and pypdfium2's `BSD-3-Clause, Apache-2.0, dependency licenses`, which is not an expression and is what `[overrides]` exists for. |
| `go-report.csv` | `go run github.com/google/go-licenses/v2@v2.0.1 report ./...` over a throwaway module that required the Go dependencies then planned for the simulator. `services/modbus` declared no requirements at the time, so a capture from it would have been empty; the throwaway module gives the same shape of rows, including the `Unknown` row for the main module that the collector must drop. |
| `pnpm-copyleft.json` | Hand-written in the shape `pnpm licenses list --json` answers with. The package names are invented. It exists because no dependency of this repository is copyleft, and the audit's central rule — a copyleft runtime dependency fails, the same licence in dev scope is only listed — needs an example to be tested at all. |

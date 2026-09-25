<!--
SPDX-FileCopyrightText: 2026 Meddle S.r.l.
SPDX-License-Identifier: CC-BY-4.0
-->

# MetroPT-3 fixtures: definitions here, rows never

[Ground rule 5](../../CONTRIBUTING.md#ground-rules) lets MetroPT-3 reach a machine by **download only**, and ground rule 6
keeps large files out of Git. The consequence: **no row of the dataset is committed anywhere in this repository**, not even a
one-megabyte excerpt.

What is committed is [`metropt3-slices.json`](metropt3-slices.json) — the definition of every slice the tests read: its time
segments in the dataset clock, its row count and the SHA-256 of the cut CSV. `make fixtures` turns those definitions back into
files under `data/fixtures/metropt3/`, which is git-ignored. `data/SHA256SUMS` carries one line per slice, so the init service
verifies a cut slice by basename exactly as it verifies the full download.

## Cutting them

```bash
make fetch-dataset   # download MetroPT-3 into data/metropt3/ and verify it (once)
make fixtures        # cut every slice into data/fixtures/metropt3/ and verify the result
```

`make fixtures` runs [`scripts/data/cut-metropt-slices.py`](../../scripts/data/cut-metropt-slices.py), which streams the 218 MB
source once, copies the header line and every field verbatim (the unnamed index column included), checks that the source hashes
to the value in the definitions and compares what it wrote with the recorded rows and hashes. Cut one slice with
`--only <name>`, and re-measure the definitions after a segment change with `--report data/fixtures/metropt3-slices.json`.

Two environment variables are easy to confuse:

| Variable | Side | Meaning |
| --- | --- | --- |
| `METROPT_CSV_HOST` | host | the path `make fixtures` cuts **from**; default `data/metropt3/MetroPT3(AirCompressor).csv`. Point it at a copy already on disk, for example in another checkout, instead of copying 218 MB. |
| `METROPT_CSV` | container | the path init and the simulator **replay**; `/data/fixtures/metropt3/ci-slice.csv` selects fixture mode. |

When the source is not there, `make fixtures` prints
`fixtures: MetroPT-3 source not found at <path>; skipping (set METROPT_CSV_HOST or run make fetch-dataset)` and exits 0, so a
checkout that needs no dataset is not held up. Set `FDP_REQUIRE_DATASET=1` to turn that skip into a failure; the tests
follow the same rule and skip every slice assertion when the cut files are absent.

## The slices

| Slice | Window in the dataset clock | Why it exists |
| --- | --- | --- |
| `ci-slice` | 02-01 00:00–06:00, 06-05 06:00–14:00, 07-31 01:00–07:00 | the CI and quick-trial replay source |
| `sim-day-2020-02-01` | 02-01 → 02-02 | one full normal day for the simulator |
| `parity-feb01` | 02-01 00:00–02:00 | the short window the evaluation parity checks replay |
| `baseline-feb03` | 02-03 → 02-04 | a first-month day: the detection negatives |
| `f1-apr18` | 04-17 20:00 → 04-19 04:00 | failure F1 with its lead-in and the frozen block before it |
| `f2-may30` | 05-29 18:00 → 05-30 12:00 | failure F2 |
| `f3-jun05` | 06-05 04:00 → 06-06 04:00 | failure F3, the README tour |
| `f4-jul15` | 07-14 06:00 → 07-16 02:00 | failure F4 with its 17 h precursor |
| `f4b-jul17` | 07-16 18:00 → 07-17 08:00 | the unpublished recurrence F4b |
| `summer-jul05` | 07-05 → 07-06 | a normal summer day: the seasonal-drift negative |
| `depot-jul31` | 07-31 00:00–08:00 | a depot depressurisation: the abstention case |
| `depot-apr30` | 04-30 23:00 → 05-01 13:00 | a second depressurisation, sparsely logged |
| `frozen-jun22` | 06-22 12:00 → 06-23 00:00 | the frozen-logger guard |
| `unlabelled-may19` | 05-19 20:00 → 05-21 00:00 | an unlabelled leak: neither positive nor false positive |
| `august-aug10` | 08-10 → 08-11 | the August stretch with `Oil_level` at 0 |
| `sim-gate` | five windows, February to July | one file that visits every scenario the stack gate drives |
| `heldout-mar17`, `heldout-mar22`, `heldout-apr05`, `heldout-jun26`, `heldout-jun29`, `heldout-aug01` | one whole day each | the sealed held-out set: drawn by the rule of [`tools/eval/records/heldout-seal.md`](../../tools/eval/records/heldout-seal.md), sealed there, and replayed by nothing but its one final run |

Bounds are half-open: a row is in a segment when `from ≤ timestamp < to`. The joins between the segments of a multi-segment
slice are ordinary source gaps, which the simulator collapses with a `discontinuity` flag; nothing synthetic is inserted.

In fixture mode the replay reports a dataset spanning 2020-02-01 to 2020-07-31 with three collapsed gaps: the two joins and a
3.8-hour source gap inside the depot segment, from 02:09:04 to 05:57:50 on 31 July. Only three
presets land where they should in `ci-slice`: **`baseline_feb`**, **`f3_air_leak_jun05`** and **`depot_lps_jul31`**. Any other
preset seeks to the first row at or after its target and so lands in the next segment; the smoke test and the end-to-end tour
use the three meaningful ones.

## Credit

Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021). *MetroPT-3 Dataset*. UCI Machine Learning Repository.
<https://doi.org/10.24432/C5VW3R>. Licensed **CC BY 4.0**.

The slice definitions and this file are CC BY 4.0 as well. A cut slice is an **excerpt (modified: rows selected)** of the
original file: no value is altered, no row is synthesised, and the file is never redistributed through this repository.

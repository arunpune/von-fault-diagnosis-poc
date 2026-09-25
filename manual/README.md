<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# CAU-7 manual source of truth

Everything the fictional *CAU-7 Compressed-Air Unit* instruction manual says about the machine
lives here as data. Prose and tables are rendered from these files; nobody edits a number by hand
in a chapter. What the manual describes, how it is built into PDFs and how init reads it back is in
[`docs/manual.md`](../docs/manual.md); the build itself is
[`tools/manual-build`](../tools/manual-build/README.md).

## Layout

| Path | What it holds | Licence |
| --- | --- | --- |
| `build.yaml` | document metadata, chapter list, variant knobs, lint allowlist | CC-BY-4.0 |
| `spec/machine.yaml` | identity, ratings, limits, reference conditions, sensors, components, parts, reference operation | CC-BY-4.0 |
| `spec/signals.yaml` | the sixteen signal tags in register order, machine states, derived signals, behaviours, normal bands | CC-BY-4.0 |
| `spec/settings.yaml` | programmable CTRL-7 parameters with min / default / max and constraints | CC-BY-4.0 |
| `spec/alarms.yaml` | controller messages with machine-evaluable triggers | CC-BY-4.0 |
| `spec/faults.yaml` | symptom conditions and the causes they share | CC-BY-4.0 |
| `spec/maintenance.yaml` | maintenance tasks, intervals, consumables, steps | CC-BY-4.0 |
| `spec/derived/normal-bands.json` | output of `tools/derive_bands.py`; the bands the YAML copies | CC-BY-4.0 |
| `spec/schemas/*.schema.json` | JSON Schema draft 2020-12, one per file plus shared `$defs` | Apache-2.0 |
| `tools/**` | loader, validator and their tests | Apache-2.0 |
| `content/`, `figures/` | Markdown partials and hand-drawn SVG figures | CC-BY-4.0 |
| `templates/`, `fonts/` | the PDF build's HTML templates, stylesheets and fonts | see `REUSE.toml` |

Every file carries an SPDX header; JSON files use a `<file>.license` sidecar, because JSON has no
comment syntax. Rule `L1` checks this.

## Commands

The tooling deliberately sits outside the uv workspace, so it runs in a fresh checkout with no
`make install` and no `.venv`:

```bash
# both checks at once, the way CI runs them
make check-manual-spec

# validate the whole spec, fail if a source file is missing, print the metrics
uv run --no-project --with-requirements manual/tools/requirements.txt \
    python manual/tools/validate.py --spec manual --strict --report

# run the tooling's own tests (also part of `make test-py`)
uv run --no-project --with-requirements manual/tools/requirements.txt pytest manual/tools/tests -q

# text-level checks: Jinja rendering, number lint, anchors, SVG rules
uv run --no-project --with-requirements manual/tools/requirements.txt \
    python manual/tools/content_checks.py --variant both

# read both variants in a browser before a PDF exists
uv run --no-project --with-requirements manual/tools/requirements.txt \
    python manual/tools/preview.py --out build/manual-preview --variant both

# re-derive the normal bands from the full MetroPT-3 CSV (needs the dataset)
uv run --no-project manual/tools/derive_bands.py --csv "$METROPT_CSV"
```

`validate.py` flags:

| Flag | Effect |
| --- | --- |
| `--spec DIR` | spec root that holds `build.yaml` and `spec/` (default `manual`) |
| `--strict` | fail when any of the seven YAML files or `spec/derived/normal-bands.json` is missing |
| `--only a,b` | load only these documents; rules that need a document which is not loaded print `SKIP <rule> needs <file>` |
| `--minimums C,K,S,B` | catalog floors for rule A1: conditions, causes, sharing, benign (default `12,30,5,2`) |
| `--report` | print the catalog metrics |

Every failure prints one line `RULE file:pointer message`, where `pointer` is an RFC 6901 JSON
pointer into that file; the process exits 1 if there is at least one finding.

## Data model

### Identifiers and conventions

- Identifiers (`id`, `fault_id`, setting, component, part and task ids): `^[a-z][a-z0-9_]{1,39}$`,
  unique within a file and across the whole spec — a signal and a cause never share an id.
  `machine.parts[].id` is the one exception: a consumable may be named after the component it
  belongs to, because parts and components are referenced through different fields.
- Alarm codes `^[WXSM][0-9]{3}$`, parameter numbers `^P[0-9]{2}$`, panel labels `^[PTID][0-9]$`,
  part codes upper-case with hyphens.
- Every file starts with the two SPDX comments and `schema_version: 1`.
- Numbers live in typed fields with an explicit `unit` from the closed enum in
  `spec/schemas/common.schema.json` (`bar`, `degC`, `A`, `V`, `kW`, `Hz`, `s`, `min`, `h`,
  `months`, `L`, `m3_per_min`, `mm`, `m`, `kg`, `dBA`, `rpm`, `percent`, `count`, `per_hour`,
  `bar_per_min`, `bool`). Text fields must not contain hand-typed numbers with units.
- A threshold is either an inline `{value, unit}` or a reference `{setting: <id>, offset?: <number>}`,
  so chapter 3 and chapter 4 cannot disagree.
- Order is load-bearing in `spec/signals.yaml` (it is the Modbus register order) and in the cause
  lists of `spec/faults.yaml` (most likely first). Everywhere else, order is presentation order.
- **Quote `"off"`.** YAML 1.1, which PyYAML implements, reads the bare scalars `off`, `on`, `yes`
  and `no` as booleans, and `off` is a machine state used both as a key and as a value.
  `manual/tools/load.py` loads with a YAML 1.2 boolean resolver so it agrees with the Go and
  TypeScript consumers, but quoting keeps the files correct under a plain `yaml.safe_load` too.

### Files

`machine.yaml` — `identity`, `document` (must equal `build.yaml`), `ratings` (each `{value, unit}`),
`limits`, `reference_conditions`, `hardware_switches`, `sensors` (one per analog signal, its range
is the signal's range), `components`, `parts`, `reference_operation` (copied from the derived cycle
block) and the closed `subsystems` list.

`signals.yaml` — `signals[]` in register order: `id`, `panel_label`, `name`, `metropt_column`
(verbatim CSV header, `null` for the synthetic extra), `group` (`analog` / `digital` / `extra`),
`kind`, `unit`, `subsystem`, `description`, optional `source_note`, `sample_rate_s`, `range`,
`display`, `band` (`{step, source}`), `modbus` (`{type, scale}`), `normal_bands` per state and
`shown_in_schematic`. Then `machine_states` (rules, running threshold, aliases, start event),
`derived[]` (`abs_delta`, `delta`, `time_in_state`, `events_per_window`, `seconds_since_change`,
`time_in_states_total`) and `behaviours[]`, the named observables the fault catalog points at.

`settings.yaml` — `settings[]`: `id`, `param_no`, `name`, `unit`, `type`, `min`, `default`, `max`,
`step`, `access`, optional `signal`, `description`, optional `used_by` and `constraints[]`. A
constraint asserts `default <relation> (other + margin)` on the resolved defaults, where `other` is
a setting id or a dotted machine path such as `machine.ratings.max_working_pressure`.

`alarms.yaml` — `alarms[]`: `code`, `type` (`warning` / `shutdown_warning` / `shutdown` /
`service`), `bit` (0–31 for `evaluation: sim`, otherwise `null`), `evaluation`, optional
`family` + `rank`, `title`, `display` (at most 16 characters, `A–Z 0–9 space`), `effect`,
`trigger`, `reset`, optional `cause_hint`, `operator_action` and `related_conditions`.
A trigger is `kind: signal` (state guard, optional `exclude_start_s`, a condition that is one leaf
`{signal, op, threshold}` or a single level of `all` / `any`, and `for_s`), `kind: counter`
(`counter: {derived, task}`) or `kind: external` (`input`).

`faults.yaml` — `conditions[]` (`id`, `title`, `symptom`, `alarms`, `signals`, `causes[]` in
likelihood order) and `causes[]` (`fault_id`, `name`, `subsystem`, `benign`, `summary`,
`signal_moves[]`, `checks[]`, `remedy`, `parts`, `maintenance`, `components`). A `signal_move`
targets exactly one of `signal` or `behaviour` and uses the direction vocabulary of its target:
analog `rises falls high low unchanged fluctuates near_zero not_venting`, digital
`on off stays_on stays_off toggles no_pulse`, behaviour
`higher lower longer shorter faster slower not_reached unchanged`, plus an optional `phase` and
`onset`.

`maintenance.yaml` — `tasks[]`: `id`, `name`, `interval` (`hours` / `months` / `calendar` plus
`rule: whichever_first`), `service_message` (a `service` message code or `null`), `duration_min`,
`consumables`, `tools`, `safety`, `steps`, `post_checks`, `related_causes`, `components`.

`build.yaml` — `document`, `source_date_epoch`, `outputs`, `fonts`, `chapters[]`,
`default_variant`, `variants` (`clean`, `realistic`, `scanned`) and `lint.allowed_number_phrases`,
then the `pdf:` block the PDF build reads (`pdf_identifier`, `page_budget`, `outputs.manifest`,
`outputs.catalog`).

`spec/derived/normal-bands.json` — `provenance`, `signals` (per signal and state: the band plus the
raw percentiles, or `expected` / `duty` for digitals), `start_current_peak`, `cycle`, `_credit`
and `_license`. Written by `tools/derive_bands.py`; never edited by hand.

## Regenerating the normal bands

The bands come from February 2020 of MetroPT-3 only, the dataset's suggested training month and
one that holds none of its failures, so no failure shapes a band (acceptance check 11 of
[`docs/manual.md`](../docs/manual.md#acceptance-checks) enforces it). The CSV is gitignored, so the
derivation is reproducible offline and its result is committed:

```bash
uv run --no-project manual/tools/derive_bands.py \
    --csv "data/metropt3/MetroPT3(AirCompressor).csv"
```

It rewrites `spec/derived/normal-bands.json` (keys sorted, two-space indent) and prints a
`normal_bands:` snippet per signal for pasting into `signals.yaml`. Rule `B1` then asserts that the
YAML copies match the JSON, and rule `B2` asserts the provenance: source SHA-256
`db30ccb4…93e24`, range `2020-02-01T00:00:00` to `2020-03-01T00:00:00`, `rows_total` 1 516 948,
more than 200 000 rows used and `range_override: false` (a file derived with `--range` must never
be committed).

## Validation rules

`manual/tools/validate.py` owns the spec-level rules; `manual/tools/content_checks.py` owns the
text-level ones (`N1`, `N3`, `C1`–`C6`).

| Rule | Checks |
| --- | --- |
| `S1` | every document validates against its schema and declares `schema_version: 1` |
| `S2` | identifiers, alarm codes, alarm bits, parameter numbers, panel labels and MetroPT columns are unique |
| `R1` | every referenced signal, setting, alarm, condition, cause, task, part, component and subsystem exists |
| `R2` | every condition lists a cause and every cause is listed by a condition |
| `R3` | every `evaluation: sim` message is reachable from at least one condition |
| `R4` | every setting feeds a message threshold or delay, or declares `used_by` |
| `R5` | `service` messages and maintenance `service_message` agree in both directions |
| `P1` | a message family rises strictly in rank, in severity and in threshold |
| `P2` | signal ranges equal the sensor ranges; every resolved threshold carries the signal's unit and lies inside its range |
| `P3` | `min ≤ default ≤ max`, `step > 0`, constraints hold on the defaults, and cut-out ≤ maximum working pressure ≤ safety valve ≤ reservoir design pressure |
| `P4` | bands are ordered and inside the signal range, and a single-leaf threshold stays clear of the bands of the states its guard admits |
| `P5` | `for_s` and `exclude_start_s` are non-negative, a start mask needs a running state guard, hysteresis carries the signal's unit |
| `P6` | `limits.ambient_operating` equals the ambient warning defaults; `machine.document` equals `build.yaml` |
| `M1` | exactly the fifteen MetroPT-3 columns are mapped; a tag without a column has `band.source: authored` |
| `M2` | file order is analog (7) then digital (8) then extra (1); Modbus scale matches the signal kind |
| `B1` | `signals.yaml` bands and `machine.yaml` `reference_operation` copy the derived JSON |
| `B2` | the derived JSON's provenance is the pinned CSV and the first month |
| `A1` | at least 12 conditions, 30 causes and 5 conditions sharing a cause (`--minimums` lowers the floors) |
| `A2` | every subsystem that carries a signal also carries at least one cause |
| `A3` | at least 2 benign causes |
| `A4` | `downstream_air_leak` is listed under `low_line_pressure` and `frequent_cycling` |
| `A5` | every cause has a signal move, a check and a remedy, and every move uses its target's direction vocabulary |
| `N2` | cause summaries and move notes contain no digit |
| `L1` | every `.yaml`, `.md`, `.svg` and `.py` under the spec root has an SPDX header in its first five lines, and every `.json` has a `.license` sidecar |

Rules declare the documents they need. `--only` loads a subset, and a rule whose documents are not
loaded prints `SKIP <rule> needs <file>` instead of running, which is how a single-file check such
as `--only signals` stays useful while another file is being rewritten.

Each rule has one passing and at least one failing case in `tools/tests/test_validate_rules.py`;
the failing cases start from the committed fixture `tools/tests/fixtures/spec-minimal` and change
exactly one value through the `mutate` helper.

## What is in the spec

`validate.py --strict --report` and `content_checks.py --variant both` both exit 0 on this tree.
The counts below are those of this tree; the right-hand column is the floor each registry was
designed to meet (rules `A1` and `A3` enforce the catalog floors).

| Registry | Count | Floor |
| --- | --- | --- |
| signals | 16 (analog 7, digital 8, extra 1), 15 mapped to MetroPT-3 | ≥ 16, 15 mapped |
| derived signals / behaviours | 6 / 6 | — |
| settings | 25 | ≥ 20 |
| messages | 35 (warning 17, shutdown warning 4, shutdown 8, service 6), 27 evaluable bits 0–26 | ≥ 20, ≥ 15 bits |
| maintenance tasks | 13 | — |
| conditions | 17, all 17 sharing a cause with another | ≥ 12, ≥ 5 sharing |
| causes | 39, of which 3 benign | ≥ 30, ≥ 2 benign |
| subsystems covered | 9, each with ≥ 2 causes | every signal subsystem |
| chapters | 10 partials, 8796 prose words, every chapter inside its `C4` budget | — |

`derive_bands.py` reproduces `spec/derived/normal-bands.json` byte for byte from the full CSV
(`manual/tools/tests/test_bands_live.py` with `METROPT_CSV` set), and the brand blocklist scan
(`scripts/blocklist.sh`, rule `N3`) reports no hit.

The comments in `derive_bands.py` predate this repository's publication and cite planning
documents that are not part of it. They are left unchanged because the script's own SHA-256 is
recorded in `spec/derived/normal-bands.json` (`provenance.script_sha256`). Its guard, state,
segment and cycle functions were copied from what is now `scripts/data/metropt3_stats.py`.

## How the PDF build and the checks use these tools

The manual sources are `spec/`, `content/`, `figures/`, `tools/` and `build.yaml`. `templates/`,
`fonts/` and the `pdf:` block at the end of `build.yaml` serve the PDF build,
[`tools/manual-build`](../tools/manual-build/README.md).

**The two check scripts.** Both are plain scripts with the exit code and the
`RULE file:pointer message` output of this repository, so an acceptance runner can call them
directly:

| Script | Covers | Call |
| --- | --- | --- |
| `tools/validate.py` | `S*`, `R*`, `P*`, `M*`, `B*`, `A*`, `N2`, `L1` | `python manual/tools/validate.py --spec manual --strict --report` |
| `tools/content_checks.py` | `N1`, `N3`, `C1`–`C6` (it calls `figure_checks.py` for `C6` and `scripts/blocklist.sh` for `N3`) | `python manual/tools/content_checks.py --variant both` |

`make check-manual-spec` runs exactly those two, and the `manual-spec` job of
`.github/workflows/ci.yml` runs them plus `pytest manual/tools/tests`. `make check-manual` adds the
acceptance checks that need a rendered PDF.

**The context functions.** `tools/context.py` is the single authoring contract, so the browser
preview and the PDF derive every number and label from one implementation. The PDF build imports it
rather than reimplementing a filter, and relies on the module's public surface:

| Name | Use |
| --- | --- |
| `load.load_spec(root)` | the only spec loader; returns `Spec` with the seven documents |
| `build_outline(spec, partials)` | section, figure and generated-heading numbering (`Outline`) |
| `make_env(spec, variant, outline)` | the Jinja environment, `StrictUndefined`, comments `{## ##}` |
| `render_partial(env, chapter, text)` | one chapter, appending the footnote definitions it made |
| `render_text(env, text)` | one YAML text field; explicit cross-reference labels, no footnote |
| `md_to_html(text, footnotes=...)` | the CommonMark pipeline with attrs and footnotes |
| `variant_knobs(build, name)` | resolves `variants.<name>` including `extends` |
| `build_context(spec, variant)` | the registry namespace the templates see |
| `unit_label(unit)` | the unit symbol table (`degC` → `°C`, `per_hour` → `/h`) |
| `ContextError` | what a template raises when the spec does not hold something |

A YAML text field carries Jinja, so anything that prints `steps`, `remedy`, `checks`, `summary`,
`symptom`, `safety` or `post_checks` — prose *and* generated table cells — goes through
`render_text`, and the result is HTML that must not be escaped again.

**The table macros.** `context.TABLE_MACROS` names the ten generated tables in chapter order:
`alarms`, `settings`, `maintenance_schedule`, `maintenance_procedures`, `troubleshooting`,
`technical_data`, `signals`, `normal_bands`, `parts`, `revision_history`, plus the
`figure(id, caption)` function. `context.Tables` renders them for the preview only: the PDF
build's templates under `templates/` replace it but keep the element ids, because every `ref()`
resolves against them — `alarm-<code>`, `setting-<id>`, `signal-<id>`, `part-<id>`, `fault-<id>`
on rows and `cond-<id>` / `task-<id>` on the headings `maintenance_procedures` and
`troubleshooting` generate.
`context.GENERATED_HEADING_MACROS` names those two, and `context.FIGURE_CHAPTER` fixes which
chapter each figure belongs to.

<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Mini manual fixture

Six fictional pages of a CAU-7 compressed-air unit, in the two layouts the
init service has to read. The PDFs are committed,
so the unit tests need neither WeasyPrint nor its native libraries; `build.sh`
is how they are regenerated and how CI proves they still match their source.

| File | What it is |
| --- | --- |
| `mini-manual.html` | the single source of both variants |
| `mini-manual.css` | the paged-media stylesheet, two named pages |
| `build.sh` | renders both PDFs; `--check` rebuilds and compares |
| `mini-manual-clean.pdf` | the easy document: one column, page numbers only |
| `mini-manual-realistic.pdf` | the hard one: running furniture, two columns, one spanning table |
| `expected.json` | what the extractor must read out of them |

Everything here is written for this repository: no brand, no model code, no
controller name and no sentence of any real manual. The identifiers and the
signal-move sentences follow the registries and the vocabulary of
[`manual/`](../../../../../manual/README.md), so the fixture exercises the same
grammar the real manual prints.
The content is CC BY 4.0, `build.sh` is Apache-2.0.

## Building

```bash
bash tools/init/tests/fixtures/mini-manual/build.sh          # rewrite both PDFs
bash tools/init/tests/fixtures/mini-manual/build.sh --check  # rebuild and compare, exit 1 on drift
```

`build.sh` pins `weasyprint==70.0` and `pdfplumber==0.11.10` through `uvx` and
exports `SOURCE_DATE_EPOCH=1700000000`, so two builds of an unchanged source
are byte-identical. `--check` compares the pdfplumber text page by page rather
than the bytes, because a rebuild on another machine may lay the objects out
differently and the text is what the init service reads.

On macOS the script exports `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`,
where Homebrew installs WeasyPrint's native libraries, and starts the renderer
as `python -m weasyprint` rather than through the `weasyprint` entry point: `uvx` generates a `/bin/sh` launcher for
a console script, and macOS strips every `DYLD_*` variable when it executes a
system binary, so the variable would never reach the renderer.

The typography is the manual's own IBM Plex, read from `manual/fonts/` through
a relative URL in the stylesheet; `--base-url` points the render back at this
directory so the generated variant HTML can live in a temporary directory. A
system font would move the page breaks `expected.json` pins.

## The two variants

One source. `class="clean"` on `<html>` selects the named page `clean`;
`build.sh` rewrites that one attribute for the second build. CSS cannot scope
an `@page` rule with a selector, which is why the page furniture is two named
pages rather than two stylesheets.

| Knob | `clean` | `realistic` |
| --- | --- | --- |
| Layout | single column | 8.1 in two columns |
| Troubleshooting | one table per condition under its own `8.2.k` heading, each whole on one page | one table with the header repeated, three `colspan=6` group rows, spanning two pages |
| Page furniture | `@bottom-center` page number | title top-left, running chapter top-right, `Rev. A · 2026-09-19` bottom-left, `page N of M` bottom-right |
| Footnote | folded into the sentence in parentheses | `float: footnote` with the limit `95 °C (203 °F)` |
| Units | SI | SI with imperial in parentheses |

Both variants print the same causes, alarms and signals, so `expected.json`
holds one `catalog` for both. The per-condition symptom paragraph exists in the
clean variant only, where the `8.2.k` headings it belongs under exist; the
realistic variant opens the same condition with a group row.

Two rules of the stylesheet look like details and are not:

- **No `background` on `<body>`.** WeasyPrint paints an element background as a
  filled rectangle, and a rectangle the size of the content area is four ruled
  edges to pdfplumber: `find_tables` with the `lines` strategy then returns one
  page-sized table that swallows every real table and every paragraph. The real
  manual's `base.css` does set it, which is why init removes a page-sized
  background rectangle before it searches for tables
  (`fdp_init/manual/tables.py`).
- **A near-white background on the cause rows of the spanning table.** A
  background is repainted on every fragment of a box, a border is not, so the
  fragment of the split row that stays on the first page would otherwise have
  side borders running to the foot of the text block and no bottom rule, and
  pdfplumber would drop it. With the background, `find_tables` returns the head
  of the split row on page 4 and its tail on page 5 — the row continuation init
  merges ([tables that span pages](../../../../../docs/manual.md#tables-that-span-pages)).

## What the fixture exercises

- Heading tree `1`, `3`, `4`, `8`, `8.1`, `8.2`, `9`, with `8.2.1`–`8.2.3` as
  headings in the clean variant and as group rows in the realistic one. The
  chapter numbers skip `2`, `5`, `6`, `7` and `10`: this is an excerpt, and the
  heading rule init applies must accept an increasing top-level number, not only the
  previous one plus one.
- Page furniture: the realistic variant repeats the revision stamp on all six
  pages and the running chapter of chapter 8 on three of them, which is what
  init's "at least three pages and 40 % of them" furniture rule is written for. The clean
  variant's furniture is the bare page number the same rule's regex catches.
- Tables of four kinds — `alarms`, `parameters`, `troubleshooting`, `signals` —
  with headers that hit init's
  [header-synonym profiles](../../../../../docs/manual.md#tables-and-header-synonym-profiles).
- The spanning merge: the troubleshooting table of the realistic variant is one
  table over pages 4 and 5 (`merged_from: 2`) with its header repeated, three
  group rows whose cells after the first are empty, and one data row
  (`oil_cooler_fouled`) cut by the page break.
- Identifiers that never wrap: `reservoir_isolation_valve_closed` is 32
  characters, and an identifier broken over two lines is lost to the extracted
  text, because pdfplumber reads a page line by line. The id columns are sized
  for it and the identifiers are set at an absolute size.

## Conventions `expected.json` follows

- `headings[].title` is the text after the section number exactly as printed.
  The `8.2.k` headings of the clean variant carry the condition id after the
  title, the way the real manual prints it (`table-troubleshooting.html.j2`),
  because slugging `Compressor starts and loads too often` would not give
  `frequent_cycling`. The catalog's condition title has the id token removed.
- `tables[].rows` counts data rows: no header row, and for a troubleshooting
  table no group rows. The two fragments of the split row count once.
- `subsystem` is the contracts' enum value. The PDF prints it with spaces for
  underscores (`intake unloading`), the way the real manual does.
- `signal_moves` use the manual's vocabulary verbatim: `falls`, `rises`,
  `high`, `low` for a signal and `higher` for the `load_cycle_rate` behaviour.
  `note` carries the recognised onset and phase, onset first, with `any` for
  "in every state", and is `null` when the sentence states neither.
- `chunks` counts what init's chunker cuts: one `text` chunk per section that has prose,
  one `list` chunk for the bullet list of 8.1, and one `table` chunk per data
  row (6 alarms + 4 parameters + 8 causes + 5 signals = 23).

<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# `fdp-manual-build`

Builds the fictional CAU-7 instruction manual from the YAML sources under
[`manual/`](../../manual) into its two PDFs, the clean and the realistic
variant, and exports the reference catalog the evaluation reads. What the build
produces and how the manual is checked is in
[`docs/manual.md`](../../docs/manual.md#building-the-pdfs).

## Modules

| Module | Does |
| --- | --- |
| `config.py` | `manual/build.yaml` → `BuildConfig` / `VariantConfig` |
| `model.py` | the frozen dataclasses every other module works on |
| `load.py`, `manual_tools.py` | `manual/spec/*.yaml` → `Manual`, through the manual's own loader, with schema validation and uniqueness checks |
| `numbering.py` | chapter partials → the `N.k[.m]` outline |
| `templating.py`, `markdown.py`, `units.py` | the Jinja layer over the manual's namespace, CommonMark → HTML with the footnote pass, and the reference number and unit formatter |
| `build.py` | one HTML document per variant, rendered in turn, then the catalog and the manifest |
| `render.py` | one HTML string → PDF bytes, on WeasyPrint's pinned options |
| `export.py` | `tools/eval/fixtures/catalog.json`, the reference catalog |
| `scanned.py` | the optional image-only copy for OCR tests |
| `manifest.py` | `data/manual/build-manifest.json`, and the diff of two builds |
| `checks/` | `fdp-manual-check`: the eleven acceptance checks and their report |
| `cli.py` | `fdp-manual-build build \| render \| export-catalog \| check \| scanned` |

Every subcommand lives in its own module and is imported only when it runs, so
one subcommand never loads another's dependencies.

## Building

The committed PDFs come out of the pinned container that `Dockerfile` builds,
never off a developer's machine: WeasyPrint's line breaking depends on the Pango and
HarfBuzz versions, and macOS and Debian trixie ship different ones. All four
targets are `.PHONY` in the root `Makefile`.

| Target | Does |
| --- | --- |
| `make manual-image` | `docker build -f tools/manual-build/Dockerfile -t $(MANUAL_IMAGE) .` from the repository root; `MANUAL_IMAGE` defaults to `fdp-manual-build:local` |
| `make manual` | builds the image, then runs `build` in it as the invoking user with the checkout mounted at `/work`; writes `data/manual/*.pdf`, the manifest and the catalog |
| `make manual-native` | the fast path for iteration: `build --out-dir tools/manual-build/.build/native --no-catalog`, never into `data/manual/`. It sets `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`, without which WeasyPrint cannot load GObject on macOS |
| `make manual-html` | writes the intermediate HTML and stops, so the layout can be iterated in a browser |

`make manual-scanned` writes the image-only OCR test copy in the same image, and
`make check-manual` runs the acceptance checks. `render` turns one prepared HTML
file into a PDF and is what the container tests use:

```sh
uv run --package fdp-manual-build fdp-manual-build render \
    --html tools/manual-build/tests/fixtures/html/sample.html \
    --out tools/manual-build/.build/probe.pdf --variant clean
```

Two environment variables steer the render:

- `FDP_MANUAL_ALLOW_MISSING_CSS=1` downgrades a missing stylesheet or a missing
  `manual/fonts/fonts.json` to a warning. The renderer tests set it so they can
  render a fixture without the manual's stylesheets. A real build never sets
  it — a manual rendered in a fallback font is not reproducible.
- `FDP_BUILD_IN_CONTAINER=1`, with `FDP_BUILD_IMAGE_REF` and
  `FDP_BUILD_IMAGE_DIGEST`, is set by the Dockerfile and is how
  `manifest.py` decides between `built_in: container` and `built_in: native`.
  The image also writes `/etc/fdp-system-packages.txt`, which the manifest
  records so a security rebuild that moves Pango is visible.

BuildKit resolves the build context's ignore list from
`tools/manual-build/Dockerfile.dockerignore`, which is a symlink to
`tools/manual-build/.dockerignore` next to it. The root `.dockerignore` serves
the stack's service images; this image needs a narrower list of its own.

## Where the contracts live

- **Field names, schemas and the authoring contract** belong to the manual
  sources, so the manual and its build cannot disagree on a field. The loader
  wraps `manual/tools/load.py`, which validates every document against
  `manual/spec/schemas/*.schema.json`; this package never defines a source
  schema of its own.
- **The Jinja namespace, the cross-reference labels and the outline** are those
  of `manual/tools/context.py`, which `templating.py` imports, so the preview
  and the PDF derive their numbers from one implementation. Chapter partials use
  `## Title {#sec:anchor}` headings, `{{ val(...) }}`, `{{ ref(...) }}`,
  `{{ tables.x() }}` and `{{ figure(id, caption) }}`; prose never types a
  number. [`manual/README.md`](../../manual/README.md) describes the grammar.
- **`manual/build.yaml`** belongs to the manual sources too. The build reads its
  `pdf:` block (`pdf_identifier`, `page_budget`, `outputs.manifest`,
  `outputs.catalog`) and its variant knobs.

## Running the tests

From the repository root:

```sh
uv sync --all-packages
uv run --package fdp-manual-build pytest tools/manual-build \
    -m "not weasyprint and not docker and not sources" -q
```

Markers: `weasyprint` needs a working Pango/Cairo stack, `docker` builds an
image, and `sources` reads the real `manual/spec` tree (it skips when the
sources are not in the checkout). Run everything with plain `-m ""`.

Lint and types:

```sh
uv run ruff check tools/manual-build
uv run ruff format --check tools/manual-build
uv run mypy tools/manual-build/src
uv run lint-imports
```

## The mini fixture

`tests/fixtures/mini-spec/` is a complete but tiny manual tree — four signals,
four controller messages, three conditions over five causes, two maintenance
tasks, two programmable settings and ten one-paragraph chapter partials. It is
written in the manual's grammar and validated against the **real** schemas under
`manual/spec/schemas`, so a field-name change in the sources fails here loudly
instead of silently drifting. Its content is CC BY 4.0 and entirely fictional.

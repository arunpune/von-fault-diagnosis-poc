#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Builds the two mini-manual fixture PDFs from mini-manual.html (docs/plan/
# init.md §15.1). The PDFs are committed, so the unit tests of the init service
# need neither WeasyPrint nor its native libraries; this script is how they are
# regenerated and how CI proves they still match their source.
#
#   ./build.sh            rebuild mini-manual-clean.pdf and mini-manual-realistic.pdf
#   ./build.sh --check    rebuild into a temporary directory and compare the
#                         pdfplumber text of both variants with the committed
#                         PDFs; exit 1 on any difference
#
# The variant is one attribute: `class="clean"` on <html> selects the named
# page `clean` of mini-manual.css, and this script rewrites it to `realistic`
# for the second build. Both renders read the stylesheet, the fonts and the
# figures through `--base-url`, which points back at this directory, so the
# generated HTML can live in a temporary directory without copying anything.
#
# SOURCE_DATE_EPOCH fixes the PDF's creation date, so two builds of unchanged
# sources are byte-identical (ADR 0022).
#
# macOS (decision R-75): WeasyPrint reaches GObject, Pango and Cairo through
# dlopen, and Homebrew installs them outside the loader's default search path.
# DYLD_FALLBACK_LIBRARY_PATH names it. The variable does not survive the
# `/bin/sh` launcher that `uvx` generates for a console script — macOS strips
# every DYLD_* variable when it executes a system binary — so the renderer is
# started as `python -m weasyprint` from the same pinned environment instead of
# through the `weasyprint` entry point. The variable is meaningless on Linux,
# where the loader finds the libraries itself.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly SOURCE_HTML="$HERE/mini-manual.html"
readonly WEASYPRINT_PIN="weasyprint==70.0"
readonly PDFPLUMBER_PIN="pdfplumber==0.11.10"
readonly VARIANTS=(clean realistic)

export SOURCE_DATE_EPOCH=1700000000

if [ "$(uname -s)" = "Darwin" ]; then
  export DYLD_FALLBACK_LIBRARY_PATH="${DYLD_FALLBACK_LIBRARY_PATH:-/opt/homebrew/lib}"
fi

fail() {
  printf 'build.sh: %s\n' "$1" >&2
  exit 1
}

# render <variant> <output-pdf>
render() {
  local variant="$1" out="$2" html
  html="$(mktemp -t "mini-manual-$variant.XXXXXX")"
  # The only difference between the two sources is the class on <html>.
  sed "s/<html lang=\"en\" class=\"clean\">/<html lang=\"en\" class=\"$variant\">/" \
    "$SOURCE_HTML" >"$html"
  grep -q "class=\"$variant\"" "$html" || fail "variant $variant not selected in the generated HTML"
  uvx --from "$WEASYPRINT_PIN" python -m weasyprint \
    --base-url "$HERE/" "$html" "$out"
  rm -f "$html"
}

build() {
  local out_dir="$1" variant
  for variant in "${VARIANTS[@]}"; do
    render "$variant" "$out_dir/mini-manual-$variant.pdf"
  done
}

# Set by check(); the EXIT trap reads it, so it cannot be a local.
WORK_DIR=""
cleanup() {
  # An `if`, not a short-circuit: the last status of an EXIT trap becomes the
  # script's exit status, and `[ -n "" ]` is a failure.
  if [ -n "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

check() {
  local committed rebuilt variant status=0 work
  WORK_DIR="$(mktemp -d -t mini-manual-check.XXXXXX)"
  work="$WORK_DIR"

  for variant in "${VARIANTS[@]}"; do
    committed="$HERE/mini-manual-$variant.pdf"
    [ -f "$committed" ] || fail "missing committed PDF: $committed"
  done

  build "$work"

  for variant in "${VARIANTS[@]}"; do
    committed="$HERE/mini-manual-$variant.pdf"
    rebuilt="$work/mini-manual-$variant.pdf"
    if uvx --from "$PDFPLUMBER_PIN" python -c "$COMPARE_PY" "$variant" "$committed" "$rebuilt"; then
      printf 'build.sh: %s text matches the committed PDF\n' "$variant"
    else
      status=1
    fi
  done

  return "$status"
}

# Compares the pdfplumber text of two PDFs page by page. Text, not bytes: a
# rebuild on another machine may lay the objects out differently, and what the
# init service reads is the text.
read -r -d '' COMPARE_PY <<'PY' || true
import sys

import pdfplumber


def pages(path: str) -> list[str]:
    with pdfplumber.open(path) as pdf:
        return [page.extract_text() or "" for page in pdf.pages]


variant, committed, rebuilt = sys.argv[1:4]
left, right = pages(committed), pages(rebuilt)

if len(left) != len(right):
    print(f"{variant}: page count {len(left)} != {len(right)}", file=sys.stderr)
    raise SystemExit(1)

for number, (a, b) in enumerate(zip(left, right, strict=True), start=1):
    if a != b:
        print(f"{variant}: page {number} differs", file=sys.stderr)
        for line_a, line_b in zip(a.splitlines(), b.splitlines(), strict=False):
            if line_a != line_b:
                print(f"  committed: {line_a!r}", file=sys.stderr)
                print(f"  rebuilt:   {line_b!r}", file=sys.stderr)
                break
        raise SystemExit(1)
PY

main() {
  [ -f "$SOURCE_HTML" ] || fail "missing source: $SOURCE_HTML"
  case "${1-}" in
    --check)
      check
      ;;
    "")
      build "$HERE"
      printf 'build.sh: wrote mini-manual-clean.pdf and mini-manual-realistic.pdf\n'
      ;;
    *)
      fail "unknown argument: $1 (expected --check or nothing)"
      ;;
  esac
}

main "$@"

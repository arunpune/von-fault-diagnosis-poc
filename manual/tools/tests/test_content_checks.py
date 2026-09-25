# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Rule tests for content_checks.py.

The committed ``fixtures/content-minimal`` partials over ``fixtures/spec-minimal``
are the passing baseline; every rule that content_checks owns (N1, N3, C1-C6)
then gets a mutation that must make it fire, so a rule cannot
silently stop working::

    uv run --no-project --with-requirements manual/tools/requirements.txt \\
        pytest manual/tools/tests/test_content_checks.py -q
"""

from __future__ import annotations

import contextlib
import io
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import content_checks  # noqa: E402  (the sys.path shim above must run first)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SPEC_MINIMAL = FIXTURES / "spec-minimal"
CONTENT_MINIMAL = FIXTURES / "content-minimal"
REPO_ROOT = TOOLS.parents[1]

#: A well-formed SVG that only misses the viewBox rule.
BAD_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="100mm">\n'
    "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n"
    "     SPDX-License-Identifier: CC-BY-4.0 -->"
    "\n</svg>\n"
)

#: A stand-in for scripts/blocklist.sh that always reports one hit.
STUB_SCANNER = """#!/bin/sh
cat <<'JSON'
{"hits": [{"path": "manual/content/02-description.md", "line": 7, "col": 1,
           "term": "synthetic-brand", "section": "manufacturer", "context": "x"}],
 "text_files": 1, "pdf_files": 0, "digests": 1, "patterns": 0, "list": "stub"}
JSON
exit 1
"""


@pytest.fixture
def content(tmp_path: Path) -> Path:
    """A writable copy of the committed content fixture."""
    target = tmp_path / "content"
    shutil.copytree(CONTENT_MINIMAL, target)
    return target


def edit(path: Path, old: str, new: str) -> None:
    """Replace the single occurrence of ``old`` in ``path``."""
    text = path.read_text(encoding="utf-8")
    assert text.count(old) == 1, f"{old!r} appears {text.count(old)} times in {path.name}"
    path.write_text(text.replace(old, new), encoding="utf-8")


def run(
    content_dir: Path,
    *extra: str,
    spec: Path = SPEC_MINIMAL,
    blocklist: str | None = "missing/blocklist.sh",
) -> tuple[int, list[str]]:
    """Run the CLI in process and return ``(exit code, printed lines)``."""
    argv = [
        "--spec",
        str(spec),
        "--content",
        str(content_dir),
        "--variant",
        "both",
        *extra,
    ]
    if blocklist is not None:
        argv += ["--blocklist-cmd", blocklist]
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = content_checks.main(argv)
    return code, buffer.getvalue().splitlines()


def rules(lines: list[str]) -> list[str]:
    """The rule id of every finding line."""
    noise = ("SKIP", "NOTICE", "content_checks:")
    return [line.split(" ", 1)[0] for line in lines if not line.startswith(noise)]


# --- the passing baseline -------------------------------------------------


def test_the_fixture_passes_every_rule(content: Path) -> None:
    code, lines = run(content)
    assert rules(lines) == []
    assert code == 0


def test_the_fixture_passes_with_the_real_blocklist_scanner(content: Path) -> None:
    scanner = REPO_ROOT / "scripts" / "blocklist.sh"
    if not scanner.is_file():
        pytest.skip("scripts/blocklist.sh is not present in this checkout")
    code, lines = run(content, blocklist=scanner.as_posix())
    assert [line for line in lines if line.startswith("SKIP N3")] == []
    assert rules(lines) == []
    assert code == 0


def test_the_cli_reports_no_findings_over_the_repository_manual() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(TOOLS / "content_checks.py"),
            "--spec",
            str(SPEC_MINIMAL),
            "--content",
            str(CONTENT_MINIMAL),
            "--variant",
            "both",
            "--blocklist-cmd",
            "missing/blocklist.sh",
        ],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "no findings" in completed.stdout


def test_a_partial_content_set_skips_the_whole_document_rules(content: Path) -> None:
    _, lines = run(content)
    skipped = [line for line in lines if line.startswith("SKIP")]
    assert any(line.startswith("SKIP C4") for line in skipped)
    assert any(line.startswith("SKIP C5") for line in skipped)


def test_chapters_limits_the_per_chapter_rules(content: Path) -> None:
    edit(content / "03-controller.md", "## Display {#sec:controller-display}", "## Display")
    assert run(content)[0] == 1
    code, lines = run(content, "--chapters", "2")
    assert [line for line in lines if line.startswith("C2")] == []
    assert code == 0


def test_a_requested_chapter_without_a_partial_is_a_notice(content: Path) -> None:
    code, lines = run(content, "--chapters", "2,5")
    assert code == 0
    assert any(line.startswith("NOTICE chapter 5 has no partial") for line in lines)


# --- rule N1 --------------------------------------------------------------


def test_N1_fires_on_a_hand_typed_number_with_a_unit(content: Path) -> None:  # noqa: N802
    edit(
        content / "02-description.md",
        "The unit never works above",
        "The unit runs at 10 bar and never works above",
    )
    code, lines = run(content)
    assert code == 1
    found = [line for line in lines if line.startswith("N1")]
    assert len(found) == 1
    assert found[0].endswith("02-description.md line 9: has the number with unit '10 bar'")


def test_N1_ignores_a_number_inside_a_jinja_expression(content: Path) -> None:  # noqa: N802
    edit(
        content / "02-description.md",
        "The unit never works above",
        "The unit never works above {{ num(10.0, 'bar') }} or above",
    )
    code, lines = run(content)
    assert [line for line in lines if line.startswith("N1")] == []
    assert code == 0


def test_N1_honours_the_allowed_phrases(content: Path, tmp_path: Path, mutate: Any) -> None:  # noqa: N802
    edit(
        content / "02-description.md",
        "The unit never works above",
        "The unit is a 7 bar class machine and never works above",
    )
    assert run(content)[0] == 1
    allowed = mutate(SPEC_MINIMAL, tmp_path, "build", "/lint/allowed_number_phrases", ["7 bar"])
    code, lines = run(content, spec=allowed)
    assert [line for line in lines if line.startswith("N1")] == []
    assert code == 0


def test_N1_fires_on_a_number_with_a_unit_in_an_svg_text(  # noqa: N802
    content: Path, tmp_path: Path
) -> None:
    figures = tmp_path / "figures"
    figures.mkdir()
    (figures / "control-panel.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="100mm">'
        "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n"
        "     SPDX-License-Identifier: CC-BY-4.0 -->"
        "<text>95 °C</text></svg>\n",
        encoding="utf-8",
    )
    code, lines = run(content, "--figures", str(figures))
    assert code == 1
    assert any(line.startswith("N1") and "95 °C" in line for line in lines)


def test_N1_fires_on_a_yaml_text_field(content: Path, tmp_path: Path, mutate: Any) -> None:  # noqa: N802
    broken = mutate(
        SPEC_MINIMAL,
        tmp_path,
        "maintenance",
        "/tasks/0/steps/2",
        "Refill with 8 L of the specified oil grade up to the mark.",
    )
    code, lines = run(content, spec=broken)
    assert code == 1
    assert any(line.startswith("N1") and "/tasks/0/steps/2" in line for line in lines)


# --- rule N3 --------------------------------------------------------------


def test_N3_maps_the_scanner_hits_to_findings(content: Path, tmp_path: Path) -> None:  # noqa: N802
    scanner = tmp_path / "stub-blocklist.sh"
    scanner.write_text(STUB_SCANNER, encoding="utf-8")
    scanner.chmod(0o755)
    code, lines = run(content, blocklist=scanner.as_posix())
    assert code == 1
    assert [line for line in lines if line.startswith("N3")] == [
        "N3 file:manual/content/02-description.md line 7: has the blocked term 'synthetic-brand'"
    ]


def test_N3_skips_when_the_scanner_is_absent(content: Path) -> None:  # noqa: N802
    code, lines = run(content, blocklist="missing/blocklist.sh")
    assert code == 0
    assert any(line.startswith("SKIP N3") for line in lines)


def test_N3_reports_a_scanner_that_fails(content: Path, tmp_path: Path) -> None:  # noqa: N802
    scanner = tmp_path / "broken-blocklist.sh"
    scanner.write_text("#!/bin/sh\necho 'no such list' >&2\nexit 2\n", encoding="utf-8")
    scanner.chmod(0o755)
    code, lines = run(content, blocklist=scanner.as_posix())
    assert code == 1
    assert any(line.startswith("N3") and "exited 2" in line for line in lines)


# --- rule C1 --------------------------------------------------------------


def test_C1_fires_on_a_cross_reference_to_an_unknown_anchor(content: Path) -> None:  # noqa: N802
    edit(content / "02-description.md", "ref('ch:3')", "ref('sec:nowhere')")
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C1") and "sec:nowhere" in line for line in lines)


def test_C1_fires_on_an_undefined_name(content: Path) -> None:  # noqa: N802
    edit(content / "08-troubleshooting.md", "{{ sig('line_pressure') }}", "{{ not_a_name }}")
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C1") and "not_a_name" in line for line in lines)


def test_C1_fires_on_a_broken_yaml_text_field(content: Path, tmp_path: Path, mutate: Any) -> None:  # noqa: N802
    broken = mutate(
        SPEC_MINIMAL, tmp_path, "faults", "/causes/0/remedy", "Clean {{ sig('not_a_signal') }}."
    )
    code, lines = run(content, spec=broken)
    assert code == 1
    assert any(line.startswith("C1") and "/causes/0/remedy" in line for line in lines)


# --- rule C2 --------------------------------------------------------------


def test_C2_fires_on_a_missing_required_anchor(content: Path) -> None:  # noqa: N802
    edit(content / "02-description.md", "## Cooling {#sec:cooling}", "## Cooling {#sec:cool}")
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C2") and "required anchor 'sec:cooling'" in line for line in lines)


def test_C2_fires_on_a_heading_without_an_anchor(content: Path) -> None:  # noqa: N802
    edit(content / "03-controller.md", "## Display {#sec:controller-display}", "## Display")
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C2") and "has no anchor" in line for line in lines)


def test_C2_fires_when_a_subsection_comes_before_any_section(content: Path) -> None:  # noqa: N802
    path = content / "08-troubleshooting.md"
    path.write_text(
        "### Early {#sec:troubleshooting-early}\n\n" + path.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C2") and "comes before any `##`" in line for line in lines)


def test_C2_fires_on_a_repeated_anchor(content: Path) -> None:  # noqa: N802
    edit(
        content / "03-controller.md",
        "## Message types {#sec:message-types}",
        "## Message types {#sec:message-types}\n\nx\n\n## Again {#sec:message-types}",
    )
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C2") and "is repeated" in line for line in lines)


# --- rule C3 --------------------------------------------------------------


def test_C3_fires_when_a_macro_appears_twice(content: Path) -> None:  # noqa: N802
    edit(
        content / "03-controller.md",
        "{{ tables.alarms() }}",
        "{{ tables.alarms() }}\n\n{{ tables.alarms() }}",
    )
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C3") and "2 time(s)" in line for line in lines)


def test_C3_fires_when_a_macro_is_missing(content: Path) -> None:  # noqa: N802
    edit(content / "08-troubleshooting.md", "{{ tables.troubleshooting() }}", "")
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C3") and "0 time(s)" in line for line in lines)


def test_C3_fires_when_a_macro_sits_in_the_wrong_chapter(content: Path) -> None:  # noqa: N802
    edit(
        content / "02-description.md",
        "## Overview {#sec:overview}",
        "## Overview {#sec:overview}\n\n{{ tables.alarms() }}",
    )
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C3") and "belongs in chapter 3" in line for line in lines)


def test_C3_fires_on_a_figure_in_the_wrong_chapter(content: Path) -> None:  # noqa: N802
    edit(
        content / "08-troubleshooting.md",
        "## After a repair {#sec:after-repair}",
        "## After a repair {#sec:after-repair}\n\n{{ figure('control-panel', 'Panel') }}",
    )
    code, lines = run(content)
    assert code == 1
    assert any(line.startswith("C3") and "'control-panel'" in line for line in lines)


# --- rule C4 --------------------------------------------------------------


def test_C4_fires_on_a_chapter_below_its_word_budget(content: Path) -> None:  # noqa: N802
    code, lines = run(content, "--whole-document", "on")
    assert code == 1
    budget = [line for line in lines if line.startswith("C4")]
    assert any("02-description.md" in line and "budget 1500-2000" in line for line in budget)


def test_C4_counts_prose_without_the_generated_tables(content: Path) -> None:  # noqa: N802
    _, lines = run(content, "--whole-document", "on")
    reported = next(line for line in lines if line.startswith("C4") and "03-controller" in line)
    words = int(reported.split(" has ")[1].split(" ")[0])
    # The alarm table holds four messages; counting it would blow past the floor.
    assert 0 < words < 700


# --- rule C5 --------------------------------------------------------------


def test_C5_passes_when_every_prose_only_fact_is_stated(content: Path) -> None:  # noqa: N802
    _, lines = run(content, "--whole-document", "on")
    assert [line for line in lines if line.startswith("C5")] == []


def test_C5_fires_when_a_prose_only_fact_is_never_stated(content: Path) -> None:  # noqa: N802
    edit(
        content / "02-description.md",
        "{% if fact_in_prose('setting:restart_delay') %}",
        "{% if fact_in_table('setting:restart_delay') %}",
    )
    code, lines = run(content, "--whole-document", "on")
    assert code == 1
    assert any(line.startswith("C5") and "setting:restart_delay" in line for line in lines)


def test_C5_fires_when_a_table_only_fact_is_stated_in_prose(  # noqa: N802
    content: Path, tmp_path: Path, mutate: Any
) -> None:
    pointer = "/variants/realistic/table_only"
    spec = mutate(SPEC_MINIMAL, tmp_path, "build", pointer, ["setting:cut_in_pressure"])
    edit(
        content / "02-description.md",
        "It loads when",
        "It loads at {{ val('cut_in_pressure') }} when",
    )
    code, lines = run(content, spec=spec)
    assert code == 1
    assert any(
        line.startswith("C5") and "table-only fact 'setting:cut_in_pressure'" in line
        for line in lines
    )


# --- rule C6 --------------------------------------------------------------


def test_C6_fires_on_a_figure_that_breaks_the_svg_rules(  # noqa: N802
    content: Path, tmp_path: Path
) -> None:
    figures = tmp_path / "figures"
    figures.mkdir()
    (figures / "control-panel.svg").write_text(BAD_SVG, encoding="utf-8")
    code, lines = run(content, "--figures", str(figures))
    assert code == 1
    assert any(line.startswith("C6") and "no viewBox" in line for line in lines)


def test_C6_skips_when_there_is_no_figure(content: Path, tmp_path: Path) -> None:  # noqa: N802
    empty = tmp_path / "no-figures"
    empty.mkdir()
    code, lines = run(content, "--figures", str(empty))
    assert code == 0
    assert any(line.startswith("SKIP C6") for line in lines)


def test_C6_accepts_a_figure_that_follows_the_rules(  # noqa: N802
    content: Path, tmp_path: Path
) -> None:
    figures = tmp_path / "figures"
    figures.mkdir()
    (figures / "control-panel.svg").write_text(
        BAD_SVG.replace('width="100mm"', 'viewBox="0 0 10 10" width="100mm"'), encoding="utf-8"
    )
    code, lines = run(content, "--figures", str(figures))
    assert [line for line in lines if line.startswith("C6")] == []
    assert code == 0

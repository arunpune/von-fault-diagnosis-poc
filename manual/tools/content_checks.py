#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Text-level validation of the CAU-7 manual.

Implements the source rules (docs/manual.md lists them all) that need the
rendered text: N1 (number lint), N3 (brand blocklist) and C1-C6
(StrictUndefined rendering and cross-references, anchors, macros and figures,
word budget, fact placement, SVG rules). The spec-level rules live in
``manual/tools/validate.py``.

Usage::

    uv run --no-project --with-requirements manual/tools/requirements.txt \\
        python manual/tools/content_checks.py --spec manual --variant both

Every failure prints one line ``RULE file:<path> <message>`` and the process
exits 1, the format and exit code of ``validate.py`` and ``figure_checks.py``.
A rule whose input is absent prints ``SKIP <rule> <reason>`` and does not fail
the run.

Rule N3 never holds a term list: it runs the repository's brand blocklist
scanner, by default ``scripts/blocklist.sh``, and maps its JSON hits to N3
findings.

Two of the rules are whole-document constraints: C4 (the word budget per
chapter) and the "every prose-only fact is stated somewhere" half of C5. They
can only be judged on a complete set of partials, so ``--whole-document`` gates
them and its default, ``auto``, runs them exactly when every chapter of
``build.yaml`` has a partial. That keeps a ``--chapters`` run over a partial
content set honest instead of noisy.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jinja2

if __package__ in (None, ""):  # running as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from context import (
    FIGURE_CHAPTER,
    MACRO_PATTERN,
    ContextError,
    Outline,
    build_outline,
    make_env,
    render_partial,
    render_text,
    variant_knobs,
)
from figure_checks import (
    NUMBER_LINT,
    builtin_component_ids,
    builtin_signal_ids,
    check_svg,
)
from load import Spec, SpecError, load_spec

__all__ = [
    "MACRO_CHAPTER",
    "REQUIRED_ANCHORS",
    "TEXT_KEYS",
    "WORD_BUDGET",
    "Finding",
    "main",
    "read_partials",
    "run_checks",
]

#: The text fields that may hold Jinja and must pass N1.
TEXT_KEYS: frozenset[str] = frozenset(
    {
        "description",
        "summary",
        "symptom",
        "checks",
        "remedy",
        "steps",
        "note",
        "cause_hint",
        "operator_action",
        "post_checks",
        "safety",
    }
)

#: Anchor registry: the headings every chapter must carry.
REQUIRED_ANCHORS: Mapping[int, tuple[str, ...]] = {
    1: (
        "sec:safety-general",
        "sec:safety-pressure",
        "sec:safety-electrical",
        "sec:safety-hot-surfaces",
        "sec:safety-signs",
    ),
    2: (
        "sec:overview",
        "sec:air-flow",
        "sec:oil-circuit",
        "sec:cooling",
        "sec:drying",
        "sec:regulation",
        "sec:schematic",
    ),
    3: (
        "sec:controller-display",
        "sec:controller-keys",
        "sec:message-types",
        "sec:message-list",
        "sec:acknowledging",
    ),
    4: ("sec:settings-access", "sec:settings-table", "sec:settings-rules"),
    5: (
        "sec:installation-site",
        "sec:reference-conditions",
        "sec:electrical-connection",
        "sec:air-connection",
        "sec:commissioning",
    ),
    6: (
        "sec:starting",
        "sec:stopping",
        "sec:normal-cycle",
        "sec:checks-during-operation",
        "sec:dryer-operation",
    ),
    7: ("sec:maintenance-safety", "sec:maintenance-schedule", "sec:maintenance-procedures"),
    8: ("sec:troubleshooting-how-to", "sec:troubleshooting-tables", "sec:after-repair"),
    9: ("sec:technical-data", "sec:signal-list", "sec:normal-bands", "sec:parts"),
    10: ("sec:glossary", "sec:revision-history", "sec:license-notice", "sec:data-credit"),
}

#: Where each generated table must appear exactly once.
MACRO_CHAPTER: Mapping[str, int] = {
    "alarms": 3,
    "settings": 4,
    "maintenance_schedule": 7,
    "maintenance_procedures": 7,
    "troubleshooting": 8,
    "technical_data": 9,
    "signals": 9,
    "normal_bands": 9,
    "parts": 9,
    "revision_history": 10,
}

#: Prose word budget per chapter, tables excluded.
WORD_BUDGET: Mapping[int, tuple[int, int]] = {
    1: (400, 600),
    2: (1500, 2000),
    3: (700, 1000),
    4: (400, 600),
    5: (700, 1000),
    6: (1000, 1400),
    7: (900, 1300),
    8: (700, 1000),
    9: (300, 500),
    10: (300, 500),
}

_JINJA = re.compile(r"\{\{.*?\}\}|\{%.*?%\}|\{##.*?##\}|\{#.*?#\}", re.DOTALL)
_FIGURE_CALL = re.compile(r"\{\{\s*figure\(\s*['\"]([a-z0-9-]+)['\"].*?\)\s*\}\}", re.DOTALL)
_REF_CALL = re.compile(r"\bref\(\s*['\"]([^'\"]+)['\"]\s*\)")
_HEADING_LINE = re.compile(r"^(#{1,6})\s+(.*)$")
_ANCHOR_SUFFIX = re.compile(r"\{#([a-z0-9:_-]+)\}\s*$")
_HTML_TAG = re.compile(r"<[^>]+>")
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’-]*")  # noqa: RUF001 - either apostrophe
_PARTIAL_NAME = re.compile(r"^(\d{2})-[a-z0-9-]+\.md$")
_SVG_TEXT = re.compile(r"<(text|title|desc)\b[^>]*>(.*?)</\1>", re.DOTALL)


@dataclass(frozen=True, slots=True)
class Finding:
    """One rule violation, addressed by file."""

    rule: str
    file: str
    message: str

    def __str__(self) -> str:
        return f"{self.rule} file:{self.file} {self.message}"


@dataclass(frozen=True, slots=True)
class Options:
    """The command line, resolved to paths and variant names."""

    spec_root: Path
    content_dir: Path
    figures_dir: Path
    variants: tuple[str, ...]
    chapters: tuple[int, ...] | None
    whole_document: str
    blocklist_cmd: Path

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> Options:
        """Resolve the parsed command line, applying the path defaults."""
        spec_root = Path(args.spec)
        return cls(
            spec_root=spec_root,
            content_dir=Path(args.content) if args.content else spec_root / "content",
            figures_dir=Path(args.figures) if args.figures else spec_root / "figures",
            variants=("clean", "realistic") if args.variant == "both" else (args.variant,),
            chapters=None if args.chapters is None else tuple(args.chapters),
            whole_document=str(args.whole_document),
            blocklist_cmd=Path(args.blocklist_cmd),
        )


@dataclass(frozen=True, slots=True)
class Inputs:
    """Everything the rules read, resolved once by :func:`gather`."""

    spec: Spec
    spec_root: Path
    content_dir: Path
    figures_dir: Path
    partials: Mapping[int, str]
    partial_paths: Mapping[int, Path]
    outline: Outline
    variants: tuple[str, ...]
    chapters: tuple[int, ...]
    whole_document: bool
    blocklist_cmd: Path


# --- helpers --------------------------------------------------------------


def _blank(text: str) -> str:
    """Replace ``text`` with spaces, keeping newlines so offsets stay valid."""
    return "".join("\n" if character == "\n" else " " for character in text)


def _strip_jinja(text: str, allowed_phrases: Sequence[str] = ()) -> str:
    """Blank out Jinja delimiters and the allowed phrases, keeping offsets."""
    for phrase in allowed_phrases:
        if phrase:
            text = text.replace(phrase, _blank(phrase))
    return _JINJA.sub(lambda match: _blank(match.group(0)), text)


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _lint_numbers(text: str, allowed: Sequence[str]) -> Iterator[tuple[int, str]]:
    """Yield ``(line, matched text)`` for every number with a unit."""
    stripped = _strip_jinja(text, allowed)
    for match in NUMBER_LINT.finditer(stripped):
        yield _line_of(stripped, match.start()), match.group(0)


def _walk_text_fields(node: Any, pointer: str = "") -> Iterator[tuple[str, str]]:
    """Yield ``(json pointer, value)`` for every text field."""
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{pointer}/{key}"
            if key in TEXT_KEYS and isinstance(value, str):
                yield child, value
            elif key in TEXT_KEYS and isinstance(value, list):
                for index, item in enumerate(value):
                    if isinstance(item, str):
                        yield f"{child}/{index}", item
            else:
                yield from _walk_text_fields(value, child)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            yield from _walk_text_fields(item, f"{pointer}/{index}")


def _allowed_phrases(spec: Spec) -> tuple[str, ...]:
    lint = (spec.build or {}).get("lint") or {}
    return tuple(str(phrase) for phrase in lint.get("allowed_number_phrases") or ())


def read_partials(content_dir: Path) -> tuple[dict[int, str], dict[int, Path]]:
    """Read ``NN-<slug>.md`` from ``content_dir``, keyed by chapter number."""
    texts: dict[int, str] = {}
    paths: dict[int, Path] = {}
    if not content_dir.is_dir():
        return texts, paths
    for path in sorted(content_dir.glob("*.md")):
        match = _PARTIAL_NAME.match(path.name)
        if match is None:
            continue
        chapter = int(match.group(1))
        texts[chapter] = path.read_text(encoding="utf-8")
        paths[chapter] = path
    return texts, paths


def _prose(text: str) -> str:
    """The prose of a partial: macros, figures, Jinja, tables and markup gone."""
    without_macros = MACRO_PATTERN.sub("", _FIGURE_CALL.sub("", text))
    body = _JINJA.sub(" ", without_macros)
    body = _HTML_COMMENT.sub(" ", body)
    lines = [line for line in body.splitlines() if not line.lstrip().startswith("|")]
    joined = "\n".join(lines)
    joined = _HTML_TAG.sub(" ", joined)
    joined = _ANCHOR_SUFFIX.sub("", joined)
    return re.sub(r"^#{1,6}\s*", "", joined, flags=re.MULTILINE)


def _rendered_prose(inputs: Inputs, variant: str, chapter: int) -> str:
    """Render a partial without its tables and figures, for the word budget."""
    text = MACRO_PATTERN.sub("", _FIGURE_CALL.sub("", inputs.partials[chapter]))
    environment = make_env(inputs.spec, variant, inputs.outline)
    return _prose(render_partial(environment, chapter, text))


def _count_words(text: str) -> int:
    return len(_WORD.findall(text))


def _relative(path: Path) -> str:
    """A repository-relative path when possible, for readable findings."""
    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.as_posix()


# --- rule N1 --------------------------------------------------------------


def rule_N1(inputs: Inputs) -> list[Finding]:  # noqa: N802 - the published rule id
    """Number lint on YAML text fields, partials and SVG text."""
    allowed = _allowed_phrases(inputs.spec)
    findings: list[Finding] = []
    for key in sorted(inputs.spec.files_present):
        document = inputs.spec.document(key)
        if document is None:
            continue
        path = (inputs.spec_root / inputs.spec.path_of(key)).as_posix()
        for pointer, value in _walk_text_fields(document):
            findings += [
                Finding("N1", path, f"at {pointer}: has the number with unit {hit!r}")
                for _, hit in _lint_numbers(value, allowed)
            ]
    for chapter, text in sorted(inputs.partials.items()):
        path = _relative(inputs.partial_paths[chapter])
        findings += [
            Finding("N1", path, f"line {line}: has the number with unit {hit!r}")
            for line, hit in _lint_numbers(text, allowed)
        ]
    for figure in _svg_files(inputs.figures_dir):
        raw = figure.read_text(encoding="utf-8")
        for element in _SVG_TEXT.finditer(raw):
            content = _HTML_TAG.sub("", element.group(2))
            findings += [
                Finding("N1", _relative(figure), f"has the number with unit {hit!r} in <text>")
                for _, hit in _lint_numbers(content, allowed)
            ]
    return findings


# --- rule N3 --------------------------------------------------------------


def rule_N3(inputs: Inputs, notices: list[str]) -> list[Finding]:  # noqa: N802
    """Brand blocklist: the repository scanner over spec, content and figures."""
    command = inputs.blocklist_cmd
    if not command.is_file():
        notices.append(f"SKIP N3 {command.as_posix()} is not present")
        return []
    targets = [
        path.as_posix()
        for path in (inputs.spec_root / "spec", inputs.content_dir, inputs.figures_dir)
        if path.is_dir()
    ]
    if not targets:
        notices.append("SKIP N3 no spec, content or figures directory to scan")
        return []
    completed = subprocess.run(
        [command.as_posix(), "--format", "json", *targets],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode not in (0, 1):
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        first = detail[-1] if detail else "no output"
        return [
            Finding("N3", command.as_posix(), f"exited {completed.returncode}: {first}"),
        ]
    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        return [Finding("N3", command.as_posix(), f"printed no JSON report: {error}")]
    return [
        Finding(
            "N3",
            str(hit.get("path", command.as_posix())),
            f"line {hit.get('line', 0)}: has the blocked term {str(hit.get('term', ''))!r}",
        )
        for hit in report.get("hits", [])
    ]


# --- rule C1 --------------------------------------------------------------


def _render_failures(inputs: Inputs, variant: str) -> Iterator[Finding]:
    environment = make_env(inputs.spec, variant, inputs.outline)
    for key in sorted(inputs.spec.files_present):
        document = inputs.spec.document(key)
        if document is None:
            continue
        path = (inputs.spec_root / inputs.spec.path_of(key)).as_posix()
        for pointer, value in _walk_text_fields(document):
            try:
                render_text(environment, value)
            except (jinja2.TemplateError, ContextError) as error:
                yield Finding("C1", path, f"at {pointer} ({variant}): {error}")
    for chapter, text in sorted(inputs.partials.items()):
        path = _relative(inputs.partial_paths[chapter])
        try:
            render_partial(environment, chapter, text)
        except (jinja2.TemplateError, ContextError) as error:
            yield Finding("C1", path, f"does not render ({variant}): {error}")


def rule_C1(inputs: Inputs) -> list[Finding]:  # noqa: N802
    """Everything renders with StrictUndefined and every ref() anchor resolves."""
    findings: list[Finding] = []
    for chapter, text in sorted(inputs.partials.items()):
        path = _relative(inputs.partial_paths[chapter])
        findings += [
            Finding("C1", path, f"line {_line_of(text, match.start())}: {message}")
            for match in _REF_CALL.finditer(text)
            if (message := _unknown_anchor(inputs.outline, match.group(1))) is not None
        ]
    for variant in inputs.variants:
        findings.extend(_render_failures(inputs, variant))
    return findings


def _unknown_anchor(outline: Outline, anchor: str) -> str | None:
    if outline.has(anchor):
        return None
    return f"ref({anchor!r}) points at an anchor the outline does not hold"


# --- rule C2 --------------------------------------------------------------


def _headings_of(text: str) -> Iterator[tuple[int, int, str, str | None]]:
    """Yield ``(line, level, title, anchor)`` for every Markdown heading."""
    for number, line in enumerate(text.splitlines(), start=1):
        match = _HEADING_LINE.match(line)
        if match is None:
            continue
        anchor = _ANCHOR_SUFFIX.search(match.group(2))
        title = _ANCHOR_SUFFIX.sub("", match.group(2)).strip()
        yield number, len(match.group(1)), title, anchor.group(1) if anchor else None


def rule_C2(inputs: Inputs) -> list[Finding]:  # noqa: N802
    """Anchors, `##` before `###`, an anchor on every heading."""
    findings: list[Finding] = []
    for chapter in inputs.chapters:
        text = inputs.partials[chapter]
        path = _relative(inputs.partial_paths[chapter])
        seen: list[str] = []
        top_level_seen = False
        for line, level, title, anchor in _headings_of(text):
            if level < 2 or level > 3:
                findings.append(
                    Finding("C2", path, f"line {line}: heading {title!r} is not a `##` or `###`")
                )
                continue
            if level == 2:
                top_level_seen = True
            elif not top_level_seen:
                findings.append(
                    Finding("C2", path, f"line {line}: `###` {title!r} comes before any `##`")
                )
            if anchor is None:
                message = f"line {line}: heading {title!r} has no anchor"
                findings.append(Finding("C2", path, message))
                continue
            if anchor in seen:
                findings.append(Finding("C2", path, f"line {line}: anchor {anchor!r} is repeated"))
            seen.append(anchor)
        findings += [
            Finding("C2", path, f"does not define the required anchor {anchor!r}")
            for anchor in REQUIRED_ANCHORS.get(chapter, ())
            if anchor not in seen
        ]
    return findings


# --- rule C3 --------------------------------------------------------------


def _count_calls(
    partials: Mapping[int, str], pattern: re.Pattern[str], name: str
) -> dict[int, int]:
    counts: dict[int, int] = {}
    for chapter, text in partials.items():
        counts[chapter] = sum(1 for match in pattern.finditer(text) if match.group(1) == name)
    return counts


def rule_C3(inputs: Inputs) -> list[Finding]:  # noqa: N802
    """Each table macro and each figure appears exactly once, in its chapter."""
    findings: list[Finding] = []
    for name, chapter in sorted(MACRO_CHAPTER.items()):
        findings += _placement_findings(inputs, MACRO_PATTERN, name, chapter, f"tables.{name}()")
    for figure_id, chapter in sorted(FIGURE_CHAPTER.items()):
        findings += _placement_findings(
            inputs, _FIGURE_CALL, figure_id, chapter, f"figure({figure_id!r})"
        )
    return findings


def _placement_findings(
    inputs: Inputs,
    pattern: re.Pattern[str],
    name: str,
    chapter: int,
    label: str,
) -> list[Finding]:
    counts = _count_calls(inputs.partials, pattern, name)
    findings: list[Finding] = []
    for other, count in sorted(counts.items()):
        if other == chapter or count == 0 or other not in inputs.chapters:
            continue
        path = _relative(inputs.partial_paths[other])
        findings.append(Finding("C3", path, f"calls {label}, which belongs in chapter {chapter}"))
    if chapter not in inputs.chapters:
        return findings
    count = counts.get(chapter, 0)
    if count != 1:
        path = _relative(inputs.partial_paths[chapter])
        findings.append(Finding("C3", path, f"calls {label} {count} time(s), expected exactly 1"))
    return findings


# --- rule C4 --------------------------------------------------------------


def rule_C4(inputs: Inputs, notices: list[str]) -> list[Finding]:  # noqa: N802
    """Word budget per chapter, tables and Jinja removed."""
    if not inputs.whole_document:
        notices.append(
            f"SKIP C4 the word budget needs every chapter "
            f"({len(inputs.partials)} of {len(WORD_BUDGET)} present)"
        )
        return []
    variant = inputs.variants[0]
    findings: list[Finding] = []
    for chapter in inputs.chapters:
        low, high = WORD_BUDGET[chapter]
        words = _count_words(_rendered_prose(inputs, variant, chapter))
        if low <= words <= high:
            continue
        path = _relative(inputs.partial_paths[chapter])
        findings.append(Finding("C4", path, f"has {words} prose words, budget {low}-{high}"))
    return findings


# --- rule C5 --------------------------------------------------------------


def _fact_block(anchor: str) -> re.Pattern[str]:
    return re.compile(
        r"\{%-?\s*if\s+fact_in_prose\(\s*['\"]" + re.escape(anchor) + r"['\"]\s*\)\s*-?%\}"
    )


def _value_calls(anchor: str) -> re.Pattern[str]:
    """The call that would state a fact's value in prose."""
    if anchor.startswith("setting:"):
        setting_id = anchor.split(":", 1)[1]
        return re.compile(r"\bval\(\s*['\"]" + re.escape(setting_id) + r"['\"]")
    return re.compile(r"\bq\(\s*" + re.escape(anchor) + r"\s*\)")


def rule_C5(inputs: Inputs, notices: list[str]) -> list[Finding]:  # noqa: N802
    """Prose-only and table-only fact placement."""
    findings: list[Finding] = []
    for variant in inputs.variants:
        knobs = variant_knobs(inputs.spec.build or {}, variant)
        if knobs.get("fact_placement") != "mixed":
            continue
        findings += _table_only_findings(inputs, variant, knobs.get("table_only") or ())
        if not inputs.whole_document:
            notices.append(
                f"SKIP C5 the prose-only coverage of {variant} needs every chapter "
                f"({len(inputs.partials)} of {len(WORD_BUDGET)} present)"
            )
            continue
        findings += _prose_only_findings(inputs, variant, knobs.get("prose_only") or ())
    return findings


def _prose_only_findings(inputs: Inputs, variant: str, anchors: Iterable[str]) -> list[Finding]:
    findings: list[Finding] = []
    for anchor in anchors:
        pattern = _fact_block(str(anchor))
        if any(pattern.search(text) for text in inputs.partials.values()):
            continue
        findings.append(
            Finding(
                "C5",
                _relative(inputs.content_dir),
                f"no partial states the prose-only fact {anchor!r} "
                f"inside a fact_in_prose block ({variant})",
            )
        )
    return findings


def _table_only_findings(inputs: Inputs, variant: str, anchors: Iterable[str]) -> list[Finding]:
    findings: list[Finding] = []
    for anchor in anchors:
        pattern = _value_calls(str(anchor))
        for chapter in inputs.chapters:
            text = inputs.partials[chapter]
            findings += [
                Finding(
                    "C5",
                    _relative(inputs.partial_paths[chapter]),
                    f"line {_line_of(text, match.start())}: states the table-only fact "
                    f"{anchor!r} in prose ({variant})",
                )
                for match in pattern.finditer(text)
            ]
    return findings


# --- rule C6 --------------------------------------------------------------


def _svg_files(figures_dir: Path) -> list[Path]:
    return sorted(figures_dir.glob("*.svg")) if figures_dir.is_dir() else []


def rule_C6(inputs: Inputs, notices: list[str]) -> list[Finding]:  # noqa: N802
    """The figure rules, delegated to figure_checks."""
    figures = _svg_files(inputs.figures_dir)
    if not figures:
        notices.append(f"SKIP C6 {inputs.figures_dir.as_posix()} holds no SVG figure")
        return []
    # A tree without that spec file falls back to the id
    # registries of figure_checks, exactly as `figure_checks.py` does on its own.
    if inputs.spec.signals is None:
        signals = builtin_signal_ids()
        required = builtin_signal_ids()
    else:
        signals = {str(signal["id"]) for signal in inputs.spec.signal_list}
        required = {
            str(signal["id"])
            for signal in inputs.spec.signal_list
            if signal.get("shown_in_schematic", True)
        }
    components = (
        builtin_component_ids()
        if inputs.spec.machine is None
        else {
            str(component["id"])
            for component in ((inputs.spec.machine or {}).get("components") or [])
        }
    )
    findings: list[Finding] = []
    for figure in figures:
        needed = required if figure.name == "system-schematic.svg" else None
        for message in check_svg(figure, signals, components, needed):
            findings.append(Finding("C6", _relative(figure), message.split(" ", 2)[2]))
    return findings


# --- driver ---------------------------------------------------------------


def gather(options: Options) -> tuple[Inputs, list[str]]:
    """Load the spec and the partials and resolve the rule inputs."""
    spec = load_spec(options.spec_root)
    partials, paths = read_partials(options.content_dir)
    outline = build_outline(spec, partials)
    notices: list[str] = []
    wanted = sorted(partials) if options.chapters is None else sorted(set(options.chapters))
    selected: list[int] = []
    for chapter in wanted:
        if chapter in partials:
            selected.append(chapter)
        else:
            notices.append(
                f"NOTICE chapter {chapter} has no partial in {options.content_dir.as_posix()}"
            )
    complete = len(partials) == len(WORD_BUDGET)
    whole = complete if options.whole_document == "auto" else options.whole_document == "on"
    inputs = Inputs(
        spec=spec,
        spec_root=options.spec_root,
        content_dir=options.content_dir,
        figures_dir=options.figures_dir,
        partials=partials,
        partial_paths=paths,
        outline=outline,
        variants=options.variants,
        chapters=tuple(selected),
        whole_document=whole,
        blocklist_cmd=options.blocklist_cmd,
    )
    return inputs, notices


def run_checks(inputs: Inputs) -> tuple[list[Finding], list[str]]:
    """Run every rule; return the findings and the SKIP/NOTICE lines."""
    notices: list[str] = []
    findings: list[Finding] = []
    findings += rule_N1(inputs)
    findings += rule_N3(inputs, notices)
    findings += rule_C1(inputs)
    findings += rule_C2(inputs)
    findings += rule_C3(inputs)
    findings += rule_C4(inputs, notices)
    findings += rule_C5(inputs, notices)
    findings += rule_C6(inputs, notices)
    return findings, notices


# --- CLI ------------------------------------------------------------------


def _chapter_list(text: str) -> list[int]:
    try:
        return [int(part.strip()) for part in text.split(",") if part.strip()]
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"not a comma-separated chapter list: {text}") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="content_checks.py",
        description="Check the manual's text: rules N1, N3 and C1-C6.",
    )
    parser.add_argument("--spec", default="manual", help="spec root holding build.yaml and spec/")
    parser.add_argument(
        "--content", default=None, help="partials directory (default <spec>/content)"
    )
    parser.add_argument(
        "--figures", default=None, help="figures directory (default <spec>/figures)"
    )
    parser.add_argument(
        "--blocklist-cmd",
        default="scripts/blocklist.sh",
        help="the brand blocklist scanner used by rule N3",
    )
    parser.add_argument(
        "--chapters",
        type=_chapter_list,
        default=None,
        help="limit rules C2-C5 to these chapters, e.g. 1,2,5",
    )
    parser.add_argument(
        "--variant",
        choices=("clean", "realistic", "both"),
        default="both",
        help="variant(s) to render for rules C1 and C5",
    )
    parser.add_argument(
        "--whole-document",
        choices=("auto", "on", "off"),
        default="auto",
        help="run the whole-document rules C4 and C5 coverage (auto: only when complete)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the content checks; return the process exit code."""
    options = Options.from_args(build_parser().parse_args(argv))

    try:
        inputs, notices = gather(options)
    except SpecError as error:
        for message in error.messages:
            print(f"C1 file:{options.spec_root.as_posix()} {message}")
        return 1

    findings, rule_notices = run_checks(inputs)
    for line in (*notices, *rule_notices):
        print(line)
    for finding in findings:
        print(finding)
    if not findings:
        print(
            f"content_checks: {len(inputs.partials)} partial(s), "
            f"{len(inputs.variants)} variant(s) checked, no findings"
        )
    return 1 if findings else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

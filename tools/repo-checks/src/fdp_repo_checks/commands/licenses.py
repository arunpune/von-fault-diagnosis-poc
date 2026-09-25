# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks licenses``: nothing copyleft ships.

The ground rules allow a copyleft tool in the toolchain and forbid one in a
shipped package, so the audit turns on scope. Each ecosystem's collector
says which of its dependencies are runtime (in a Compose image) and which are
dev; :mod:`fdp_repo_checks.spdx_expr` judges the declared expression against
``tools/repo-checks/licenses-policy.toml``; and the exit code follows only
the runtime rows.

A runtime row fails when its expression is denied, unreadable or unknown to
the policy, or when it is flagged and no human accepted it in
``[flagged-accepted]``. A dev row never fails: copyleft there is listed in
its own table of ``reports/licenses.md`` so that a reviewer sees what the
toolchain carries.

The report is deterministic — sorted rows, no timestamp — so two runs over
the same environment produce the same bytes and a diff means something
changed.
"""

from __future__ import annotations

import argparse
import sys
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from fdp_repo_checks import licenses_go, licenses_node, licenses_python
from fdp_repo_checks.findings import EXIT_ERROR, Finding, report
from fdp_repo_checks.licenses_model import Collected, CollectorError, Record, Scope
from fdp_repo_checks.spdx_expr import DEFAULT_DENY_PREFIXES, Verdict, allowed

NAME = "licenses"
HELP = "audit the licences of every dependency against the runtime policy"

DEFAULT_POLICY = "tools/repo-checks/licenses-policy.toml"
DEFAULT_REPORT = "reports/licenses.md"

_COPYRIGHT_NAME = "SPDX-FileCopyrightText"
_LICENSE_NAME = "SPDX-License-Identifier"
_COPYRIGHT_HOLDER = "2026 Meddle S.r.l."
"""The report's own header, built from parts rather than spelled out.

``reuse lint`` reads the whole file, and a literal tag in a string would be
taken for this module's own licence declaration — the same reason
:mod:`fdp_repo_checks.commands.spdx` composes its tag names.
"""

COLLECTORS: dict[str, Callable[[Path], Collected]] = {
    "node": licenses_node.collect,
    "python": licenses_python.collect,
    "go": licenses_go.collect,
}
"""Ecosystem to collector. A test replaces an entry to run the audit offline."""

ECOSYSTEM_CHOICES = (*sorted(COLLECTORS), "all")


class PolicyError(ValueError):
    """``licenses-policy.toml`` is missing or not shaped as this module needs."""


@dataclass(frozen=True)
class Policy:
    """The licence policy, as ``licenses-policy.toml`` states it."""

    path: Path
    allow: tuple[str, ...]
    flagged: tuple[str, ...]
    deny_prefixes: tuple[str, ...]
    flagged_accepted: Mapping[str, str]
    overrides: Mapping[str, str]
    dev_copyleft_expected: tuple[str, ...]

    def expects_dev_copyleft(self, name: str) -> bool:
        """True when a dev package is on the policy's expected dev-copyleft list."""
        return name.casefold() in {expected.casefold() for expected in self.dev_copyleft_expected}


@dataclass(frozen=True)
class Assessment:
    """One dependency, judged."""

    record: Record
    effective: str
    """The expression that was judged: the override when there is one."""
    override: str | None
    verdict: Verdict
    accepted: str | None
    """Why a flagged runtime licence was accepted, when it was."""

    @property
    def fails(self) -> bool:
        """True when this row must stop the build."""
        if self.record.scope is not Scope.RUNTIME:
            return False
        if self.verdict is Verdict.FLAGGED:
            return self.accepted is None
        return self.verdict is not Verdict.OK

    @property
    def reason(self) -> str:
        """Why the row failed, phrased for the finding."""
        declared = self.record.declared or "no licence in its metadata"
        shown = f"{declared!r}" if self.record.declared else declared
        if self.verdict is Verdict.FLAGGED:
            return (
                f"runtime dependency is flagged ({shown}); accept it in "
                f'[flagged-accepted] "{self.record.key}" with a reason, or drop it'
            )
        if self.verdict is Verdict.FAIL:
            return (
                f"runtime dependency is copyleft ({shown}); a shipped dependency must be permissive"
            )
        return (
            f"runtime dependency has no licence the policy knows ({shown}); "
            f'resolve it in [overrides] "{self.record.key}" or add the licence to [runtime] allow'
        )


def register(parser: argparse.ArgumentParser) -> None:
    """Add the sub-command's own options."""
    parser.add_argument(
        "--ecosystem",
        choices=ECOSYSTEM_CHOICES,
        default="all",
        help="audit one package manager instead of all of them (default: all)",
    )
    parser.add_argument(
        "--policy",
        metavar="PATH",
        default=DEFAULT_POLICY,
        help=f"the licence policy to apply (default: {DEFAULT_POLICY})",
    )
    parser.add_argument(
        "--report",
        metavar="PATH",
        default=DEFAULT_REPORT,
        help=f"where to write the Markdown report (default: {DEFAULT_REPORT})",
    )


def _table(data: Mapping[str, object], key: str, path: Path) -> Mapping[str, object]:
    value = data.get(key, {})
    if not isinstance(value, dict):
        raise PolicyError(f"{path}: [{key}] must be a table")
    return value


def _string_list(
    table: Mapping[str, object], key: str, path: Path, *, where: str
) -> tuple[str, ...]:
    value = table.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise PolicyError(f"{path}: {where}{key} must be a list of strings")
    return tuple(str(item) for item in value)


def _string_map(table: Mapping[str, object], path: Path, *, where: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in table.items():
        if not isinstance(value, str) or not value.strip():
            raise PolicyError(f'{path}: [{where}] "{key}" must be a non-empty string')
        result[str(key)] = value
    return result


def load_policy(path: Path) -> Policy:
    """Read ``licenses-policy.toml``.

    Raises:
        PolicyError: the file is missing, is not valid TOML, or a table has
            the wrong shape.
    """
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    except OSError as error:
        raise PolicyError(f"{path}: cannot be read ({error.strerror})") from error
    except tomllib.TOMLDecodeError as error:
        raise PolicyError(f"{path}: not valid TOML ({error})") from error

    runtime = _table(data, "runtime", path)
    allow = _string_list(runtime, "allow", path, where="[runtime] ")
    if not allow:
        raise PolicyError(f"{path}: [runtime] allow is empty, so nothing could ever pass")
    deny = _string_list(runtime, "deny_prefixes", path, where="[runtime] ") or DEFAULT_DENY_PREFIXES
    expected = _table(data, "dev-copyleft-expected", path)
    return Policy(
        path=path,
        allow=allow,
        flagged=_string_list(runtime, "flagged", path, where="[runtime] "),
        deny_prefixes=deny,
        flagged_accepted=_string_map(
            _table(data, "flagged-accepted", path), path, where="flagged-accepted"
        ),
        overrides=_string_map(_table(data, "overrides", path), path, where="overrides"),
        dev_copyleft_expected=_string_list(
            expected, "names", path, where="[dev-copyleft-expected] "
        ),
    )


def classify(record: Record, policy: Policy) -> Assessment:
    """Judge one dependency against the policy."""
    override = policy.overrides.get(record.key)
    effective = override if override is not None else record.declared
    verdict = allowed(effective, policy.allow, policy.flagged, policy.deny_prefixes)
    accepted = policy.flagged_accepted.get(record.key) if verdict is Verdict.FLAGGED else None
    return Assessment(
        record=record,
        effective=effective,
        override=override,
        verdict=verdict,
        accepted=accepted,
    )


def assess(records: Sequence[Record], policy: Policy) -> tuple[Assessment, ...]:
    """Judge every dependency, in report order."""
    return tuple(
        sorted(
            (classify(record, policy) for record in records),
            key=lambda assessment: assessment.record.sort_key,
        )
    )


def findings_for(assessments: Sequence[Assessment]) -> list[Finding]:
    """The runtime rows that must stop the build."""
    return [
        Finding(assessment.record.label, assessment.reason)
        for assessment in assessments
        if assessment.fails
    ]


def _cell(text: str) -> str:
    """Escape a value so it cannot break out of a Markdown table cell."""
    return text.replace("|", "\\|").replace("\n", " ") if text else "—"


def _runtime_section(assessments: Sequence[Assessment]) -> list[str]:
    lines = ["## Runtime dependencies", ""]
    runtime = [item for item in assessments if item.record.scope is Scope.RUNTIME]
    if not runtime:
        lines += ["No dependency ships in a Compose image yet.", ""]
        return lines
    for ecosystem in sorted({item.record.ecosystem for item in runtime}):
        rows = [item for item in runtime if item.record.ecosystem == ecosystem]
        lines += [
            f"### {ecosystem} ({len(rows)})",
            "",
            "| Package | Version | Declared | Effective | Verdict |",
            "| --- | --- | --- | --- | --- |",
        ]
        for item in rows:
            note = " (accepted)" if item.accepted else ""
            lines.append(
                f"| {_cell(item.record.name)} | {_cell(item.record.version)} "
                f"| {_cell(item.record.declared)} | {_cell(item.effective)} "
                f"| {item.verdict.value}{note} |"
            )
        lines.append("")
    return lines


def _dev_section(assessments: Sequence[Assessment], policy: Policy) -> list[str]:
    lines = ["## Dev-only copyleft, flagged and unaudited licences", ""]
    rows = [
        item
        for item in assessments
        if item.record.scope is Scope.DEV and item.verdict is not Verdict.OK
    ]
    if not rows:
        lines += ["Every development dependency carries a permissive licence.", ""]
        return lines
    lines += [
        "These never ship, so they do not fail the audit.",
        "",
        "| Package | Version | Declared | Verdict | Expected |",
        "| --- | --- | --- | --- | --- |",
    ]
    for item in rows:
        expected = "yes" if policy.expects_dev_copyleft(item.record.name) else "no"
        lines.append(
            f"| {_cell(item.record.key)} | {_cell(item.record.version)} "
            f"| {_cell(item.record.declared)} | {item.verdict.value} | {expected} |"
        )
    lines.append("")
    return lines


def _overrides_section(assessments: Sequence[Assessment]) -> list[str]:
    lines = ["## Overrides used", ""]
    rows = [item for item in assessments if item.override is not None]
    if not rows:
        lines += ["No dependency needed a reviewed expression.", ""]
        return lines
    lines += [
        "| Package | Version | Declared | Override | Verdict |",
        "| --- | --- | --- | --- | --- |",
    ]
    for item in rows:
        lines.append(
            f"| {_cell(item.record.key)} | {_cell(item.record.version)} "
            f"| {_cell(item.record.declared)} | {_cell(item.effective)} "
            f"| {item.verdict.value} |"
        )
    lines.append("")
    return lines


def render_report(
    assessments: Sequence[Assessment],
    notices: Sequence[str],
    policy: Policy,
    *,
    ecosystems: Sequence[str],
    policy_label: str = DEFAULT_POLICY,
) -> str:
    """Render ``reports/licenses.md``; the same input gives the same bytes.

    ``policy_label`` is how the policy is named in the report. It is the path
    relative to the repository root, never the absolute one, so that two
    checkouts of the same commit produce the same report.
    """
    failures = sum(1 for item in assessments if item.fails)
    lines = [
        f"<!-- {_COPYRIGHT_NAME}: {_COPYRIGHT_HOLDER} -->",
        f"<!-- {_LICENSE_NAME}: Apache-2.0 -->",
        "",
        "# Dependency licences",
        "",
        f"Written by `fdp-checks licenses` from `{policy_label}`.",
        f"Ecosystems audited: {', '.join(ecosystems)}.",
        f"{len(assessments)} dependencies, {failures} runtime violations.",
        "",
    ]
    lines += _runtime_section(assessments)
    lines += _dev_section(assessments, policy)
    lines += _overrides_section(assessments)
    if notices:
        lines += ["## Notices", ""]
        lines += [f"- {notice}" for notice in notices]
        lines.append("")
    return "\n".join(lines)


def _chosen_ecosystems(choice: str) -> tuple[str, ...]:
    return tuple(sorted(COLLECTORS)) if choice == "all" else (choice,)


def _collect(root: Path, ecosystems: Sequence[str]) -> Collected:
    """Run each chosen collector and pool its records and notices."""
    records: list[Record] = []
    notices: list[str] = []
    for ecosystem in ecosystems:
        collected = COLLECTORS[ecosystem](root)
        records.extend(collected.records)
        notices.extend(collected.notices)
    return Collected(tuple(records), tuple(notices))


def _resolve(root: Path, raw: str) -> Path:
    candidate = Path(raw).expanduser()
    return candidate if candidate.is_absolute() else root / candidate


def _label(path: Path, root: Path) -> str:
    """How a path is named in the report: relative to the root when it is under it."""
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _write_report(path: Path, text: str) -> None:
    """Write the report, creating ``reports/`` on the first run.

    Raises:
        CollectorError: the report cannot be written.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    except OSError as error:
        raise CollectorError(f"{path}: cannot be written ({error.strerror})") from error


def run(args: argparse.Namespace) -> int:
    """Audit every dependency and report."""
    root: Path = args.root
    ecosystems = _chosen_ecosystems(args.ecosystem)
    try:
        policy = load_policy(_resolve(root, args.policy))
        collected = _collect(root, ecosystems)
    except (PolicyError, CollectorError) as error:
        print(f"fdp-checks {NAME}: {error}", file=sys.stderr)
        return EXIT_ERROR

    assessments = assess(collected.records, policy)
    report_path = _resolve(root, args.report)
    try:
        _write_report(
            report_path,
            render_report(
                assessments,
                collected.notices,
                policy,
                ecosystems=ecosystems,
                policy_label=_label(policy.path, root),
            ),
        )
    except CollectorError as error:
        print(f"fdp-checks {NAME}: {error}", file=sys.stderr)
        return EXIT_ERROR

    for notice in collected.notices:
        print(f"fdp-checks {NAME}: {notice}", file=sys.stderr)
    print(f"fdp-checks {NAME}: report written to {_label(report_path, root)}", file=sys.stderr)
    return report(
        NAME,
        findings_for(assessments),
        output_format=args.output_format,
        checked=len(assessments),
        unit="dependencies",
    )

# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The dependency licence audit: the expression evaluator and the classifier.

The evaluator is driven by the cases the licence ground rule turns on. The
collectors are driven by output captured from the real tools
(``tests/fixtures/licenses/``, whose README records where each capture came
from), so a shape change in pnpm, uv or go-licenses shows up here rather than
in CI. One test is marked ``network``: it runs the real audit over this
workspace.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from fdp_repo_checks import cli, licenses_go, licenses_node, licenses_python
from fdp_repo_checks.commands import licenses
from fdp_repo_checks.findings import EXIT_ERROR, EXIT_FINDINGS, EXIT_OK
from fdp_repo_checks.licenses_model import Collected, CollectorError, Record, Scope, merge
from fdp_repo_checks.spdx_expr import (
    License,
    Operation,
    SpdxSyntaxError,
    Verdict,
    allowed,
    identifiers,
    normalise_identifier,
    parse,
    render,
)

FIXTURES = Path(__file__).parent / "fixtures" / "licenses"
REPO_ROOT = Path(__file__).resolve().parents[3]
COMMITTED_POLICY = REPO_ROOT / licenses.DEFAULT_POLICY

ALLOW = ("MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "PSF-2.0", "MIT-0", "MIT-CMU")
FLAGGED = ("MPL-2.0", "Unlicense", "LGPL-2.1-only", "LGPL-3.0-only", "LGPL-3.0-or-later")


def verdict(expression: str) -> Verdict:
    """Judge ``expression`` against the sets the committed policy uses."""
    return allowed(expression, ALLOW, FLAGGED)


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def python_fixture() -> tuple[licenses_python.Distribution, ...]:
    """The captured ``importlib.metadata`` sample as collector input."""
    return tuple(
        licenses_python.Distribution(
            name=entry["name"],
            version=entry["version"],
            license_expression=entry["license_expression"],
            license_field=entry["license"],
            classifiers=tuple(entry["classifiers"]),
        )
        for entry in json.loads(read_fixture("python-metadata.json"))
    )


def write_policy(
    path: Path,
    *,
    flagged_accepted: str = "",
    overrides: str = "",
) -> Path:
    """Write a policy file with the committed lists and the given tables."""
    allow = ", ".join(f'"{item}"' for item in ALLOW)
    flagged = ", ".join(f'"{item}"' for item in FLAGGED)
    path.write_text(
        "[runtime]\n"
        f"allow = [{allow}]\n"
        f"flagged = [{flagged}]\n"
        'deny_prefixes = ["GPL-", "AGPL-"]\n'
        f"\n[flagged-accepted]\n{flagged_accepted}\n"
        f"\n[overrides]\n{overrides}\n"
        '\n[dev-copyleft-expected]\nnames = ["reuse", "golangci-lint", "pyphen", "shellcheck"]\n',
        encoding="utf-8",
    )
    return path


def load_written_policy(tmp_path: Path, **tables: str) -> licenses.Policy:
    return licenses.load_policy(write_policy(tmp_path / "policy.toml", **tables))


# --- the expression evaluator -------------------------------------------------


def test_a_dual_licence_passes_on_its_permissive_operand() -> None:
    assert verdict("EPL-2.0 OR BSD-3-Clause") is Verdict.OK


def test_strong_copyleft_is_rejected() -> None:
    assert verdict("GPL-3.0-only") is Verdict.FAIL


def test_weak_copyleft_is_flagged() -> None:
    assert verdict("MPL-2.0") is Verdict.FLAGGED


def test_a_parenthesised_conjunction_of_permissive_licences_passes() -> None:
    assert verdict("(MIT AND BSD-3-Clause)") is Verdict.OK


def test_a_conjunction_takes_its_worst_operand() -> None:
    assert verdict("MIT AND GPL-3.0-only") is Verdict.FAIL


def test_a_disjunction_takes_its_best_operand() -> None:
    assert verdict("GPL-3.0-only OR MIT") is Verdict.OK


def test_an_unaudited_operand_beats_a_forbidden_one_but_still_stops_the_build() -> None:
    assert verdict("GPL-3.0-only OR Some-New-Licence-1.0") is Verdict.UNKNOWN


def test_and_binds_tighter_than_or() -> None:
    assert parse("GPL-3.0-only AND MIT OR MIT") == Operation(
        "OR",
        (
            Operation("AND", (License("GPL-3.0-only"), License("MIT"))),
            License("MIT"),
        ),
    )
    assert verdict("GPL-3.0-only AND MIT OR MIT") is Verdict.OK


def test_an_exception_is_judged_as_the_licence_it_loosens() -> None:
    assert parse("Apache-2.0 WITH LLVM-exception") == License("Apache-2.0", "LLVM-exception")
    assert verdict("Apache-2.0 WITH LLVM-exception") is Verdict.OK
    assert verdict("GPL-3.0-only WITH Classpath-exception-2.0") is Verdict.FAIL


@pytest.mark.parametrize(
    ("spelling", "expected"),
    [
        ("Apache 2.0", "Apache-2.0"),
        ("Apache License, Version 2.0", "Apache-2.0"),
        ("BSD 3-Clause", "BSD-3-Clause"),
        ("BSD 2-Clause License", "BSD-2-Clause"),
        ("MIT/X11", "MIT"),
        ("EDL-1.0", "BSD-3-Clause"),
        ("GPL-3.0", "GPL-3.0-only"),
        ("GPL-2.0+", "GPL-2.0-or-later"),
        ("LGPL-2.1", "LGPL-2.1-only"),
        ("MIT", "MIT"),
    ],
)
def test_registry_spellings_resolve_to_their_identifier(spelling: str, expected: str) -> None:
    assert render(parse(spelling)) == expected


def test_an_alias_inside_an_expression_is_resolved() -> None:
    assert verdict("EDL-1.0 OR EPL-2.0") is Verdict.OK
    assert verdict("MIT/X11 AND BSD-3-Clause") is Verdict.OK


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "Unknown",
        "NOASSERTION",
        "UNLICENSED",
        "BSD-3-Clause, Apache-2.0, dependency licenses",
        "LicenseRef-Proprietary",
    ],
)
def test_metadata_that_states_no_licence_is_unknown(text: str) -> None:
    assert verdict(text) is Verdict.UNKNOWN


def test_a_missing_licence_is_unknown() -> None:
    assert allowed(None, ALLOW, FLAGGED) is Verdict.UNKNOWN


@pytest.mark.parametrize("text", ["(MIT", "MIT)", "MIT AND", "AND MIT", "MIT WITH AND", "()"])
def test_a_malformed_expression_is_a_syntax_error(text: str) -> None:
    with pytest.raises(SpdxSyntaxError):
        parse(text)


def test_render_round_trips_nested_operators() -> None:
    expression = "MIT AND (Apache-2.0 OR BSD-3-Clause)"
    assert render(parse(expression)) == expression


def test_identifiers_lists_every_licence_the_expression_names() -> None:
    assert identifiers(parse("MIT AND (Apache-2.0 OR BSD-3-Clause)")) == (
        "MIT",
        "Apache-2.0",
        "BSD-3-Clause",
    )


def test_the_verdicts_are_ordered_from_harmless_to_forbidden() -> None:
    ordered = [Verdict.OK, Verdict.FLAGGED, Verdict.UNKNOWN, Verdict.FAIL]
    assert [item.severity for item in ordered] == sorted(item.severity for item in ordered)


def test_an_identifier_keeps_its_spelling_when_the_table_does_not_know_it() -> None:
    assert normalise_identifier("Some-New-Licence-1.0") == "Some-New-Licence-1.0"


def test_the_policy_comparison_ignores_case() -> None:
    assert verdict("mit") is Verdict.OK


# --- the node collector -------------------------------------------------------


def test_the_pnpm_capture_yields_one_record_per_installed_version() -> None:
    records = licenses_node.parse_report(read_fixture("pnpm-dev.json"), Scope.DEV)
    semver = [record for record in records if record.name == "semver"]
    assert [record.version for record in semver] == ["6.3.1", "7.8.5"]
    assert {record.scope for record in records} == {Scope.DEV}
    assert {record.ecosystem for record in records} == {"node"}


def test_every_licence_key_of_the_pnpm_capture_is_carried_over() -> None:
    records = licenses_node.parse_report(read_fixture("pnpm-dev.json"), Scope.DEV)
    assert {record.declared for record in records} == set(json.loads(read_fixture("pnpm-dev.json")))


def test_a_scope_without_dependencies_is_not_an_error() -> None:
    assert licenses_node.parse_report(licenses_node.NO_LICENSES_MESSAGE + "\n", Scope.RUNTIME) == ()
    assert licenses_node.parse_report("", Scope.RUNTIME) == ()


@pytest.mark.parametrize(
    "payload",
    ['["MIT"]', "not json at all", '{"MIT": {"name": "x"}}', '{"MIT": [{"versions": ["1"]}]}'],
)
def test_an_unknown_pnpm_shape_is_a_collector_error(payload: str) -> None:
    with pytest.raises(CollectorError):
        licenses_node.parse_report(payload, Scope.DEV)


# --- the python collector -----------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("cryptography", "Apache-2.0 OR BSD-3-Clause"),
        ("grimp", "BSD 2-Clause License"),
        ("markdown-it-py", "MIT"),
        ("pathspec", "MPL-2.0"),
        ("pillow", "MIT-CMU"),
        ("pypdfium2", "BSD-3-Clause, Apache-2.0, dependency licenses"),
        ("typing_extensions", "PSF-2.0"),
    ],
)
def test_the_licence_comes_from_the_first_metadata_field_that_states_one(
    name: str, expected: str
) -> None:
    distribution = next(item for item in python_fixture() if item.name == name)
    assert licenses_python.declared_license(distribution) == expected


def test_a_licence_field_holding_the_whole_text_falls_through_to_the_classifier() -> None:
    distribution = licenses_python.Distribution(
        name="example",
        version="1.0",
        license_field="Copyright (c) 2026\n\nPermission is hereby granted, free of charge, …",
        classifiers=("License :: OSI Approved :: MIT License",),
    )
    assert licenses_python.declared_license(distribution) == "MIT"


def test_a_distribution_without_any_licence_metadata_reports_none() -> None:
    distribution = licenses_python.Distribution(name="example", version="1.0")
    assert licenses_python.declared_license(distribution) == ""
    assert verdict(licenses_python.declared_license(distribution)) is Verdict.UNKNOWN


def test_workspace_members_are_not_audited() -> None:
    records = licenses_python.records_from(
        python_fixture(), runtime=frozenset(), workspace=frozenset({"fdp-init"})
    )
    assert "fdp-init" not in {record.name for record in records}


def test_the_runtime_set_decides_the_scope() -> None:
    records = licenses_python.records_from(
        python_fixture(), runtime=frozenset({"pillow"}), workspace=frozenset()
    )
    by_scope = {record.name: record.scope for record in records}
    assert by_scope["pillow"] is Scope.RUNTIME
    assert by_scope["grimp"] is Scope.DEV


def test_requirement_names_skips_comments_and_editable_members() -> None:
    export = (
        "# This file was autogenerated by uv\n"
        "#    uv export --package fdp-init\n"
        "-e ./tools/init\n"
        "--index-url https://example.invalid/simple\n"
        "pg8000==1.31.5\n"
        "PDFPlumber==0.11.10 ; python_version >= '3.13'\n"
        "some-pkg @ https://example.invalid/some_pkg-1.0-py3-none-any.whl\n"
        "\n"
    )
    assert licenses_python.requirement_names(export) == frozenset(
        {"pg8000", "pdfplumber", "some-pkg"}
    )


def test_an_export_without_third_party_requirements_is_empty() -> None:
    assert licenses_python.requirement_names("# header\n-e ./tools/init\n") == frozenset()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("pdfminer.six", "pdfminer-six"), ("typing_extensions", "typing-extensions"), ("MIT", "mit")],
)
def test_distribution_names_are_compared_in_their_canonical_form(raw: str, expected: str) -> None:
    assert licenses_python.canonical_name(raw) == expected


def test_workspace_names_are_read_from_the_uv_manifests(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        '[tool.uv.workspace]\nmembers = ["tools/one", "tools/missing"]\n', encoding="utf-8"
    )
    member = tmp_path / "tools" / "one"
    member.mkdir(parents=True)
    (member / "pyproject.toml").write_text('[project]\nname = "fdp_one"\n', encoding="utf-8")
    assert licenses_python.workspace_names(tmp_path) == frozenset({"fdp-one"})


def test_the_committed_workspace_members_are_all_found() -> None:
    assert licenses_python.workspace_names(REPO_ROOT) >= {
        "fdp-init",
        "fdp-manual-build",
        "fdp-repo-checks",
        "fdp-blocklist",
    }


# --- the go collector ---------------------------------------------------------


def test_the_go_report_drops_the_main_module_and_keeps_its_dependencies() -> None:
    records = licenses_go.parse_report(
        read_fixture("go-report.csv"), main_module="example.invalid/golicprobe"
    )
    assert [record.name for record in records] == [
        "github.com/eclipse/paho.golang",
        "github.com/goburrow/serial",
        "github.com/google/uuid",
        "github.com/simonvetter/modbus",
    ]
    assert {record.scope for record in records} == {Scope.RUNTIME}


def test_the_module_version_is_taken_from_the_licence_url() -> None:
    records = licenses_go.parse_report(
        read_fixture("go-report.csv"), main_module="example.invalid/golicprobe"
    )
    versions = {record.name: record.version for record in records}
    assert versions["github.com/eclipse/paho.golang"] == "v0.23.0"
    assert versions["github.com/simonvetter/modbus"] == "v1.6.4"


def test_a_go_dependency_without_a_detected_licence_is_unknown() -> None:
    records = licenses_go.parse_report("example.invalid/other,Unknown,Unknown\n", main_module="")
    assert verdict(records[0].declared) is Verdict.UNKNOWN


def test_a_go_row_with_the_wrong_column_count_is_a_collector_error() -> None:
    with pytest.raises(CollectorError):
        licenses_go.parse_report("only,two\n", main_module="")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("module example.invalid/m\n\ngo 1.27\n", False),
        ("module example.invalid/m\n\nrequire example.invalid/dep v1.0.0\n", True),
        ("module example.invalid/m\n\nrequire (\n\texample.invalid/dep v1.0.0\n)\n", True),
    ],
)
def test_requirements_are_detected_in_go_mod(text: str, expected: bool) -> None:
    assert licenses_go.declares_requirements(text) is expected
    assert licenses_go.module_path(text) == "example.invalid/m"


def test_a_go_module_without_requirements_is_skipped_with_a_notice(tmp_path: Path) -> None:
    module = tmp_path / "services" / "modbus"
    module.mkdir(parents=True)
    (module / "go.mod").write_text("module example.invalid/m\n\ngo 1.27\n", encoding="utf-8")
    collected = licenses_go.collect(tmp_path)
    assert collected.records == ()
    assert any("declares no module requirements" in notice for notice in collected.notices)


def test_a_repository_without_a_go_module_is_skipped_with_a_notice(tmp_path: Path) -> None:
    collected = licenses_go.collect(tmp_path)
    assert collected.records == ()
    assert any("does not exist yet" in notice for notice in collected.notices)


# --- record bookkeeping -------------------------------------------------------


def test_a_package_in_both_scopes_is_kept_once_as_runtime() -> None:
    dev = Record("node", "example", "1.0.0", "MIT", Scope.DEV)
    runtime = Record("node", "example", "1.0.0", "MIT", Scope.RUNTIME)
    assert merge([dev, runtime]) == (runtime,)
    assert merge([runtime, dev]) == (runtime,)


def test_a_record_names_itself_by_ecosystem_and_version() -> None:
    record = Record("python", "pypdfium2", "5.13.0", "", Scope.DEV)
    assert record.key == "python:pypdfium2"
    assert record.label == "python:pypdfium2@5.13.0"


# --- the policy and the classifier --------------------------------------------


def test_the_committed_policy_states_the_lists_of_the_planning_documents() -> None:
    policy = licenses.load_policy(COMMITTED_POLICY)
    assert {"MIT", "Apache-2.0", "BSD-3-Clause", "CC-BY-4.0", "MIT-CMU"} <= set(policy.allow)
    assert {"MPL-2.0", "Unlicense", "LGPL-3.0-or-later"} <= set(policy.flagged)
    assert policy.overrides["python:pypdfium2"] == "Apache-2.0 OR BSD-3-Clause"
    assert set(policy.dev_copyleft_expected) == {"reuse", "golangci-lint", "pyphen", "shellcheck"}


@pytest.mark.parametrize(
    "body",
    [
        "not toml at all = = =",
        "[runtime]\nallow = []\n",
        "[runtime]\nallow = 3\n",
        '[runtime]\nallow = ["MIT"]\n[overrides]\n"python:x" = 7\n',
    ],
)
def test_a_malformed_policy_is_rejected(tmp_path: Path, body: str) -> None:
    path = tmp_path / "policy.toml"
    path.write_text(body, encoding="utf-8")
    with pytest.raises(licenses.PolicyError):
        licenses.load_policy(path)


def test_a_missing_policy_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(licenses.PolicyError):
        licenses.load_policy(tmp_path / "nowhere.toml")


def copyleft_records(scope: Scope) -> tuple[Record, ...]:
    """The synthetic copyleft capture, read in the given scope."""
    return licenses_node.parse_report(read_fixture("pnpm-copyleft.json"), scope)


def test_a_runtime_copyleft_dependency_fails(tmp_path: Path) -> None:
    policy = load_written_policy(tmp_path)
    assessments = licenses.assess(copyleft_records(Scope.RUNTIME), policy)
    failures = {finding.path for finding in licenses.findings_for(assessments)}
    assert failures == {
        "node:example-copyleft-widget@1.0.0",
        "node:example-flagged-widget@2.3.1",
    }
    gpl = next(item for item in assessments if item.record.name == "example-copyleft-widget")
    assert gpl.verdict is Verdict.FAIL
    assert "a shipped dependency must be permissive" in gpl.reason


def test_the_same_copyleft_dependency_is_only_listed_in_dev_scope(tmp_path: Path) -> None:
    policy = load_written_policy(tmp_path)
    assessments = licenses.assess(copyleft_records(Scope.DEV), policy)
    assert licenses.findings_for(assessments) == []
    gpl = next(item for item in assessments if item.record.name == "example-copyleft-widget")
    assert gpl.verdict is Verdict.FAIL
    assert gpl.fails is False
    report = licenses.render_report(assessments, (), policy, ecosystems=("node",))
    assert "| node:example-copyleft-widget | 1.0.0 | GPL-3.0-only | fail | no |" in report


def test_a_flagged_runtime_dependency_passes_once_a_human_accepts_it(tmp_path: Path) -> None:
    reason = "dev container only; never shipped"
    policy = load_written_policy(
        tmp_path, flagged_accepted=f'"node:example-flagged-widget" = "{reason}"'
    )
    assessments = licenses.assess(copyleft_records(Scope.RUNTIME), policy)
    flagged = next(item for item in assessments if item.record.name == "example-flagged-widget")
    assert flagged.verdict is Verdict.FLAGGED
    assert flagged.accepted == reason
    assert flagged.fails is False


def test_an_override_resolves_metadata_that_is_not_an_expression() -> None:
    policy = licenses.load_policy(COMMITTED_POLICY)
    records = licenses_python.records_from(
        python_fixture(), runtime=frozenset({"pypdfium2"}), workspace=frozenset()
    )
    assessment = next(
        licenses.classify(record, policy) for record in records if record.name == "pypdfium2"
    )
    assert assessment.override == "Apache-2.0 OR BSD-3-Clause"
    assert assessment.verdict is Verdict.OK
    assert assessment.fails is False


def test_without_the_override_the_same_metadata_stops_the_build(tmp_path: Path) -> None:
    policy = load_written_policy(tmp_path)
    records = licenses_python.records_from(
        python_fixture(), runtime=frozenset({"pypdfium2"}), workspace=frozenset()
    )
    assessment = next(
        licenses.classify(record, policy) for record in records if record.name == "pypdfium2"
    )
    assert assessment.verdict is Verdict.UNKNOWN
    assert assessment.fails is True
    assert "[overrides]" in assessment.reason


def test_the_report_carries_the_three_tables(tmp_path: Path) -> None:
    policy = licenses.load_policy(COMMITTED_POLICY)
    records = [
        *licenses_node.parse_report(read_fixture("pnpm-dev.json"), Scope.DEV),
        *licenses_go.parse_report(
            read_fixture("go-report.csv"), main_module="example.invalid/golicprobe"
        ),
        *licenses_python.records_from(
            python_fixture(), runtime=frozenset({"pypdfium2"}), workspace=frozenset({"fdp-init"})
        ),
    ]
    assessments = licenses.assess(records, policy)
    report = licenses.render_report(
        assessments, ("go: skipped",), policy, ecosystems=("go", "node", "python")
    )
    assert "## Runtime dependencies" in report
    assert "## Dev-only copyleft, flagged and unaudited licences" in report
    assert "## Overrides used" in report
    assert "### go" in report
    assert "| node:lightningcss | 1.33.0 | MPL-2.0 | flagged | no |" in report
    assert "- go: skipped" in report
    (tmp_path / "licenses.md").write_text(report, encoding="utf-8")


def test_the_report_is_byte_identical_for_the_same_input() -> None:
    policy = licenses.load_policy(COMMITTED_POLICY)
    assessments = licenses.assess(copyleft_records(Scope.DEV), policy)
    first = licenses.render_report(assessments, ("a notice",), policy, ecosystems=("node",))
    second = licenses.render_report(assessments, ("a notice",), policy, ecosystems=("node",))
    assert first == second


def test_a_licence_holding_a_pipe_cannot_break_out_of_its_table_cell(tmp_path: Path) -> None:
    policy = load_written_policy(tmp_path)
    record = Record("node", "example", "1.0.0", "MIT | GPL-3.0-only", Scope.DEV)
    report = licenses.render_report(
        licenses.assess([record], policy), (), policy, ecosystems=("node",)
    )
    assert "MIT \\| GPL-3.0-only" in report


# --- the command --------------------------------------------------------------


def stub(records: Sequence[Record], notices: Sequence[str] = ()) -> object:
    """A collector that answers with fixed records, so the CLI runs offline."""

    def collect(_root: Path) -> Collected:
        return Collected(tuple(records), tuple(notices))

    return collect


@pytest.fixture
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Silence every collector; a test enables the ones it needs."""
    for ecosystem in licenses.COLLECTORS:
        monkeypatch.setitem(licenses.COLLECTORS, ecosystem, stub(()))


def audit(tmp_path: Path, *extra: str) -> int:
    return cli.main(
        [
            "licenses",
            "--root",
            str(tmp_path),
            "--policy",
            str(COMMITTED_POLICY),
            "--report",
            "reports/licenses.md",
            *extra,
        ]
    )


@pytest.mark.usefixtures("offline")
def test_the_audit_writes_its_report_and_passes_on_permissive_dependencies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    records = licenses_node.parse_report(read_fixture("pnpm-dev.json"), Scope.DEV)
    monkeypatch.setitem(licenses.COLLECTORS, "node", stub(records, ("node: a notice",)))
    assert audit(tmp_path) == EXIT_OK
    written = (tmp_path / "reports" / "licenses.md").read_text(encoding="utf-8")
    assert "# Dependency licences" in written
    assert "- node: a notice" in written
    assert licenses.DEFAULT_POLICY in written


@pytest.mark.usefixtures("offline")
def test_the_audit_fails_on_a_runtime_copyleft_dependency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setitem(licenses.COLLECTORS, "node", stub(copyleft_records(Scope.RUNTIME)))
    assert audit(tmp_path) == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert "node:example-copyleft-widget@1.0.0" in out


@pytest.mark.usefixtures("offline")
def test_json_output_lists_every_violation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setitem(licenses.COLLECTORS, "node", stub(copyleft_records(Scope.RUNTIME)))
    assert audit(tmp_path, "--format", "json") == EXIT_FINDINGS
    payload = json.loads(capsys.readouterr().out)
    assert payload["check"] == "licenses"
    assert payload["ok"] is False
    assert len(payload["findings"]) == 2


@pytest.mark.usefixtures("offline")
def test_one_ecosystem_can_be_audited_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(licenses.COLLECTORS, "node", stub(copyleft_records(Scope.RUNTIME)))
    assert audit(tmp_path, "--ecosystem", "python") == EXIT_OK
    written = (tmp_path / "reports" / "licenses.md").read_text(encoding="utf-8")
    assert "Ecosystems audited: python." in written


@pytest.mark.usefixtures("offline")
def test_a_collector_that_cannot_run_its_tool_is_an_environment_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def broken(_root: Path) -> Collected:
        raise CollectorError("pnpm is not installed")

    monkeypatch.setitem(licenses.COLLECTORS, "node", broken)
    assert audit(tmp_path) == EXIT_ERROR
    assert "pnpm is not installed" in capsys.readouterr().err


@pytest.mark.usefixtures("offline")
def test_a_missing_policy_is_an_environment_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    exit_code = cli.main(["licenses", "--root", str(tmp_path), "--policy", "nowhere.toml"])
    assert exit_code == EXIT_ERROR
    assert "nowhere.toml" in capsys.readouterr().err


def test_the_command_is_discovered_by_the_cli() -> None:
    assert licenses.NAME in {command.name for command in cli.discover()}


# --- the real audit -----------------------------------------------------------


@pytest.mark.network
def test_the_real_audit_passes_over_this_workspace(tmp_path: Path) -> None:
    """The end-to-end gate: the real pnpm, uv and go tools over the workspace.

    Needs an installed workspace (``make install``) and, on a cold Go module
    cache, the network.
    """
    if not (REPO_ROOT / "node_modules").is_dir():
        pytest.skip("the pnpm workspace is not installed; run `make install` first")
    report = tmp_path / "licenses.md"
    assert cli.main(["licenses", "--root", str(REPO_ROOT), "--report", str(report)]) == EXIT_OK
    written = report.read_text(encoding="utf-8")
    assert "## Runtime dependencies" in written
    assert "## Dev-only copyleft, flagged and unaudited licences" in written
    assert "## Overrides used" in written

# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks gt-paths`` over git fixture repositories.

Each pattern of the check gets a file that must be reported and a file that
must not be.
"""

from __future__ import annotations

import json

import pytest

from fdp_repo_checks.commands import gt_paths
from fdp_repo_checks.findings import EXIT_FINDINGS, EXIT_OK
from helpers import HEADER_OK, FixtureRepo

CLEAN_RULE = HEADER_OK + "export const rule = { id: 'oil_leak' };\n"


def test_an_empty_repository_passes(repo: FixtureRepo, capsys: pytest.CaptureFixture[str]) -> None:
    assert repo.run("gt-paths") == EXIT_OK
    assert "gt-paths: ok (0 files checked)" in capsys.readouterr().out


def test_clean_backend_and_frontend_sources_pass(repo: FixtureRepo) -> None:
    repo.write("apps/backend/src/detection/rules.ts", CLEAN_RULE)
    repo.write("apps/frontend/src/App.tsx", HEADER_OK + "export const App = () => null;\n")
    assert repo.run("gt-paths") == EXIT_OK


def test_a_package_import_in_the_backend_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write(
        "apps/backend/src/detection/rules.ts",
        HEADER_OK + "import { table } from '@fdp/ground-truth';\n",
    )
    assert repo.run("gt-paths") == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert "apps/backend/src/detection/rules.ts:3:" in out
    assert "@fdp/ground-truth" in out


def test_an_overlapping_match_is_reported_once(repo: FixtureRepo) -> None:
    repo.write(
        "apps/backend/src/detection/rules.ts",
        HEADER_OK + "import { table } from '@fdp/ground-truth';\n",
    )
    findings = gt_paths.scan_file(repo.path, "apps/backend/src/detection/rules.ts")
    assert len(findings) == 1, "the package pattern swallows the bare name pattern"


def test_the_same_import_inside_the_overlay_is_allowed(repo: FixtureRepo) -> None:
    repo.write(
        "apps/backend/src/overlay/recorder.ts",
        HEADER_OK + "import { table } from '@fdp/ground-truth';\n",
    )
    assert repo.run("gt-paths") == EXIT_OK


def test_an_underscored_name_is_a_finding(repo: FixtureRepo) -> None:
    repo.write("apps/frontend/src/api.ts", HEADER_OK + "const key = 'GROUND_TRUTH';\n")
    assert repo.run("gt-paths") == EXIT_FINDINGS


def test_a_topic_literal_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write(
        "apps/backend/src/mqtt/subscriptions.ts",
        HEADER_OK + 'client.subscribe("gt/unit-1/injections");\n',
    )
    assert repo.run("gt-paths") == EXIT_FINDINGS
    assert "topic reference" in capsys.readouterr().out


def test_a_plant_topic_literal_is_allowed(repo: FixtureRepo) -> None:
    repo.write(
        "apps/backend/src/mqtt/subscriptions.ts",
        HEADER_OK + 'client.subscribe("plant/unit-1/telemetry");\n',
    )
    assert repo.run("gt-paths") == EXIT_OK


def test_a_ground_truth_table_name_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write(
        "apps/backend/src/repo/episodes.ts",
        HEADER_OK + "const sql = 'select * from gt.injections';\n",
    )
    assert repo.run("gt-paths") == EXIT_FINDINGS
    assert "table reference" in capsys.readouterr().out


def test_an_unrelated_gt_prefix_is_not_a_finding(repo: FixtureRepo) -> None:
    repo.write("apps/backend/src/repo/episodes.ts", HEADER_OK + "const value = gt.count;\n")
    assert repo.run("gt-paths") == EXIT_OK


def test_a_dockerfile_hit_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("apps/backend/Dockerfile", HEADER_OK + "COPY packages/ground-truth /gt\n")
    assert repo.run("gt-paths") == EXIT_FINDINGS
    assert "apps/backend/Dockerfile:3:" in capsys.readouterr().out


def test_a_package_manifest_hit_is_a_finding(repo: FixtureRepo) -> None:
    repo.write(
        "apps/frontend/package.json",
        '{\n  "dependencies": { "@fdp/ground-truth": "workspace:*" }\n}\n',
    )
    assert repo.run("gt-paths") == EXIT_FINDINGS


def test_a_backend_test_is_out_of_scope(repo: FixtureRepo) -> None:
    repo.write(
        "apps/backend/test/overlay.spec.ts",
        HEADER_OK + "import { table } from '@fdp/ground-truth';\n",
    )
    assert repo.run("gt-paths") == EXIT_OK


def test_json_output_carries_path_line_and_reason(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("apps/frontend/src/api.ts", HEADER_OK + "const key = 'ground-truth';\n")
    assert repo.run("gt-paths", "--format", "json") == EXIT_FINDINGS
    payload = json.loads(capsys.readouterr().out)
    assert payload["check"] == "gt-paths"
    assert payload["findings"][0]["path"] == "apps/frontend/src/api.ts"
    assert payload["findings"][0]["line"] == 3


def test_generated_and_vendored_directories_are_skipped(repo: FixtureRepo) -> None:
    repo.write(
        "apps/frontend/src/node_modules/vendor.js",
        "module.exports = require('@fdp/ground-truth');\n",
    )
    assert repo.run("gt-paths") == EXIT_OK

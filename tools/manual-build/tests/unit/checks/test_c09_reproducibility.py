# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #9: the manifest, the rebuild and the hygiene of the committed PDFs.

The rebuild is handed in through the context, the way ``--rebuilt-dir`` hands
CI's container build over, so every branch of check #9 is reachable without
rendering: a source edited after the build, a rebuild whose text differs, a
manifest that is not there, and each hygiene assertion on its own.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from fdp_manual_build.checks.base import CheckContext, Status
from fdp_manual_build.checks.c09_reproducibility import (
    EXPECTED_PRODUCER,
    MANIFEST_NAME,
    ReproducibilityCheck,
    hygiene,
)
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.manifest import BuildRecord, PdfOutput, hash_file, write_manifest

from .factories import FakePdf, context

SOURCE = Path("manual") / "spec" / "alarms.yaml"
WALL_TIME = datetime(2026, 1, 15, tzinfo=UTC)
CLEAN_TEXT = "c" * 64
CLEAN_PDF = "d" * 64


def built(**overrides: object) -> FakePdf:
    """The committed clean PDF, or a rebuild of it."""
    defaults: dict[str, object] = {
        "pages": ["8 Problem solving", "9 Technical data"],
        "name": "mini-clean.pdf",
        "text_sha256": CLEAN_TEXT,
        "pdf_sha256": CLEAN_PDF,
    }
    merged = {**defaults, **overrides}
    pages = merged.pop("pages")
    return FakePdf(pages, **merged)  # type: ignore[arg-type]


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A checkout with one source file and a place for the built manual."""
    source = tmp_path / SOURCE
    source.parent.mkdir(parents=True)
    source.write_text("alarms: []\n", encoding="utf-8")
    (tmp_path / "data" / "manual").mkdir(parents=True)
    return tmp_path


def manifest_for(repo: Path, cfg: BuildConfig, clean: FakePdf) -> Path:
    """Write the manifest the committed build would have left behind."""
    path = repo / "data" / "manual" / MANIFEST_NAME
    write_manifest(
        path,
        BuildRecord(
            source_date_epoch=cfg.source_date_epoch,
            inputs={SOURCE.as_posix(): hash_file(repo / SOURCE)},
            outputs={
                "clean": PdfOutput(
                    path="data/manual/mini-clean.pdf",
                    pdf_sha256=clean.pdf_sha256,
                    text_sha256=clean.text_sha256,
                    pages=clean.page_count,
                    size=clean.size,
                )
            },
            wall_time=WALL_TIME,
        ),
        environ={},
    )
    return path


def ctx_for(
    repo: Path, cfg: BuildConfig, clean: FakePdf, rebuilt: FakePdf | None, **extra: object
) -> CheckContext:
    """A context whose committed ``clean`` is ``clean`` and rebuild ``rebuilt``."""
    return context(
        repo_root=repo,
        manual_root=repo / "manual",
        cfg=cfg,
        pdfs={"clean": clean},
        rebuilt=None if rebuilt is None else {"clean": rebuilt},
        variant_dir=repo / "data" / "manual",
        **extra,  # type: ignore[arg-type]
    )


def codes(result: object) -> list[str]:
    """Every finding code of a result, in order."""
    return [item.code for item in result.findings]  # type: ignore[attr-defined]


# --- the manifest ------------------------------------------------------------


def test_a_faithful_rebuild_passes(repo: Path, mini_config: BuildConfig) -> None:
    clean = built()
    manifest_for(repo, mini_config, clean)
    result = ReproducibilityCheck().run(ctx_for(repo, mini_config, clean, built()))
    assert result.status is Status.PASS, codes(result)
    assert result.metrics["rebuild"] == "rebuilt-dir"
    assert result.metrics["built_in"] == "native"
    assert result.metrics["clean_text_sha256"] == CLEAN_TEXT
    assert result.metrics["clean_bytes_identical"] == "true"


def test_a_source_changed_after_the_build_is_named(repo: Path, mini_config: BuildConfig) -> None:
    clean = built()
    manifest_for(repo, mini_config, clean)
    (repo / SOURCE).write_text("alarms: [{code: W104}]\n", encoding="utf-8")
    result = ReproducibilityCheck().run(ctx_for(repo, mini_config, clean, built()))
    assert result.status is Status.FAIL
    changed = next(
        item for item in result.findings if item.code == "reproducibility.inputs_changed"
    )
    assert changed.data["changed"] == [SOURCE.as_posix()]


def test_a_source_that_is_gone_is_named(repo: Path, mini_config: BuildConfig) -> None:
    clean = built()
    manifest_for(repo, mini_config, clean)
    (repo / SOURCE).unlink()
    result = ReproducibilityCheck().run(ctx_for(repo, mini_config, clean, built()))
    assert "reproducibility.inputs_missing" in codes(result)


def test_a_missing_manifest_fails_before_any_rebuild(repo: Path, mini_config: BuildConfig) -> None:
    result = ReproducibilityCheck().run(ctx_for(repo, mini_config, built(), built()))
    assert result.status is Status.FAIL
    assert codes(result) == ["reproducibility.manifest_missing"]


# --- the rebuild -------------------------------------------------------------


def test_a_rebuild_whose_text_differs_fails(repo: Path, mini_config: BuildConfig) -> None:
    clean = built()
    manifest_for(repo, mini_config, clean)
    fresh = built(text_sha256="e" * 64, pdf_sha256="f" * 64)
    result = ReproducibilityCheck().run(ctx_for(repo, mini_config, clean, fresh))
    assert result.status is Status.FAIL
    assert "reproducibility.text_hash" in codes(result)
    assert "reproducibility.bytes_differ" in codes(result)
    bytes_differ = next(
        item for item in result.findings if item.code == "reproducibility.bytes_differ"
    )
    assert str(bytes_differ.level) == "REPORT"
    assert result.metrics["clean_bytes_identical"] == "false"


def test_a_rebuild_with_another_page_count_fails(repo: Path, mini_config: BuildConfig) -> None:
    clean = built()
    manifest_for(repo, mini_config, clean)
    fresh = built(pages=["8 Problem solving"])
    result = ReproducibilityCheck().run(ctx_for(repo, mini_config, clean, fresh))
    assert "reproducibility.page_count" in codes(result)


def test_a_committed_pdf_the_manifest_does_not_record_fails(
    repo: Path, mini_config: BuildConfig
) -> None:
    manifest_for(repo, mini_config, built())
    other = built(pdf_sha256="9" * 64)
    result = ReproducibilityCheck().run(ctx_for(repo, mini_config, other, other))
    assert "reproducibility.manifest_stale" in codes(result)


def test_a_rebuild_that_cannot_be_read_is_an_error(
    repo: Path, mini_config: BuildConfig, tmp_path: Path
) -> None:
    clean = built()
    manifest_for(repo, mini_config, clean)
    empty = tmp_path / "rebuild"
    empty.mkdir()
    ctx = ctx_for(repo, mini_config, clean, None, rebuilt_dir=empty)
    result = ReproducibilityCheck().run(ctx)
    assert result.status is Status.ERROR
    assert "reproducibility.rebuild_failed" in codes(result)


def test_without_a_pdf_the_row_can_be_skipped(repo: Path, mini_config: BuildConfig) -> None:
    ctx = context(
        repo_root=repo,
        manual_root=repo / "manual",
        cfg=mini_config,
        variant_dir=repo / "data" / "manual",
        require_pdf=False,
    )
    result = ReproducibilityCheck().run(ctx)
    assert result.status is Status.SKIPPED
    assert codes(result) == ["check.pdf_absent"]


# --- hygiene -----------------------------------------------------------------


def test_a_clean_build_has_nothing_to_report(mini_config: BuildConfig) -> None:
    assert hygiene(built(), mini_config) == []


def test_the_producer_must_be_the_pinned_renderer(mini_config: BuildConfig) -> None:
    pdf = built(metadata={"Producer": "Other Writer 1.0"})
    assert [item.code for item in hygiene(pdf, mini_config)] == ["reproducibility.producer"]
    assert EXPECTED_PRODUCER in hygiene(pdf, mini_config)[0].message


def test_the_pdf_version_is_fixed(mini_config: BuildConfig) -> None:
    pdf = built(pdf_version="1.4")
    assert [item.code for item in hygiene(pdf, mini_config)] == ["reproducibility.pdf_version"]


def test_only_the_fixed_creation_date_is_allowed(mini_config: BuildConfig) -> None:
    allowed = {"Producer": EXPECTED_PRODUCER, "CreationDate": "D:20260115000000+00'00"}
    assert hygiene(built(metadata=allowed), mini_config) == []
    drifted = built(metadata={**allowed, "CreationDate": "D:20260707120000+00'00"})
    assert [item.code for item in hygiene(drifted, mini_config)] == [
        "reproducibility.metadata_date"
    ]
    stamped = built(metadata={**allowed, "ModDate": "D:20260115000000+00'00"})
    assert [item.code for item in hygiene(stamped, mini_config)] == [
        "reproducibility.metadata_date"
    ]


def test_a_font_that_is_not_ibm_plex_is_a_finding(mini_config: BuildConfig) -> None:
    pdf = built(fontnames=("ABCDEF+IBM-Plex-Sans", "GHIJKL+Some-Other-Face"))
    findings = hygiene(pdf, mini_config)
    assert [item.code for item in findings] == ["reproducibility.fallback_font"]
    assert findings[0].data["fontname"] == "GHIJKL+Some-Other-Face"


def test_active_content_in_the_raw_bytes_is_a_finding(mini_config: BuildConfig) -> None:
    pdf = built(markers=(b"/JavaScript", b"/AcroForm"))
    assert [item.code for item in hygiene(pdf, mini_config)] == [
        "reproducibility.active_content",
        "reproducibility.active_content",
    ]

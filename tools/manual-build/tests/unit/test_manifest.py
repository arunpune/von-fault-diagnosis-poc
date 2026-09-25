# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The build manifest: shape, stable bytes and a useful diff.

No PDF and no WeasyPrint here — :mod:`fdp_manual_build.manifest` must stay
importable on a host without Pango, because acceptance check #9 reads a
committed manifest before it renders anything.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build import __version__
from fdp_manual_build.errors import BuildError
from fdp_manual_build.manifest import (
    CONTAINER_ENV,
    IMAGE_DIGEST_ENV,
    IMAGE_REF_ENV,
    SCHEMA,
    TOOL_DISTRIBUTIONS,
    BuildRecord,
    FileOutput,
    Manifest,
    PdfOutput,
    compare,
    hash_file,
    inputs_tree_sha256,
    manifest_document,
    read_manifest,
    tool_versions,
    write_manifest,
)

WALL_TIME = datetime(2026, 1, 15, 9, 30, tzinfo=UTC)
SOURCE_DATE_EPOCH = 1768435200
IMAGE_REF = "python:3.13.15-slim-trixie"
IMAGE_DIGEST = "sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0"
PACKAGES = ("libpango-1.0-0=1.56.3-1", "libharfbuzz0b=10.2.0-1+deb13u1")

MANIFEST_KEYS = (
    "schema",
    "built_in",
    "image",
    "tool_versions",
    "source_date_epoch",
    "inputs",
    "inputs_tree_sha256",
    "outputs",
    "wall_time",
)


def _clean() -> PdfOutput:
    return PdfOutput(
        path="data/manual/cau-7-clean.pdf",
        pdf_sha256="a" * 64,
        text_sha256="b" * 64,
        pages=38,
        size=412345,
    )


def _realistic() -> PdfOutput:
    return PdfOutput(
        path="data/manual/cau-7-realistic.pdf",
        pdf_sha256="c" * 64,
        text_sha256="d" * 64,
        pages=44,
        size=455321,
    )


def _record() -> BuildRecord:
    return BuildRecord(
        source_date_epoch=SOURCE_DATE_EPOCH,
        inputs={
            "manual/spec/signals.yaml": "2" * 64,
            "manual/spec/machine.yaml": "1" * 64,
        },
        outputs={
            "clean": _clean(),
            "realistic": _realistic(),
            "catalog": FileOutput(path="tools/eval/fixtures/catalog.json", sha256="e" * 64),
        },
        wall_time=WALL_TIME,
    )


@pytest.fixture
def packages_file(tmp_path: Path) -> Path:
    """A stand-in for ``/etc/fdp-system-packages.txt`` inside the image."""
    path = tmp_path / "fdp-system-packages.txt"
    path.write_text("\n".join(PACKAGES) + "\n", encoding="utf-8")
    return path


def _container(packages_file: Path) -> Manifest:
    return manifest_document(
        _record(),
        environ={
            CONTAINER_ENV: "1",
            IMAGE_REF_ENV: IMAGE_REF,
            IMAGE_DIGEST_ENV: IMAGE_DIGEST,
        },
        system_packages_path=packages_file,
    )


def test_a_container_build_records_the_image_and_its_packages(packages_file: Path) -> None:
    document = _container(packages_file)
    assert tuple(document) == MANIFEST_KEYS
    assert document["schema"] == SCHEMA
    assert document["built_in"] == "container"
    assert document["image"] == {
        "ref": IMAGE_REF,
        "digest": IMAGE_DIGEST,
        "system_packages": list(PACKAGES),
    }
    assert document["source_date_epoch"] == SOURCE_DATE_EPOCH
    assert document["wall_time"] == "2026-01-15T09:30:00Z"


def test_a_native_build_records_no_image(tmp_path: Path) -> None:
    document = manifest_document(
        _record(), environ={}, system_packages_path=tmp_path / "absent.txt"
    )
    assert document["built_in"] == "native"
    assert document["image"] is None


def test_a_container_without_the_package_file_records_an_empty_list(tmp_path: Path) -> None:
    document = manifest_document(
        _record(),
        environ={CONTAINER_ENV: "1", IMAGE_REF_ENV: IMAGE_REF},
        system_packages_path=tmp_path / "absent.txt",
    )
    assert document["image"] == {
        "ref": IMAGE_REF,
        "digest": None,
        "system_packages": [],
    }


def test_the_outputs_keep_the_shape_of_section_10_4(packages_file: Path) -> None:
    outputs = _container(packages_file)["outputs"]
    assert list(outputs) == ["clean", "realistic", "catalog"]
    assert outputs["clean"] == {
        "path": "data/manual/cau-7-clean.pdf",
        "pdf_sha256": "a" * 64,
        "text_sha256": "b" * 64,
        "pages": 38,
        "bytes": 412345,
    }
    assert outputs["catalog"] == {
        "path": "tools/eval/fixtures/catalog.json",
        "sha256": "e" * 64,
    }


def test_the_tool_versions_are_read_from_the_installed_distributions() -> None:
    versions = tool_versions()
    expected = [key for key, _ in TOOL_DISTRIBUTIONS] + ["python", "fdp-manual-build"]
    assert list(versions) == expected
    assert versions["weasyprint"] == "70.0"
    assert versions["jinja2"] == "3.1.6"
    assert versions["fdp-manual-build"] == __version__
    assert versions["python"].startswith("3.13.")


def test_the_inputs_are_sorted_and_the_tree_hash_is_order_independent(
    packages_file: Path,
) -> None:
    document = _container(packages_file)
    assert list(document["inputs"]) == ["manual/spec/machine.yaml", "manual/spec/signals.yaml"]
    reversed_inputs = dict(reversed(list(document["inputs"].items())))
    assert inputs_tree_sha256(reversed_inputs) == document["inputs_tree_sha256"]


def test_the_tree_hash_is_the_documented_recipe() -> None:
    inputs = {"b.yaml": "2" * 64, "a.yaml": "1" * 64}
    expected = hashlib.sha256(f"a.yaml\0{'1' * 64}\nb.yaml\0{'2' * 64}\n".encode()).hexdigest()
    assert inputs_tree_sha256(inputs) == expected


def test_a_changed_input_changes_the_tree_hash() -> None:
    before = inputs_tree_sha256({"a.yaml": "1" * 64})
    after = inputs_tree_sha256({"a.yaml": "9" * 64})
    assert before != after


def test_writing_the_same_record_twice_gives_the_same_bytes(
    tmp_path: Path, packages_file: Path
) -> None:
    environ = {CONTAINER_ENV: "1", IMAGE_REF_ENV: IMAGE_REF, IMAGE_DIGEST_ENV: IMAGE_DIGEST}
    first = tmp_path / "one" / "build-manifest.json"
    second = tmp_path / "two" / "build-manifest.json"
    write_manifest(first, _record(), environ=environ, system_packages_path=packages_file)
    write_manifest(second, _record(), environ=environ, system_packages_path=packages_file)
    assert first.read_bytes() == second.read_bytes()
    assert first.read_text(encoding="utf-8").endswith("}\n")


def test_a_written_manifest_reads_back_unchanged(tmp_path: Path, packages_file: Path) -> None:
    path = tmp_path / "build-manifest.json"
    written = write_manifest(
        path, _record(), environ={CONTAINER_ENV: "1"}, system_packages_path=packages_file
    )
    assert read_manifest(path) == written


def test_reading_rejects_a_foreign_document(tmp_path: Path) -> None:
    path = tmp_path / "build-manifest.json"
    path.write_text(json.dumps({"schema": "urn:fdp:manifest:other:v1"}), encoding="utf-8")
    with pytest.raises(BuildError, match="expected 'urn:fdp:manifest:manual-build:v1'"):
        read_manifest(path)


def test_reading_reports_broken_json(tmp_path: Path) -> None:
    path = tmp_path / "build-manifest.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(BuildError, match="cannot be read"):
        read_manifest(path)


def test_compare_ignores_the_wall_time(packages_file: Path) -> None:
    manifest = _container(packages_file)
    rebuilt: dict[str, Any] = dict(manifest)
    rebuilt["wall_time"] = "2026-09-20T11:00:00Z"
    assert compare(manifest, rebuilt) == []


def test_compare_reports_a_text_hash_difference(packages_file: Path) -> None:
    manifest = _container(packages_file)
    rebuilt = json.loads(json.dumps(manifest))
    rebuilt["outputs"]["realistic"]["text_sha256"] = "f" * 64
    assert compare(manifest, rebuilt) == [
        f"outputs.realistic.text_sha256: {'d' * 64!r} != {'f' * 64!r}"
    ]


def test_compare_reports_added_removed_and_shorter_fields(packages_file: Path) -> None:
    manifest = _container(packages_file)
    rebuilt = json.loads(json.dumps(manifest))
    del rebuilt["inputs"]["manual/spec/machine.yaml"]
    rebuilt["image"]["system_packages"] = [PACKAGES[0]]
    rebuilt["outputs"]["scanned"] = {"path": "data/manual/cau-7-scanned.pdf", "sha256": "0" * 64}
    assert compare(manifest, rebuilt) == [
        "image.system_packages: 2 entries against 1",
        "inputs.manual/spec/machine.yaml: missing from the rebuild",
        "outputs.scanned: only in the rebuild",
    ]


def test_hash_file_matches_sha256_of_the_bytes(tmp_path: Path) -> None:
    path = tmp_path / "machine.yaml"
    path.write_bytes(b"name: CAU-7\n")
    assert hash_file(path) == hashlib.sha256(b"name: CAU-7\n").hexdigest()


def test_a_file_output_hashes_its_payload() -> None:
    entry = FileOutput.of("tools/eval/fixtures/catalog.json", b"{}")
    assert entry.sha256 == hashlib.sha256(b"{}").hexdigest()
    assert entry.as_json() == {
        "path": "tools/eval/fixtures/catalog.json",
        "sha256": hashlib.sha256(b"{}").hexdigest(),
    }

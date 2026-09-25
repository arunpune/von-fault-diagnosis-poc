# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The pinned image builds and renders the same bytes twice.

This is the proof behind "only container builds are committed": the same
static HTML rendered twice inside the image gives byte-identical PDFs, and the
image carries the Pango and HarfBuzz versions the manifest records. It is
marked ``docker`` and skipped when no daemon answers.

Run it with::

    uv run --package fdp-manual-build pytest \\
        tools/manual-build/tests/e2e/test_docker_build.py -m docker
"""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Iterator, Sequence
from pathlib import Path

import pytest

pytestmark = pytest.mark.docker

DOCKERFILE = "tools/manual-build/Dockerfile"
FIXTURE = "/work/tools/manual-build/tests/fixtures/html/sample.html"
SYSTEM_PACKAGES = "/etc/fdp-system-packages.txt"
#: Trixie 13.7, verified on 2026-09-19.
PINNED_PACKAGES = ("libpango-1.0-0=1.56.3-1", "libharfbuzz0b=10.2.0-1+deb13u1")
#: The fixture rendered with the clean stylesheets of manual/templates/css.
#: It was 3 before fonts.css and base.css existed, 4 until base.css was set at
#: 9.5 pt on 1.26 to bring the manual inside `pdf.page_budget`, and 3 again
#: since: the sixty-row table still breaks over
#: a page boundary, and the two-column section now follows it on the same
#: page. A change to those sheets moves this number and is meant to be
#: noticed.
EXPECTED_PAGES = 3
#: A tag per process, so parallel runs never delete each other's image.
TAG = f"fdp-manual-build:test-{os.getpid()}"


def _run(argv: Sequence[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    # Fixed argv, no shell.
    return subprocess.run(list(argv), cwd=cwd, capture_output=True, text=True, check=False)


@pytest.fixture(scope="module")
def image(repo_root: Path) -> Iterator[str]:
    """Build the pinned image from the repository root and remove it after."""
    if shutil.which("docker") is None:
        pytest.skip("docker is not on PATH")
    if _run(["docker", "info"]).returncode != 0:
        pytest.skip("no Docker daemon answers")
    built = _run(["docker", "build", "-f", DOCKERFILE, "-t", TAG, "."], cwd=repo_root)
    assert built.returncode == 0, built.stderr[-4000:]
    try:
        yield TAG
    finally:
        _run(["docker", "rmi", "-f", TAG])


@pytest.fixture(scope="module")
def build_dir(repo_root: Path) -> Iterator[Path]:
    """A gitignored directory inside the mount the container may write to."""
    directory = repo_root / "tools" / "manual-build" / ".build" / f"e2e-{os.getpid()}"
    directory.mkdir(parents=True, exist_ok=True)
    try:
        yield directory
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def _render(image: str, repo_root: Path, out: str) -> subprocess.CompletedProcess[str]:
    return _run(
        [
            "docker",
            "run",
            "--rm",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "-v",
            f"{repo_root}:/work",
            # The renderer is allowed to run without the stylesheets; now that
            # they exist the variable changes nothing.
            "-e",
            "FDP_MANUAL_ALLOW_MISSING_CSS=1",
            image,
            "render",
            "--html",
            FIXTURE,
            "--out",
            out,
        ]
    )


def test_two_container_renders_are_byte_identical(
    image: str, repo_root: Path, build_dir: Path
) -> None:
    relative = build_dir.relative_to(repo_root).as_posix()
    outputs: list[Path] = []
    for name in ("a.pdf", "b.pdf"):
        rendered = _render(image, repo_root, f"/work/{relative}/{name}")
        assert rendered.returncode == 0, rendered.stderr[-4000:]
        assert f"{EXPECTED_PAGES} pages" in rendered.stdout
        outputs.append(build_dir / name)
    first, second = (path.read_bytes() for path in outputs)
    assert first.startswith(b"%PDF-1.7")
    assert first == second


def test_the_image_records_the_pinned_system_packages(image: str) -> None:
    listed = _run(["docker", "run", "--rm", "--entrypoint", "cat", image, SYSTEM_PACKAGES])
    assert listed.returncode == 0, listed.stderr[-4000:]
    recorded = set(listed.stdout.split())
    for package in PINNED_PACKAGES:
        assert package in recorded, listed.stdout


def test_the_image_marks_itself_as_the_container_build(image: str) -> None:
    printed = _run(["docker", "run", "--rm", "--entrypoint", "printenv", image])
    assert printed.returncode == 0, printed.stderr[-4000:]
    environment = dict(line.split("=", 1) for line in printed.stdout.splitlines() if "=" in line)
    assert environment["FDP_BUILD_IN_CONTAINER"] == "1"
    assert environment["FDP_BUILD_IMAGE_REF"] == "python:3.13.15-slim-trixie"
    assert environment["FDP_BUILD_IMAGE_DIGEST"].startswith("sha256:8d9d0b8b")

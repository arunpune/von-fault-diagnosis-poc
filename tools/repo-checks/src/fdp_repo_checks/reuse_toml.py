# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Read ``REUSE.toml`` the way the REUSE 3.3 specification resolves it.

Two properties matter to the checks in this package:

* a path is resolved against the **last** matching ``[[annotations]]`` table,
  which makes the order of the file load-bearing;
* a pattern is a restricted glob, not a regular expression: ``*`` stops at a
  path separator, ``**`` crosses them, and a leading ``**/`` is optional.
"""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

MARKER = "# --- specific annotations: append below this line, never above ---"
"""The ordering marker between the general and the specific block of ``REUSE.toml``."""

GENERAL_PATTERN_PREFIX = "**/*."
"""A pattern starting like this licenses one file extension everywhere."""


class ReuseTomlError(ValueError):
    """``REUSE.toml`` is missing, unreadable or not shaped like the spec says."""


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Compile a REUSE 3.3 path pattern into an anchored regular expression."""
    prefix = ""
    rest = pattern
    if rest.startswith("**/"):
        # A leading `**/` also matches the repository root itself.
        prefix = "(?:.*/)?"
        rest = rest[3:]
    parts: list[str] = []
    index = 0
    while index < len(rest):
        if rest.startswith("**", index):
            parts.append(".*")
            index += 2
        elif rest[index] == "*":
            parts.append("[^/]*")
            index += 1
        else:
            parts.append(re.escape(rest[index]))
            index += 1
    return re.compile(f"^{prefix}{''.join(parts)}$")


def _as_tuple(value: object, field: str, index: int) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return tuple(str(item) for item in value)
    raise ReuseTomlError(f"annotation {index}: {field} must be a string or a list of strings")


@dataclass(frozen=True)
class Annotation:
    """One ``[[annotations]]`` table, in file order."""

    index: int
    patterns: tuple[str, ...]
    precedence: str
    copyright_texts: tuple[str, ...]
    license_id: str | None
    regexes: tuple[re.Pattern[str], ...]

    def matches(self, path: str) -> bool:
        return any(regex.match(path) for regex in self.regexes)

    @property
    def is_general(self) -> bool:
        """True when a pattern licenses one extension across the whole tree."""
        return any(pattern.startswith(GENERAL_PATTERN_PREFIX) for pattern in self.patterns)


@dataclass(frozen=True)
class ReuseToml:
    """A parsed ``REUSE.toml`` plus the source facts the order check needs."""

    path: Path
    annotations: tuple[Annotation, ...]
    marker_line: int | None
    """1-based line of :data:`MARKER`, or None when the file has no marker."""

    def covered(self, path: str) -> Annotation | None:
        """Return the annotation that governs ``path`` (the last match wins)."""
        winner: Annotation | None = None
        for annotation in self.annotations:
            if annotation.matches(path):
                winner = annotation
        return winner

    def general_annotations_below_marker(self) -> tuple[Annotation, ...]:
        """General tables that sit below the marker and so relicense the block."""
        if self.marker_line is None:
            return ()
        return tuple(
            annotation
            for annotation in self.annotations
            if annotation.is_general and annotation.index > self.marker_line
        )


def _marker_line(text: str) -> int | None:
    for number, line in enumerate(text.splitlines(), start=1):
        if line.strip() == MARKER:
            return number
    return None


def _table_lines(text: str) -> list[int]:
    """1-based line numbers of the ``[[annotations]]`` headers, in file order."""
    return [
        number
        for number, line in enumerate(text.splitlines(), start=1)
        if line.strip() == "[[annotations]]"
    ]


def load(path: Path) -> ReuseToml:
    """Parse ``REUSE.toml`` at ``path``.

    Raises:
        ReuseTomlError: the file is missing, not valid TOML, or an annotation
            lacks the fields the specification requires.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ReuseTomlError(f"{path}: cannot be read ({error.strerror})") from error
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ReuseTomlError(f"{path}: not valid TOML ({error})") from error

    raw_tables = data.get("annotations", [])
    if not isinstance(raw_tables, list):
        raise ReuseTomlError(f"{path}: `annotations` must be an array of tables")
    header_lines = _table_lines(text)
    if len(header_lines) != len(raw_tables):
        # Only possible with an inline array of tables, which the spec forbids.
        raise ReuseTomlError(f"{path}: every annotation must be its own [[annotations]] table")

    annotations: list[Annotation] = []
    for position, raw in enumerate(raw_tables):
        if not isinstance(raw, dict):
            raise ReuseTomlError(f"{path}: annotation {position} is not a table")
        if "path" not in raw:
            raise ReuseTomlError(f"{path}: annotation {position} has no `path`")
        patterns = _as_tuple(raw["path"], "path", position)
        license_value = raw.get("SPDX-License-Identifier")
        if license_value is not None and not isinstance(license_value, str):
            raise ReuseTomlError(
                f"{path}: annotation {position}: SPDX-License-Identifier must be a string"
            )
        copyright_value = raw.get("SPDX-FileCopyrightText", [])
        annotations.append(
            Annotation(
                index=header_lines[position],
                patterns=patterns,
                precedence=str(raw.get("precedence", "closest")),
                copyright_texts=_as_tuple(copyright_value, "SPDX-FileCopyrightText", position),
                license_id=license_value,
                regexes=tuple(glob_to_regex(pattern) for pattern in patterns),
            )
        )
    return ReuseToml(
        path=path,
        annotations=tuple(annotations),
        marker_line=_marker_line(text),
    )

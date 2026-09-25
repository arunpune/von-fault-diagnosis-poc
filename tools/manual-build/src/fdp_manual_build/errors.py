# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The two error types every module of the manual build raises.

:class:`LoadError` is a *record*, not an exception: the loader collects one per
problem so that a single run reports every schema violation, and only then
raises the one :class:`BuildError` that carries them all.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

__all__ = ["BuildError", "LoadError"]

#: ``manual/tools/load.py`` formats its messages as ``<path>:<pointer> <text>``.
_SPEC_MESSAGE = re.compile(r"^(?P<file>[^:]+):(?P<pointer>/\S*)[ ]?(?P<message>.*)$", re.DOTALL)


@dataclass(frozen=True, order=True)
class LoadError:
    """One problem found while reading a manual source file.

    Attributes:
        file: the source-relative path of the offending file.
        json_pointer: RFC 6901 pointer to the offending value, ``"/"`` for the
            document root and ``""`` when the problem is not inside a document.
        message: the human-readable reason.
    """

    file: str
    json_pointer: str
    message: str

    def __str__(self) -> str:
        where = f"{self.file}:{self.json_pointer}" if self.json_pointer else self.file
        return f"{where} {self.message}".strip()

    @classmethod
    def parse(cls, line: str) -> LoadError:
        """Turn one ``SpecError`` message back into a structured record."""
        match = _SPEC_MESSAGE.match(line)
        if match is None:
            return cls(file="", json_pointer="", message=line)
        return cls(
            file=match["file"],
            json_pointer=match["pointer"],
            message=match["message"],
        )


class BuildError(Exception):
    """Raised when the manual cannot be loaded, numbered, assembled or rendered.

    ``errors`` is empty for a single-problem failure and holds one
    :class:`LoadError` per problem when the loader validated a whole tree.
    """

    def __init__(self, message: str, errors: Iterable[LoadError] = ()) -> None:
        self.errors: tuple[LoadError, ...] = tuple(errors)
        super().__init__(_render(message, self.errors))


def _render(message: str, errors: Sequence[LoadError]) -> str:
    if not errors:
        return message
    lines = [message, *(f"  {error}" for error in errors)]
    return "\n".join(lines)

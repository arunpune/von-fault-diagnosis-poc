# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""File enumeration and the hashed n-gram matcher.

The matcher never sees a term in plain text. It normalises a line, builds every
word n-gram up to the longest listed term (with the previous line's tail
prepended so a phrase split across a line break still matches), salts and
hashes each n-gram and looks the digest up in the committed digest file.
Model-code ``re:`` patterns come from the gitignored plain list when it exists
and run against the original line.
"""

import hashlib
import re
import subprocess
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from fdp_blocklist import normalize
from fdp_blocklist.terms import AllowList, HashedList, HashedTerm, RegexTerm

__all__ = [
    "Hit",
    "Matcher",
    "ScanError",
    "Scanner",
    "collect_paths",
    "compile_glob",
    "is_binary",
    "matches_any",
]

#: Directories the walk fallback never descends into (no git available).
_WALK_SKIP: Final[frozenset[str]] = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "build",
        "coverage",
        "dist",
        "node_modules",
    }
)

#: A NUL byte in this many leading bytes marks the file binary.
_BINARY_PROBE: Final = 8192

#: Longest context line echoed under a hit.
_CONTEXT_WIDTH: Final = 120


class ScanError(RuntimeError):
    """The scan could not be set up (bad root, git unavailable for --staged)."""


@dataclass(frozen=True, slots=True)
class Hit:
    """One match, located in a text file or on a PDF page."""

    path: str
    line: int
    col: int
    term: str
    section: str
    context: str
    page: int | None = None

    @property
    def location(self) -> str:
        """``path:line:col``, or ``path:p<page>:line:col`` inside a PDF."""
        if self.page is None:
            return f"{self.path}:{self.line}:{self.col}"
        return f"{self.path}:p{self.page}:{self.line}:{self.col}"

    def as_dict(self) -> dict[str, object]:
        """The JSON shape of ``--format json``."""
        return {
            "path": self.path,
            "page": self.page,
            "line": self.line,
            "col": self.col,
            "term": self.term,
            "section": self.section,
            "context": self.context,
        }


@dataclass(frozen=True, slots=True)
class _Placed:
    """A token with the logical line it came from and its columns in it."""

    text: str
    line: int
    start: int
    end: int
    source: str


def compile_glob(pattern: str) -> re.Pattern[str]:
    """Translate a path glob (``*`` within a segment, ``**`` across) to a regex."""
    parts: list[str] = []
    index = 0
    length = len(pattern)
    while index < length:
        char = pattern[index]
        if char == "*":
            if pattern.startswith("**/", index):
                parts.append("(?:.*/)?")
                index += 3
                continue
            if pattern.startswith("**", index):
                parts.append(".*")
                index += 2
                continue
            parts.append("[^/]*")
        elif char == "?":
            parts.append("[^/]")
        else:
            parts.append(re.escape(char))
        index += 1
    return re.compile(rf"\A{''.join(parts)}\Z")


def matches_any(path: str, patterns: Sequence[re.Pattern[str]]) -> bool:
    """True when ``path`` matches one of the compiled globs."""
    return any(pattern.match(path) is not None for pattern in patterns)


def is_binary(data: bytes) -> bool:
    """True when the probed bytes hold a NUL, the usual binary marker."""
    return b"\x00" in data[:_BINARY_PROBE]


def _git(root: Path, args: Sequence[str]) -> list[str] | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    decoded = completed.stdout.decode("utf-8", errors="surrogateescape")
    return [entry for entry in decoded.split("\0") if entry]


def _walk(root: Path) -> list[str]:
    found: list[str] = []
    stack = [root]
    while stack:
        directory = stack.pop()
        for child in sorted(directory.iterdir()):
            if child.is_symlink():
                continue
            if child.is_dir():
                if child.name not in _WALK_SKIP:
                    stack.append(child)
            elif child.is_file():
                found.append(child.relative_to(root).as_posix())
    return sorted(found)


def _expand(root: Path, requested: Iterable[str]) -> list[str]:
    """Every requested file, and every file under a requested directory.

    A path under ``root`` is named relative to it: a walked directory keeps its
    own prefix, so ``scan manual`` and a whole-repository scan address the same
    file by the same path and the excludes of ``blocklist.toml`` still apply.

    A path the caller points at from outside the root keeps its absolute name
    instead. ``manual/tools/content_checks.py --content <dir>`` scans a content
    directory that need not live in the checkout, and refusing it would make
    rule N3 report an error rather than scan. ``Scanner.scan_file`` resolves an
    absolute name unchanged; the relative excludes simply do not match it.
    """
    base = root.resolve()
    found: list[str] = []
    for entry in requested:
        target = (root / entry).resolve()
        try:
            name = target.relative_to(base)
        except ValueError:
            name = target
        if target.is_dir():
            found.extend((name / item).as_posix() for item in _walk(target))
            continue
        found.append(name.as_posix())
    return found


def collect_paths(
    root: Path,
    requested: Sequence[str],
    *,
    excludes: Sequence[str],
    pdf_globs: Sequence[str] = (),
    staged: bool = False,
) -> list[str]:
    """The repository-relative paths to scan, excludes applied, deduplicated."""
    root = root.resolve()
    if not root.is_dir():
        raise ScanError(f"{root}: not a directory")
    if requested:
        candidates = _expand(root, requested)
    elif staged:
        listed = _git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
        if listed is None:
            raise ScanError(f"{root}: --staged needs a git repository")
        candidates = listed
    else:
        listed = _git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        candidates = listed if listed is not None else _walk(root)
        for pattern in pdf_globs:
            candidates.extend(
                match.relative_to(root).as_posix()
                for match in root.glob(pattern)
                if match.is_file()
            )
    blocked = [compile_glob(pattern) for pattern in excludes]
    kept: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen or matches_any(candidate, blocked):
            continue
        seen.add(candidate)
        kept.append(candidate)
    return sorted(kept)


def _context(line: str) -> str:
    text = line.strip()
    if len(text) <= _CONTEXT_WIDTH:
        return text
    return f"{text[:_CONTEXT_WIDTH]}…"


class Matcher:
    """Hashed n-gram matching over normalised text, plus ``re:`` patterns."""

    def __init__(
        self,
        hashed: HashedList,
        salt: str,
        regex_terms: Sequence[RegexTerm] = (),
    ) -> None:
        self._by_digest: dict[str, HashedTerm] = {entry.digest: entry for entry in hashed.entries}
        widths = [entry.n_tokens for entry in hashed.entries if entry.n_tokens > 0]
        self._width = max(widths) if widths else 1
        self._prefix = f"{salt}\x1f".encode()
        self._regex = tuple((term, re.compile(term.pattern, re.IGNORECASE)) for term in regex_terms)

    @property
    def width(self) -> int:
        """The longest listed term in tokens; the largest n-gram tried."""
        return self._width

    @property
    def regex_count(self) -> int:
        """How many ``re:`` model-code patterns are active."""
        return len(self._regex)

    def _lookup(self, gram: str) -> HashedTerm | None:
        digest = hashlib.sha256(self._prefix + gram.encode()).hexdigest()
        return self._by_digest.get(digest)

    def scan_text(self, path: str, text: str, page: int | None = None) -> list[Hit]:
        """Every hit in ``text``, reported against ``path`` (and ``page``)."""
        hits: list[Hit] = []
        seen: set[tuple[int, int, str, str]] = set()
        tail: list[_Placed] = []
        for number, content in normalize.logical_lines(text):
            folded = normalize.nfkc(content)
            placed = [
                _Placed(token.text, number, token.start, token.end, folded)
                for token in normalize.tokenize(folded)
            ]
            window = tail + placed
            offset = len(tail)
            for hit in self._scan_window(path, window, offset, page):
                key = (hit.line, hit.col, hit.term, hit.section)
                if key not in seen:
                    seen.add(key)
                    hits.append(hit)
            for term, pattern in self._regex:
                for match in pattern.finditer(content):
                    hit = Hit(
                        path=path,
                        line=number,
                        col=match.start() + 1,
                        term=match.group(0),
                        section=term.section,
                        context=_context(content),
                        page=page,
                    )
                    key = (hit.line, hit.col, hit.term, hit.section)
                    if key not in seen:
                        seen.add(key)
                        hits.append(hit)
            tail = placed[-(self._width - 1) :] if self._width > 1 else []
        return hits

    def _scan_window(
        self,
        path: str,
        window: Sequence[_Placed],
        offset: int,
        page: int | None,
    ) -> Iterator[Hit]:
        total = len(window)
        for start in range(total):
            gram = ""
            limit = min(self._width, total - start)
            for size in range(1, limit + 1):
                token = window[start + size - 1]
                gram = token.text if size == 1 else f"{gram} {token.text}"
                if start + size <= offset:
                    continue
                entry = self._lookup(gram)
                if entry is None:
                    continue
                head = window[start]
                matched = head.source[head.start : token.end] if head.line == token.line else gram
                yield Hit(
                    path=path,
                    line=head.line,
                    col=head.start + 1,
                    term=matched,
                    section=entry.section,
                    context=_context(head.source),
                    page=page,
                )


class Scanner:
    """A matcher plus the allow list, reading files under one root."""

    def __init__(self, root: Path, matcher: Matcher, allow: AllowList) -> None:
        self.root = root
        self.matcher = matcher
        self.allow = allow
        self._exemptions = tuple(
            (compile_glob(entry.glob), normalize.canonical(entry.term)) for entry in allow.entries
        )

    def is_allowed(self, hit: Hit) -> bool:
        """True when a reviewed allow-list line exempts this hit."""
        wanted = normalize.canonical(hit.term)
        return any(
            glob.match(hit.path) is not None and term == wanted for glob, term in self._exemptions
        )

    def scan_file(self, relative: str) -> list[Hit]:
        """Scan one text file; a binary, missing or symlinked file yields none."""
        path = self.root / relative
        if path.is_symlink() or not path.is_file():
            return []
        try:
            data = path.read_bytes()
        except OSError:
            return []
        if is_binary(data):
            return []
        text = data.decode("utf-8", errors="replace")
        return [hit for hit in self.matcher.scan_text(relative, text) if not self.is_allowed(hit)]

    def scan_pages(self, relative: str, pages: Iterable[str]) -> list[Hit]:
        """Scan already-extracted page texts, numbering pages from one."""
        hits: list[Hit] = []
        for number, text in enumerate(pages, start=1):
            hits.extend(
                hit
                for hit in self.matcher.scan_text(relative, text, page=number)
                if not self.is_allowed(hit)
            )
        return hits

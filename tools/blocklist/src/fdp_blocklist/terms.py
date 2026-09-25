# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The term list in its two shapes: gitignored plain text and committed digests.

No real brand name may exist anywhere in Git, not even inside this tool. The
plain-text starter list therefore lives in the gitignored
``tools/blocklist/private/blocklist.txt`` and the committed artefact is
``tools/blocklist/data/blocklist.sha256``, one line per hashed form:

``<section>\\t<n_tokens>\\t<sha256 hex>``

with the digest over ``salt + U+001F + <canonical term>``. ``n_tokens`` is the
token count of the hashed string; a multi-word term contributes a second line
for its concatenated form, marked ``0`` so that ``fdp-blocklist list`` can tell
derived variants from terms when it counts a section.
"""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from fdp_blocklist import normalize

__all__ = [
    "MINIMUM_TERMS",
    "MIN_SINGLE_TOKEN_LENGTH",
    "SECTIONS",
    "VARIANT_TOKENS",
    "AllowEntry",
    "AllowList",
    "HashedList",
    "HashedTerm",
    "PlainTerm",
    "RegexTerm",
    "TermList",
    "TermListError",
    "hash_terms",
    "parse_allow_list",
    "parse_hash_file",
    "parse_term_list",
    "read_allow_list",
    "read_hash_file",
    "read_term_list",
    "render_hash_file",
    "section_counts",
    "term_digest",
]

#: Section order of the term list; also the order on disk.
SECTIONS: Final[tuple[str, ...]] = (
    "makers",
    "controllers",
    "product-lines",
    "dryers-filters",
    "lubricants",
    "rail-apu",
)

#: Minimum number of terms per section of the starter list.
MINIMUM_TERMS: Final[dict[str, int]] = {
    "makers": 40,
    "controllers": 15,
    "product-lines": 30,
    "dryers-filters": 12,
    "lubricants": 8,
    "rail-apu": 5,
}

#: A one-token plain term shorter than this matches too much to be useful.
MIN_SINGLE_TOKEN_LENGTH: Final = 4

#: ``n_tokens`` of a derived variant line (the concatenated form of a phrase).
VARIANT_TOKENS: Final = 0

_DIGEST_RE: Final = re.compile(r"\A[0-9a-f]{64}\Z")
_SECTION_RE: Final = re.compile(r"\A\[([a-z][a-z0-9-]*)\]\Z")
_REGEX_PREFIX: Final = "re:"
_NOTE_SEPARATOR: Final = "  #"
_UNIT_SEPARATOR: Final = "\x1f"

_HASH_FILE_HEADER: Final = """\
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Salted SHA-256 digests of the brand blocklist (ground rule 2, CONTRIBUTING.md).
# Generated -- never edit by hand:
#
#     uv run fdp-blocklist hash --from tools/blocklist/private/blocklist.txt
#
# One line per hashed form, tab separated:
#
#     <section>\\t<n_tokens>\\t<sha256 hex>
#
# The digest is sha256(salt + U+001F + canonical term), with the canonical form
# being NFKC + casefold + every run of non-alphanumerics collapsed to one space
# and the salt committed in tools/blocklist/blocklist.toml. <n_tokens> is the
# token count of the hashed string; 0 marks a derived variant (the concatenated
# spelling of a multi-word term), which is not counted as a term of its own.
# Lines are ordered by section, then by digest, so regeneration is byte stable.
#
# The plain terms live in the gitignored tools/blocklist/private/blocklist.txt.
"""


class TermListError(ValueError):
    """A term list, digest file or allow list could not be parsed."""


@dataclass(frozen=True, slots=True)
class PlainTerm:
    """A literal term: matched as a whole-word phrase on normalised text."""

    section: str
    term: str
    note: str = ""


@dataclass(frozen=True, slots=True)
class RegexTerm:
    """A model-code pattern, applied case-insensitively to the original line."""

    section: str
    pattern: str
    note: str = ""


@dataclass(frozen=True, slots=True)
class TermList:
    """A parsed plain-text list: literal terms plus model-code patterns."""

    plain: tuple[PlainTerm, ...]
    regex: tuple[RegexTerm, ...]
    source: str


@dataclass(frozen=True, slots=True)
class AllowEntry:
    """One reviewed exemption: ``<path-glob> :: <term>  # reason``."""

    glob: str
    term: str
    reason: str


@dataclass(frozen=True, slots=True)
class AllowList:
    """Every reviewed exemption, in file order."""

    entries: tuple[AllowEntry, ...]
    source: str


@dataclass(frozen=True, slots=True)
class HashedTerm:
    """One line of the committed digest file."""

    section: str
    n_tokens: int
    digest: str

    @property
    def is_variant(self) -> bool:
        """True for the concatenated spelling of a multi-word term."""
        return self.n_tokens == VARIANT_TOKENS


@dataclass(frozen=True, slots=True)
class HashedList:
    """A parsed digest file."""

    entries: tuple[HashedTerm, ...]
    source: str


def term_digest(salt: str, canonical_term: str) -> str:
    """The salted SHA-256 hex digest of an already canonical term."""
    return hashlib.sha256(f"{salt}{_UNIT_SEPARATOR}{canonical_term}".encode()).hexdigest()


def _split_note(body: str) -> tuple[str, str]:
    head, separator, note = body.partition(_NOTE_SEPARATOR)
    return head.strip(), note.strip() if separator else ""


def parse_term_list(text: str, source: str) -> TermList:
    """Parse the plain-text list, enforcing its section and term rules."""
    plain: list[PlainTerm] = []
    regex: list[RegexTerm] = []
    seen: dict[str, int] = {}
    section = ""
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = _SECTION_RE.match(line)
        if header is not None:
            section = header.group(1)
            if section not in SECTIONS:
                raise TermListError(f"{source}:{number}: unknown section [{section}]")
            continue
        if not section:
            raise TermListError(f"{source}:{number}: term before the first [section] header")
        body, note = _split_note(line)
        if body.startswith(_REGEX_PREFIX):
            pattern = body.removeprefix(_REGEX_PREFIX).strip()
            if not pattern:
                raise TermListError(f"{source}:{number}: empty re: pattern")
            try:
                re.compile(pattern)
            except re.error as error:
                raise TermListError(f"{source}:{number}: bad re: pattern ({error})") from error
            regex.append(RegexTerm(section, pattern, note))
            continue
        canonical = normalize.canonical(body)
        if not canonical:
            raise TermListError(f"{source}:{number}: term has no alphanumeric characters")
        word_count = len(canonical.split())
        if word_count == 1 and len(canonical) < MIN_SINGLE_TOKEN_LENGTH:
            raise TermListError(
                f"{source}:{number}: one-token term shorter than "
                f"{MIN_SINGLE_TOKEN_LENGTH} characters; write it as a phrase or an re: pattern"
            )
        first = seen.get(canonical)
        if first is not None:
            raise TermListError(f"{source}:{number}: duplicate of line {first} after normalisation")
        seen[canonical] = number
        plain.append(PlainTerm(section, body, note))
    return TermList(tuple(plain), tuple(regex), source)


def read_term_list(path: Path) -> TermList:
    """Read and parse a plain-text term list."""
    return parse_term_list(path.read_text(encoding="utf-8"), str(path))


def parse_allow_list(text: str, source: str) -> AllowList:
    """Parse ``<path-glob> :: <term>  # reason`` lines; a reason is mandatory."""
    entries: list[AllowEntry] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        glob, separator, rest = line.partition("::")
        if not separator:
            raise TermListError(f"{source}:{number}: expected '<path-glob> :: <term>  # reason'")
        term, note = _split_note(rest)
        if not glob.strip() or not term:
            raise TermListError(f"{source}:{number}: empty path glob or term")
        if not note:
            raise TermListError(f"{source}:{number}: an exemption needs a '  # reason' comment")
        entries.append(AllowEntry(glob.strip(), term, note))
    return AllowList(tuple(entries), source)


def read_allow_list(path: Path) -> AllowList:
    """Read and parse an allow list; a missing file means no exemptions."""
    if not path.exists():
        return AllowList((), str(path))
    return parse_allow_list(path.read_text(encoding="utf-8"), str(path))


def hash_terms(term_list: TermList, salt: str) -> tuple[HashedTerm, ...]:
    """Digest every literal term, plus the concatenated form of every phrase."""
    hashed: list[HashedTerm] = []
    for entry in term_list.plain:
        canonical = normalize.canonical(entry.term)
        count = len(canonical.split())
        hashed.append(HashedTerm(entry.section, count, term_digest(salt, canonical)))
        if count > 1:
            squashed = normalize.concatenated(entry.term)
            hashed.append(HashedTerm(entry.section, VARIANT_TOKENS, term_digest(salt, squashed)))
    return tuple(hashed)


def render_hash_file(entries: tuple[HashedTerm, ...]) -> str:
    """Render the committed digest file; the byte order is fully determined."""
    unknown = sorted({entry.section for entry in entries} - set(SECTIONS))
    if unknown:
        raise TermListError(f"unknown section(s) {', '.join(unknown)}")
    lines = [_HASH_FILE_HEADER]
    for section in SECTIONS:
        rows = sorted(
            (entry for entry in entries if entry.section == section),
            key=lambda entry: entry.digest,
        )
        lines.extend(f"{row.section}\t{row.n_tokens}\t{row.digest}\n" for row in rows)
    return "".join(lines)


def parse_hash_file(text: str, source: str) -> HashedList:
    """Parse the committed digest file and reject anything malformed."""
    entries: list[HashedTerm] = []
    seen: dict[str, int] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        fields = raw.split("\t")
        if len(fields) != 3:
            raise TermListError(f"{source}:{number}: expected '<section>\\t<n_tokens>\\t<digest>'")
        section, count, digest = fields
        if section not in SECTIONS:
            raise TermListError(f"{source}:{number}: unknown section {section!r}")
        if not count.isdigit():
            raise TermListError(f"{source}:{number}: token count {count!r} is not a number")
        if _DIGEST_RE.match(digest) is None:
            raise TermListError(f"{source}:{number}: not a lowercase 64-character sha256 digest")
        first = seen.get(digest)
        if first is not None:
            raise TermListError(f"{source}:{number}: duplicate digest of line {first}")
        seen[digest] = number
        entries.append(HashedTerm(section, int(count), digest))
    if not entries:
        raise TermListError(f"{source}: holds no digests")
    return HashedList(tuple(entries), source)


def read_hash_file(path: Path) -> HashedList:
    """Read and parse the committed digest file."""
    if not path.exists():
        raise TermListError(f"{path}: digest file not found")
    return parse_hash_file(path.read_text(encoding="utf-8"), str(path))


def section_counts(hashed: HashedList) -> dict[str, int]:
    """Terms per section, derived variants excluded, in section order."""
    counts = dict.fromkeys(SECTIONS, 0)
    for entry in hashed.entries:
        if not entry.is_variant:
            counts[entry.section] += 1
    return counts

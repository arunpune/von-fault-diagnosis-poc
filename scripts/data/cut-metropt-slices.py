#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Cut the MetroPT-3 slices the tests read out of the verified download.

Ground rule 5 lets MetroPT-3 reach a machine by download only, so no row of it
is committed anywhere in this repository. What is committed is
``data/fixtures/metropt3-slices.json``: the definition of every slice the other
areas test with — its time segments, its row count and the SHA-256 of the cut
output. This script turns those definitions back into CSV files under the
gitignored ``data/fixtures/metropt3/``.

It reads the 208 MB source in one streaming pass and never holds more than a
line of it in memory. Every byte it writes is copied verbatim from the source,
the header line and the unnamed index column included, so the same loader
serves a slice and the full file (docs/dataset.md, "Fixture slices"). While
streaming it

* verifies the source byte size and SHA-256 against the definitions and aborts
  on a mismatch, so a truncated or foreign file cannot silently become
  fixtures;
* asserts that the source timestamps are strictly increasing;
* writes each slice to a ``.part`` file and moves it into place only once the
  source has verified.

Usage::

    python3 scripts/data/cut-metropt-slices.py --source <csv> --out-dir <dir> --verify
    python3 scripts/data/cut-metropt-slices.py --only ci-slice --only sim-gate
    python3 scripts/data/cut-metropt-slices.py --report -   # re-measure the definitions

``--verify`` compares the row count and the SHA-256 of every file it wrote with
the definitions and exits 1 on any drift. ``--report`` writes the definitions
document back with the measured values, which is how the committed numbers are
produced after a segment changes; combined with ``--only`` it reports the cut
slices alone, so a full document needs a full run.

Absent source: ``make fixtures`` also runs on machines and in worktrees that
need no dataset. A missing source is therefore a skip (exit 0) unless
``FDP_REQUIRE_DATASET`` is set, in which case it is a failure — the same rule
the tests follow.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, Final

SCHEMA: Final = "urn:fdp:fixture:metropt3-slices:v1"
"""The one schema identifier this script reads and writes."""

DEFAULT_SOURCE: Final = "data/metropt3/MetroPT3(AirCompressor).csv"
DEFAULT_OUT_DIR: Final = "data/fixtures/metropt3"
DEFAULT_DEFINITIONS: Final = "data/fixtures/metropt3-slices.json"

TIMESTAMP_COLUMN: Final = "timestamp"
"""The header name of the column the segments are cut on."""

SKIP_MESSAGE: Final = (
    "fixtures: MetroPT-3 source not found at {path}; "
    "skipping (set METROPT_CSV_HOST or run make fetch-dataset)"
)
"""The absent-source notice, printed verbatim in both modes."""

REQUIRE_DATASET_ENV: Final = "FDP_REQUIRE_DATASET"
SOURCE_ENV: Final = "METROPT_CSV_HOST"

SHA256_PATTERN: Final = re.compile(r"\A[0-9a-f]{64}\Z")

BOUND_SUFFIX: Final = "Z"
"""Segment bounds are UTC instants (docs/dataset.md, "Sampling, size and clock")."""

READ_BLOCK: Final = 1 << 20

EXIT_OK: Final = 0
EXIT_FAILURE: Final = 1


class DefinitionError(ValueError):
    """The definitions document is missing, unreadable or not well formed."""


class CutError(RuntimeError):
    """The source does not match the definitions, or a slice drifted."""


def _as_dict(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise DefinitionError(f"{where}: must be an object")
    return {str(key): item for key, item in value.items()}


def _as_list(value: object, where: str) -> list[object]:
    if not isinstance(value, list) or not value:
        raise DefinitionError(f"{where}: must be a non-empty list")
    return list(value)


def _as_str(value: object, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise DefinitionError(f"{where}: must be a non-empty string")
    return value


def _as_int(value: object, where: str, *, minimum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise DefinitionError(f"{where}: must be an integer >= {minimum}")
    return value


def _as_sha256(value: object, where: str) -> str:
    text = _as_str(value, where)
    if SHA256_PATTERN.match(text) is None:
        raise DefinitionError(f"{where}: must be 64 lower-case hex characters")
    return text


def _as_names(value: object, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise DefinitionError(f"{where}: must be a list of strings")
    return tuple(str(item) for item in value)


def _as_bound(value: object, where: str) -> datetime:
    """Read one ``2020-02-01T00:00:00Z`` bound as a naive UTC instant."""
    text = _as_str(value, where)
    if not text.endswith(BOUND_SUFFIX):
        raise DefinitionError(f"{where}: {text!r} is not a UTC instant ending in {BOUND_SUFFIX!r}")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError as error:
        raise DefinitionError(f"{where}: {text!r} is not an ISO-8601 instant ({error})") from error
    return moment.replace(tzinfo=None)


@dataclass(frozen=True, slots=True)
class Segment:
    """One half-open time window ``start <= t < end`` of a slice."""

    start: datetime
    end: datetime
    rows: int

    def as_json(self, rows: int) -> dict[str, object]:
        """The document form of this segment, with ``rows`` measured again."""
        return {"from": _format_bound(self.start), "to": _format_bound(self.end), "rows": rows}


@dataclass(frozen=True, slots=True)
class SliceDefinition:
    """One committed slice: where it comes from and what it must hash to."""

    name: str
    segments: tuple[Segment, ...]
    rows: int
    sha256: str
    used_by: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SourceDefinition:
    """The one file every slice is cut from."""

    file: str
    sha256: str
    size_bytes: int
    doi: str


@dataclass(frozen=True, slots=True)
class Definitions:
    """The parsed and validated ``metropt3-slices.json``."""

    source: SourceDefinition
    slices: tuple[SliceDefinition, ...]
    credit: str
    generated_by: str


@dataclass(frozen=True, slots=True)
class CutResult:
    """What one slice actually turned out to be."""

    name: str
    path: Path
    rows: int
    sha256: str
    segment_rows: tuple[int, ...]


def _format_bound(moment: datetime) -> str:
    """Render a naive UTC instant the way the definitions spell it."""
    return f"{moment.isoformat()}{BOUND_SUFFIX}"


def _parse_segments(value: object, name: str) -> tuple[Segment, ...]:
    """Read one slice's segments and check that they are ordered and disjoint."""
    segments: list[Segment] = []
    for position, entry in enumerate(_as_list(value, f"slice {name!r} `segments`")):
        where = f"slice {name!r} segment {position}"
        fields = _as_dict(entry, where)
        start = _as_bound(fields.get("from"), f"{where} `from`")
        end = _as_bound(fields.get("to"), f"{where} `to`")
        if start >= end:
            raise DefinitionError(f"{where}: `from` must be before `to`")
        if segments and segments[-1].end > start:
            raise DefinitionError(f"{where}: overlaps or precedes the segment before it")
        rows = _as_int(fields.get("rows", 0), f"{where} `rows`", minimum=0)
        segments.append(Segment(start=start, end=end, rows=rows))
    return tuple(segments)


def _parse_slice(value: object, position: int) -> SliceDefinition:
    """Read one slice entry and check its name, row count and hash."""
    fields = _as_dict(value, f"`slices` entry {position}")
    name = _as_str(fields.get("name"), f"`slices` entry {position} `name`")
    return SliceDefinition(
        name=name,
        segments=_parse_segments(fields.get("segments"), name),
        rows=_as_int(fields.get("rows"), f"slice {name!r} `rows`", minimum=1),
        sha256=_as_sha256(fields.get("sha256"), f"slice {name!r} `sha256`"),
        used_by=_as_names(fields.get("used_by", []), f"slice {name!r} `used_by`"),
    )


def _parse_source(value: object) -> SourceDefinition:
    """Read the ``source`` object: the file every slice is cut from."""
    fields = _as_dict(value, "`source`")
    return SourceDefinition(
        file=_as_str(fields.get("file"), "`source.file`"),
        sha256=_as_sha256(fields.get("sha256"), "`source.sha256`"),
        size_bytes=_as_int(fields.get("bytes"), "`source.bytes`", minimum=1),
        doi=_as_str(fields.get("doi"), "`source.doi`"),
    )


def load_definitions(path: Path) -> Definitions:
    """Parse and validate the committed slice definitions.

    Raises:
        DefinitionError: the file is missing, is not JSON, carries another
            schema, or an entry breaks one of the rules above.
    """
    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise DefinitionError(f"{path}: cannot be read ({error.strerror})") from error
    try:
        document = json.loads(raw_text)
    except json.JSONDecodeError as error:
        raise DefinitionError(f"{path}: not valid JSON ({error})") from error

    fields = _as_dict(document, str(path))
    if fields.get("schema") != SCHEMA:
        raise DefinitionError(f"{path}: `schema` must be {SCHEMA!r}")

    slices: list[SliceDefinition] = []
    seen: set[str] = set()
    for position, entry in enumerate(_as_list(fields.get("slices"), f"{path} `slices`")):
        definition = _parse_slice(entry, position)
        if definition.name in seen:
            raise DefinitionError(f"slice {definition.name!r}: duplicate name")
        seen.add(definition.name)
        slices.append(definition)

    return Definitions(
        source=_parse_source(fields.get("source")),
        slices=tuple(slices),
        credit=_as_str(fields.get("credit"), f"{path} `credit`"),
        generated_by=_as_str(fields.get("generated_by"), f"{path} `generated_by`"),
    )


class _SliceWriter:
    """Collects the verbatim rows of one slice into ``<name>.csv.part``."""

    def __init__(self, definition: SliceDefinition, out_dir: Path, header: bytes) -> None:
        self.definition = definition
        self.path = out_dir / f"{definition.name}.csv"
        self.segment_rows = [0] * len(definition.segments)
        self._partial = self.path.with_suffix(".csv.part")
        self._handle = self._partial.open("wb")
        self._digest = hashlib.sha256()
        self._rows = 0
        self._write(header)

    def _write(self, raw: bytes) -> None:
        self._handle.write(raw)
        self._digest.update(raw)

    def take(self, raw: bytes, segment: int) -> None:
        """Copy one source row that falls inside ``segment``."""
        self._write(raw)
        self._rows += 1
        self.segment_rows[segment] += 1

    def commit(self) -> CutResult:
        """Close the partial file and move it into place."""
        self._handle.close()
        self._partial.replace(self.path)
        return CutResult(
            name=self.definition.name,
            path=self.path,
            rows=self._rows,
            sha256=self._digest.hexdigest(),
            segment_rows=tuple(self.segment_rows),
        )

    def discard(self) -> None:
        """Close and remove the partial file; nothing reaches the output directory."""
        self._handle.close()
        self._partial.unlink(missing_ok=True)


@dataclass(slots=True)
class _Interval:
    """One segment of one slice, in the single ordering the pass walks."""

    start: datetime
    end: datetime
    writer: _SliceWriter
    segment: int


class _LineTap:
    """Feeds the CSV reader decoded lines while keeping their raw bytes.

    ``csv.reader`` pulls from this iterator one line at a time and stops as
    soon as a record is complete, so :meth:`take` returns exactly the bytes of
    the record just parsed — which is what makes the copy verbatim, CRLF line
    endings and all.
    """

    def __init__(self, handle: BinaryIO, digest: hashlib._Hash) -> None:
        self._handle = handle
        self._digest = digest
        self._raw = bytearray()

    def take(self) -> bytes:
        """The raw bytes of the record just read; they are then forgotten."""
        raw = bytes(self._raw)
        self._raw.clear()
        return raw

    def __iter__(self) -> Iterator[str]:
        for raw in self._handle:
            self._digest.update(raw)
            self._raw += raw
            yield raw.decode("utf-8")


def _timestamp_index(header: Sequence[str], source: Path) -> int:
    try:
        return list(header).index(TIMESTAMP_COLUMN)
    except ValueError as error:
        raise CutError(f"{source}: the header has no {TIMESTAMP_COLUMN!r} column") from error


def _row_timestamp(fields: Sequence[str], index: int, line: int) -> datetime:
    try:
        return datetime.fromisoformat(fields[index])
    except (IndexError, ValueError) as error:
        raise CutError(f"line {line}: {TIMESTAMP_COLUMN} is not an instant ({error})") from error


def _intervals(writers: Sequence[_SliceWriter]) -> list[_Interval]:
    """Every segment of every slice, ordered by start, then by slice name."""
    intervals = [
        _Interval(start=segment.start, end=segment.end, writer=writer, segment=position)
        for writer in writers
        for position, segment in enumerate(writer.definition.segments)
    ]
    intervals.sort(key=lambda interval: (interval.start, interval.writer.definition.name))
    return intervals


def _stream(source: Path, writers: Sequence[_SliceWriter], digest: hashlib._Hash) -> None:
    """Walk the source once, copying every row that falls inside a segment."""
    pending = _intervals(writers)
    position = 0
    active: list[_Interval] = []
    previous: datetime | None = None

    with source.open("rb") as handle:
        tap = _LineTap(handle, digest)
        reader = csv.reader(tap)
        header = next(reader, None)
        if header is None:
            raise CutError(f"{source}: the file is empty")
        tap.take()
        index = _timestamp_index(header, source)

        for line, fields in enumerate(reader, start=2):
            raw = tap.take()
            moment = _row_timestamp(fields, index, line)
            if previous is not None and moment <= previous:
                raise CutError(f"line {line}: timestamp {moment} does not follow {previous}")
            previous = moment
            while position < len(pending) and pending[position].start <= moment:
                active.append(pending[position])
                position += 1
            if active:
                active = [interval for interval in active if interval.end > moment]
                for interval in active:
                    interval.writer.take(raw, interval.segment)


def _check_size(source: Path, definition: SourceDefinition) -> None:
    """Fail before streaming when the file cannot be the expected one."""
    size = source.stat().st_size
    if size != definition.size_bytes:
        raise CutError(f"{source}: {size} bytes, the definitions expect {definition.size_bytes}")


def cut(
    source: Path, out_dir: Path, definitions: Definitions, names: Sequence[str]
) -> list[CutResult]:
    """Cut ``names`` out of ``source`` into ``out_dir``; return what was written.

    Raises:
        CutError: a name is unknown, the source does not match
            ``definitions.source``, or its timestamps are not strictly
            increasing. Nothing reaches ``out_dir`` in that case.
    """
    known = {definition.name: definition for definition in definitions.slices}
    unknown = sorted(set(names) - set(known))
    if unknown:
        raise CutError(f"unknown slice name(s): {', '.join(unknown)}")
    _check_size(source, definitions.source)

    out_dir.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as probe:
        header = probe.readline()
    writers = [_SliceWriter(known[name], out_dir, header) for name in names]
    digest = hashlib.sha256()
    try:
        _stream(source, writers, digest)
        measured = digest.hexdigest()
        if measured != definitions.source.sha256:
            raise CutError(
                f"{source}: sha256 {measured} does not match the definitions "
                f"({definitions.source.sha256}); refusing to write fixtures"
            )
    except BaseException:
        for writer in writers:
            writer.discard()
        raise
    return [writer.commit() for writer in writers]


def file_sha256(path: Path) -> str:
    """The SHA-256 of a file on disk, read in blocks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(READ_BLOCK), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(results: Sequence[CutResult], definitions: Definitions) -> list[str]:
    """Compare every file on disk with its definition; return the drifts."""
    known = {definition.name: definition for definition in definitions.slices}
    drifts: list[str] = []
    for result in results:
        expected = known[result.name]
        if result.rows != expected.rows:
            drifts.append(f"{result.name}: {result.rows} rows, definitions say {expected.rows}")
        on_disk = file_sha256(result.path)
        if on_disk != expected.sha256:
            drifts.append(f"{result.name}: sha256 {on_disk}, definitions say {expected.sha256}")
    return drifts


def _report_document(definitions: Definitions, results: Sequence[CutResult]) -> dict[str, object]:
    """The definitions document again, with the measured rows and hashes."""
    measured = {result.name: result for result in results}
    return {
        "schema": SCHEMA,
        "credit": definitions.credit,
        "generated_by": definitions.generated_by,
        "source": {
            "file": definitions.source.file,
            "sha256": definitions.source.sha256,
            "bytes": definitions.source.size_bytes,
            "doi": definitions.source.doi,
        },
        "slices": [
            {
                "name": definition.name,
                "segments": [
                    segment.as_json(measured[definition.name].segment_rows[position])
                    for position, segment in enumerate(definition.segments)
                ],
                "rows": measured[definition.name].rows,
                "sha256": measured[definition.name].sha256,
                "used_by": list(definition.used_by),
            }
            for definition in definitions.slices
            if definition.name in measured
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    """The command line of ``make fixtures`` and of a human cutting one slice."""
    parser = argparse.ArgumentParser(
        prog="cut-metropt-slices.py",
        description="Cut the MetroPT-3 slices of data/fixtures/metropt3-slices.json.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(os.environ.get(SOURCE_ENV) or DEFAULT_SOURCE),
        metavar="CSV",
        help=f"the full MetroPT-3 CSV (default: ${SOURCE_ENV}, else {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(DEFAULT_OUT_DIR),
        metavar="DIR",
        help=f"where the cut slices are written (default: {DEFAULT_OUT_DIR})",
    )
    parser.add_argument(
        "--definitions",
        type=Path,
        default=Path(DEFAULT_DEFINITIONS),
        metavar="JSON",
        help=f"the slice definitions (default: {DEFAULT_DEFINITIONS})",
    )
    parser.add_argument(
        "--only",
        action="append",
        metavar="NAME",
        help="cut this slice only; repeat for several (default: every slice)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="compare the rows and sha256 of every file written with the definitions",
    )
    parser.add_argument(
        "--report",
        type=Path,
        metavar="JSON",
        help="write the definitions document back with the measured values ('-' for stdout)",
    )
    return parser


def _selected(definitions: Definitions, only: Sequence[str] | None) -> list[str]:
    if only:
        return list(only)
    return [definition.name for definition in definitions.slices]


def _write_report(document: dict[str, object], destination: Path) -> None:
    text = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
    if str(destination) == "-":
        sys.stdout.write(text)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text, encoding="utf-8")
    print(f"fixtures: measured definitions written to {destination}")


def _skip_or_fail(source: Path) -> int:
    """An absent source is a skip unless the caller demands the dataset."""
    message = SKIP_MESSAGE.format(path=source)
    if os.environ.get(REQUIRE_DATASET_ENV):
        print(message, file=sys.stderr)
        return EXIT_FAILURE
    print(message)
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    """Run the cutter; see the module docstring for the contract."""
    args = build_parser().parse_args(argv)
    source: Path = args.source
    if not source.is_file():
        return _skip_or_fail(source)

    try:
        definitions = load_definitions(args.definitions)
        results = cut(source, args.out_dir, definitions, _selected(definitions, args.only))
    except (CutError, DefinitionError) as error:
        print(f"fixtures: {error}", file=sys.stderr)
        return EXIT_FAILURE

    for result in results:
        print(f"fixtures: {result.name}: {result.rows} rows -> {result.path} ({result.sha256})")
    if args.report is not None:
        _write_report(_report_document(definitions, results), args.report)
    if args.verify:
        drifts = verify(results, definitions)
        if drifts:
            for drift in drifts:
                print(f"fixtures: {drift}", file=sys.stderr)
            return EXIT_FAILURE
        print(f"fixtures: {len(results)} slice(s) match {args.definitions}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

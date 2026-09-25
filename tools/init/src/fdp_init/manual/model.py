# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The data model of manual extraction.

Every dataclass is frozen: extraction builds them once, and the catalog
builder, the chunker and the report only read them. Lists stay lists because
the pipeline appends while it walks a page and freezes the document at the
end; nothing rebinds a field afterwards.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

COLUMN_FULL = 0
COLUMN_LEFT = 1
COLUMN_RIGHT = 2
"""``Line.column``: a spanning line, the left band, the right band."""


class TableKind(StrEnum):
    """The table profiles.

    The values are the ones ``app.chunks.table_kind`` accepts
    (``0008_chunk_links.sql``), so a kind can be written straight to the
    database.
    """

    TROUBLESHOOTING = "troubleshooting"
    ALARMS = "alarms"
    PARAMETERS = "parameters"
    SIGNALS = "signals"
    MAINTENANCE = "maintenance"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class Line:
    """One extracted text line with the geometry the layout pass needs."""

    page: int
    top: float
    x0: float
    x1: float
    text: str
    size: float
    bold: bool
    column: int = COLUMN_FULL


@dataclass(frozen=True, slots=True)
class Heading:
    """A numbered heading; ``ref`` is the bare number, ``"8"`` or ``"8.2.3"``."""

    ref: str
    title: str
    level: int
    page: int
    top: float


@dataclass(frozen=True, slots=True)
class TextBlock:
    """A paragraph, list or footnote, attached to its innermost section."""

    section_ref: str
    page: int
    ordinal: int
    text: str
    kind: str = "paragraph"


@dataclass(frozen=True, slots=True)
class TableRow:
    """One data row. ``group_*`` come from a group row or the enclosing heading."""

    cells: list[str]
    page: int
    group_ref: str | None = None
    group_title: str | None = None


@dataclass(frozen=True, slots=True)
class Table:
    """A table, already merged across page breaks when it spans them."""

    section_ref: str
    page_from: int
    page_to: int
    kind: TableKind
    header: list[str]
    rows: list[TableRow]
    bbox: tuple[float, float, float, float]
    strategy: str = "lines"
    merged_from: int = 1
    continued_without_header: bool = False


@dataclass(frozen=True, slots=True)
class ExtractStats:
    """The self-check — no ground truth involved."""

    pages: int = 0
    characters: int = 0
    headings_by_level: dict[int, int] = field(default_factory=dict)
    furniture_lines: int = 0
    tables_by_kind: dict[str, int] = field(default_factory=dict)
    tables_by_strategy: dict[str, int] = field(default_factory=dict)
    merged_fragments: int = 0
    group_rows: int = 0
    rows_recovered: int = 0
    rows_dropped: int = 0
    rows_without_fault_id: int = 0
    fault_ids_in_text: int = 0
    fault_ids_in_tables: int = 0

    @property
    def table_recall_estimate(self) -> float:
        """Ids recovered as table rows over ids seen anywhere in the text.

        An approximation of manual acceptance check 4 that needs no reference
        catalog.
        ``1.0`` when the document names no fault id at all, so an unrelated
        manual does not read as a failure.
        """
        if not self.fault_ids_in_text:
            return 1.0
        return self.fault_ids_in_tables / self.fault_ids_in_text


@dataclass(frozen=True, slots=True)
class ManualDoc:
    """Everything extraction knows about one PDF.

    ``variant`` is ``clean`` or ``realistic`` when the file name ends in
    ``-clean.pdf`` / ``-realistic.pdf``, else ``byo``; it is stored in
    ``app.manual_documents.variant``.
    """

    path: Path
    sha256: str
    bytes: int
    page_count: int
    title: str | None
    variant: str
    headings: list[Heading]
    blocks: list[TextBlock]
    tables: list[Table]
    furniture: list[str]
    full_text: str
    stats: ExtractStats

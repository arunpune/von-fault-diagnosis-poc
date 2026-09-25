# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Retrieval units cut to the embedding model's own budget.

A chunk is what the backend retrieves and shows a technician, so two properties
matter more than any packing heuristic: it never overflows the model's position
limit — counted with the model's *own* tokenizer, not an estimate — and it says
where in the manual it came from, because an answer that cannot be checked
against a section number is not evidence.

Three kinds, as ``0008_chunk_links.sql`` allows: ``text`` for prose,
``list`` for a bulleted block, and ``table`` for one data row. A row is one
retrieval unit, so an over-long row is truncated rather than split — half a
troubleshooting row retrieves as a different fault.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field

from fdp_init.embed.spec import EmbeddingSpec
from fdp_init.manual.extract import column_map, row_fault_id
from fdp_init.manual.model import Heading, ManualDoc, Table, TableKind, TableRow, TextBlock
from fdp_init.manual.profiles import alarm_code_re
from fdp_init.util.textnorm import norm_ws, split_sentences

__all__ = [
    "HARD_MAX_MARGIN",
    "OVERLAP_SENTENCES",
    "TARGET_TOKENS",
    "Chunk",
    "CountTokens",
    "chunk_manual",
    "hard_max",
]

log = logging.getLogger(__name__)

TARGET_TOKENS = 200
"""How long a prose chunk is allowed to grow before a new one is started."""

HARD_MAX_MARGIN = 8
"""Tokens held back from ``spec.max_tokens`` for the model's own specials."""

OVERLAP_SENTENCES = 1
"""Sentences repeated from the previous piece when a paragraph is split."""

_TEXT = "text"
_LIST = "list"
_TABLE = "table"

CountTokens = Callable[[str], int]
"""``Embedder.count_tokens``: the model's own tokenizer, never an estimate."""


@dataclass(frozen=True, slots=True)
class Chunk:
    """One row of ``app.chunks`` (the base table plus migration ``0008``).

    ``truncated`` is not a column: it records that an over-long table row lost
    its tail, so the ingest report can count how often the manual outgrew the
    model.
    """

    ordinal: int
    kind: str
    section_ref: str
    section_title: str
    page_start: int
    page_end: int
    content: str
    tokens: int
    fault_id: str | None = None
    alarm_code: str | None = None
    table_kind: str | None = None
    content_sha256: str = ""
    truncated: bool = False


def hard_max(spec: EmbeddingSpec) -> int:
    """The token ceiling a chunk must stay under: ``max_tokens - 8``."""
    return spec.max_tokens - HARD_MAX_MARGIN


@dataclass(slots=True)
class _Draft:
    """A chunk before the document order has numbered it."""

    page: int
    origin: int
    """0 for prose, 1 for a table row: prose comes first on a shared page."""
    position: int
    kind: str
    section_ref: str
    section_title: str
    page_start: int
    page_end: int
    content: str
    fault_id: str | None = None
    alarm_code: str | None = None
    table_kind: str | None = None
    truncated: bool = False

    @property
    def order_key(self) -> tuple[int, int, int]:
        return self.page, self.origin, self.position


@dataclass(slots=True)
class _Piece:
    """One paragraph, or one slice of a paragraph too long to embed whole."""

    text: str
    page: int
    kind: str = _TEXT
    truncated: bool = False


@dataclass(slots=True)
class _Budget:
    """The two limits and the tokenizer that decides them."""

    count: CountTokens
    target: int
    ceiling: int

    def fits(self, text: str, limit: int) -> bool:
        return self.count(text) <= limit


@dataclass(slots=True)
class _Section:
    """The blocks of one section, in the order the document prints them."""

    ref: str
    title: str
    blocks: list[TextBlock] = field(default_factory=list)

    @property
    def prefix(self) -> str:
        """What every chunk of the section opens with; it counts as tokens."""
        return f"{self.ref} {self.title}".strip()


def _section_titles(headings: Sequence[Heading]) -> dict[str, str]:
    """``section_ref -> title``, the first heading that claims a ref winning."""
    titles: dict[str, str] = {}
    for heading in headings:
        titles.setdefault(heading.ref, heading.title)
    return titles


def _sections(blocks: Sequence[TextBlock], headings: Sequence[Heading]) -> list[_Section]:
    """Group the blocks by section, in document order.

    A block printed before the first heading keeps an empty ``section_ref``
    and is left out: a chunk with no section cannot be cited, and in
    practice it is a running header the repetition rule did not catch.
    """
    titles = _section_titles(headings)
    grouped: dict[str, _Section] = {}
    ordered: list[_Section] = []
    for block in blocks:
        if not block.section_ref:
            continue
        section = grouped.get(block.section_ref)
        if section is None:
            section = _Section(ref=block.section_ref, title=titles.get(block.section_ref, ""))
            grouped[block.section_ref] = section
            ordered.append(section)
        section.blocks.append(block)
    return ordered


def _truncate(text: str, limit: int, budget: _Budget) -> str:
    """The longest prefix of ``text`` that still fits ``limit`` tokens.

    A binary search over the characters, so the result depends only on the
    tokenizer and never on how the caller assembled the string.
    """
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if budget.fits(text[:middle], limit):
            low = middle
        else:
            high = middle - 1
    return text[:low]


def _split_paragraph(block: TextBlock, prefix: str, budget: _Budget) -> Iterator[_Piece]:
    """Cut a paragraph that alone exceeds the ceiling into sentence pieces.

    Each piece opens with the last sentence of the piece before it, so a fact
    split across the boundary is retrievable from either side. A single sentence
    that does not fit on its own is truncated: splitting mid-sentence would
    produce a fragment that reads as a different statement.
    """
    sentences = split_sentences(block.text) or [block.text]
    current: list[str] = []
    for sentence in sentences:
        candidate = [*current, sentence]
        if current and not budget.fits(_body(prefix, candidate), budget.ceiling):
            yield _Piece(text=" ".join(current), page=block.page)
            current = [*current[-OVERLAP_SENTENCES:], sentence]
            if not budget.fits(_body(prefix, current), budget.ceiling):
                current = [sentence]
        else:
            current = candidate
    if not current:
        return
    text = " ".join(current)
    if budget.fits(_body(prefix, [text]), budget.ceiling):
        yield _Piece(text=text, page=block.page)
        return
    room = budget.ceiling - budget.count(f"{prefix}\n") if prefix else budget.ceiling
    yield _Piece(text=_truncate(text, max(room, 1), budget), page=block.page, truncated=True)


def _body(prefix: str, parts: Sequence[str]) -> str:
    """A chunk's content: the section reference, then the text."""
    text = "\n\n".join(parts)
    return f"{prefix}\n{text}" if prefix else text


def _pieces(section: _Section, budget: _Budget) -> list[_Piece]:
    """The section's blocks, each already short enough to embed whole."""
    prefix = section.prefix
    pieces: list[_Piece] = []
    for block in section.blocks:
        if block.kind == _LIST:
            pieces.append(_Piece(text=block.text, page=block.page, kind=_LIST))
        elif budget.fits(_body(prefix, [block.text]), budget.ceiling):
            pieces.append(_Piece(text=block.text, page=block.page))
        else:
            pieces.extend(_split_paragraph(block, prefix, budget))
    return pieces


_FOOTNOTE_MARKER = re.compile(r"\[note (\d{1,2})\]")
"""The normalised marker :mod:`fdp_init.manual.pdf` writes at a footnote's head."""


def _callers(blocks: Sequence[TextBlock]) -> dict[int, list[TextBlock]]:
    """Map a block's ordinal to the footnotes that belong behind it.

    The footnote body opens with ``[note n]`` and the calling paragraph carries
    the same number welded onto the end of a sentence. Only blocks on the
    footnote's own page are candidates, which is what a footnote means, and the
    last one before it wins. A footnote with no caller is left where it is.
    """
    attached: dict[int, list[TextBlock]] = {}
    for block in blocks:
        if block.kind != "footnote":
            continue
        marker = _FOOTNOTE_MARKER.match(block.text)
        if marker is None:
            continue
        call = re.compile(rf"[.!?,;:]\s*{marker.group(1)}(?![0-9])")
        callers = [
            candidate
            for candidate in blocks
            if candidate.page == block.page
            and candidate.ordinal < block.ordinal
            and candidate.kind != "footnote"
            and call.search(candidate.text)
        ]
        if callers:
            attached.setdefault(callers[-1].ordinal, []).append(block)
    return attached


def _with_footnotes_attached(blocks: Sequence[TextBlock]) -> list[TextBlock]:
    """The blocks with each footnote moved behind the paragraph that calls it.

    ``assign_sections`` gives a footnote the section open where it is *printed*
    — the foot of the page, which a later heading may already own — so moving it
    back is what puts it in the right chunk. The footnote takes the
    caller's section and keeps its own page.
    """
    attached = _callers(blocks)
    if not attached:
        return list(blocks)
    moved: list[TextBlock] = []
    footnotes = {note.ordinal for notes in attached.values() for note in notes}
    for block in blocks:
        if block.ordinal in footnotes:
            continue
        moved.append(block)
        for note in attached.get(block.ordinal, ()):
            moved.append(
                TextBlock(
                    section_ref=block.section_ref,
                    page=note.page,
                    ordinal=note.ordinal,
                    text=note.text,
                    kind=note.kind,
                )
            )
    return moved


def _text_drafts(doc: ManualDoc, budget: _Budget) -> list[_Draft]:
    """Every prose and list chunk of the document, in block order."""
    drafts: list[_Draft] = []
    for section in _sections(_with_footnotes_attached(doc.blocks), doc.headings):
        prefix = section.prefix
        buffer: list[_Piece] = []
        for piece in _pieces(section, budget):
            if piece.kind == _LIST:
                if buffer:
                    drafts.append(_draft(section, buffer, len(drafts), prefix, _TEXT))
                    buffer = []
                drafts.append(_draft(section, [piece], len(drafts), prefix, _LIST))
                continue
            candidate = [*buffer, piece]
            texts = [item.text for item in candidate]
            if buffer and not budget.fits(_body(prefix, texts), budget.target):
                drafts.append(_draft(section, buffer, len(drafts), prefix, _TEXT))
                buffer = [piece]
            else:
                buffer = candidate
        if buffer:
            drafts.append(_draft(section, buffer, len(drafts), prefix, _TEXT))
    return drafts


def _draft(
    section: _Section, pieces: Sequence[_Piece], position: int, prefix: str, kind: str
) -> _Draft:
    """One prose or list chunk built from the pieces collected for it."""
    pages = [piece.page for piece in pieces]
    return _Draft(
        page=min(pages),
        origin=0,
        position=position,
        kind=kind,
        section_ref=section.ref,
        section_title=section.title,
        page_start=min(pages),
        page_end=max(pages),
        content=_body(prefix, [piece.text for piece in pieces]),
        truncated=any(piece.truncated for piece in pieces),
    )


def _row_content(table: Table, row: TableRow, titles: dict[str, str]) -> str:
    """``"8.2 Fault tables — Oil temperature high\\nFault id: …"``."""
    section_title = titles.get(table.section_ref, "")
    heading = norm_ws(f"{table.section_ref} {section_title}")
    label = norm_ws(row.group_title or table.kind.value)
    parts = []
    for position, cell in enumerate(row.cells):
        value = norm_ws(cell)
        if not value:
            continue
        header = norm_ws(table.header[position]) if position < len(table.header) else ""
        parts.append(f"{header}: {value}" if header else value)
    return f"{heading} — {label}\n" + " | ".join(parts)


def _table_drafts(doc: ManualDoc, budget: _Budget) -> list[_Draft]:
    """One chunk per data row, truncated rather than split when too long."""
    titles = _section_titles(doc.headings)
    pattern = alarm_code_re()
    drafts: list[_Draft] = []
    position = 0
    for table in doc.tables:
        columns = column_map(table)
        for row in table.rows:
            content = _row_content(table, row, titles)
            truncated = not budget.fits(content, budget.ceiling)
            if truncated:
                content = _truncate(content, budget.ceiling, budget)
            code = pattern.search(_code_cell(row, columns))
            is_alarm = table.kind is TableKind.ALARMS
            drafts.append(
                _Draft(
                    page=row.page,
                    origin=1,
                    position=position,
                    kind=_TABLE,
                    section_ref=table.section_ref,
                    section_title=titles.get(table.section_ref, ""),
                    page_start=row.page,
                    page_end=row.page,
                    content=content,
                    fault_id=(
                        row_fault_id(row.cells, columns)
                        if table.kind is TableKind.TROUBLESHOOTING
                        else None
                    ),
                    alarm_code=code.group(0) if code is not None and is_alarm else None,
                    table_kind=table.kind.value,
                    truncated=truncated,
                )
            )
            position += 1
    return drafts


def _code_cell(row: TableRow, columns: dict[str, int]) -> str:
    """The alarm-code cell of a row, or the empty string when there is none."""
    index = columns.get("code")
    if index is None or index >= len(row.cells):
        return ""
    return row.cells[index]


def chunk_manual(doc: ManualDoc, count_tokens: CountTokens, spec: EmbeddingSpec) -> list[Chunk]:
    """Cut one manual into the chunks ``app.chunks`` stores.

    Args:
        doc: The extracted document.
        count_tokens: The embedding model's own token counter, so the ceiling
            below is exact for the graph that embeds the result.
        spec: The embedding pin; ``max_tokens`` sets the ceiling.

    Returns:
        The chunks in document order, numbered from zero. Prose comes before the
        tables of the same page: ``TextBlock`` carries no ``top``, so the
        page is the finest position a prose chunk knows.
    """
    ceiling = hard_max(spec)
    # The packing target can never be looser than the ceiling: a pin with a
    # small max_tokens would otherwise let the accumulator put pieces back
    # together that were split apart because they did not fit.
    budget = _Budget(count=count_tokens, target=min(TARGET_TOKENS, ceiling), ceiling=ceiling)
    drafts = [*_text_drafts(doc, budget), *_table_drafts(doc, budget)]
    drafts.sort(key=lambda draft: draft.order_key)
    chunks = [
        Chunk(
            ordinal=ordinal,
            kind=draft.kind,
            section_ref=draft.section_ref,
            section_title=draft.section_title,
            page_start=draft.page_start,
            page_end=draft.page_end,
            content=draft.content,
            tokens=count_tokens(draft.content),
            fault_id=draft.fault_id,
            alarm_code=draft.alarm_code,
            table_kind=draft.table_kind,
            content_sha256=hashlib.sha256(draft.content.encode("utf-8")).hexdigest(),
            truncated=draft.truncated,
        )
        for ordinal, draft in enumerate(drafts)
    ]
    truncated = sum(1 for chunk in chunks if chunk.truncated)
    if truncated:
        log.warning(
            "%d chunk(s) were truncated at the embedding model's token ceiling",
            truncated,
            extra={"step": "ingest", "ceiling": ceiling},
        )
    return chunks

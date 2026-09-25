# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Chunking, against both fixtures.

Two layers. The structural tests run everywhere with a *stand-in* tokenizer, so
the rules that decide what a chunk is — one per table row, a list of its own, a
footnote behind the paragraph that calls it — are checked in the fast gate. The
limits and the golden files need the real model, count with its own tokenizer
and carry the ``network`` marker, because a cold cache downloads 91 MB:

    uv run --package fdp-init pytest -m network tools/init/tests/unit/test_chunker.py -q

The golden files under ``fixtures/mini-manual/golden/`` are the chunk lists in
full. Regenerate them with the same command and ``FDP_UPDATE_GOLDEN=1`` after a
deliberate change to the chunking rules, and read the diff before committing
it.
"""

from __future__ import annotations

import itertools
import json
import os
import re
from collections.abc import Iterator
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any

import pytest

from fdp_init.chunk import Chunk, chunk_manual, hard_max
from fdp_init.embed.embedder import Embedder
from fdp_init.embed.model_cache import ModelFiles, ensure_model, file_path
from fdp_init.embed.spec import EmbeddingSpec, load_spec, spec_path
from fdp_init.manual.extract import extract_manual
from fdp_init.manual.model import ExtractStats, Heading, ManualDoc, TextBlock
from fdp_init.util.textnorm import split_sentences

pytestmark = pytest.mark.unit

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual"
GOLDEN = FIXTURES / "golden"
CONTRACTS = ROOT / "packages" / "contracts"
VENDORED_CONTRACTS = Path(__file__).resolve().parents[1] / "fixtures" / "contracts"
DEFAULT_CACHE_DIR = ROOT / "data" / "models"
VARIANTS = ("clean", "realistic")
EXPECTED: dict[str, Any] = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))

_TRUE = frozenset({"1", "true", "yes", "on"})
_WORD = re.compile(r"\w+|[^\w\s]")


def _switch(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUE


def contracts_dir() -> Path:
    """The real contracts package, or the vendored copy when it is absent."""
    return CONTRACTS if spec_path(CONTRACTS).is_file() else VENDORED_CONTRACTS


def cache_dir() -> Path:
    configured = os.environ.get("MODEL_CACHE_DIR", "").strip()
    return Path(configured) if configured else DEFAULT_CACHE_DIR


def count_words(text: str) -> int:
    """A stand-in tokenizer: one token per word or punctuation mark.

    Deterministic and close enough in scale to exercise the packing rules
    without loading a 91 MB graph. It is never used for the limits, which
    are only meaningful against the model's own tokenizer.
    """
    return len(_WORD.findall(text))


@pytest.fixture(scope="module")
def documents() -> dict[str, ManualDoc]:
    return {
        variant: extract_manual(FIXTURES / f"mini-manual-{variant}.pdf") for variant in VARIANTS
    }


@pytest.fixture(scope="module")
def spec() -> EmbeddingSpec:
    return load_spec(contracts_dir())


@pytest.fixture(scope="module")
def files(spec: EmbeddingSpec) -> ModelFiles:
    """The verified model files; a cold cache skips unless downloading is allowed."""
    cache = cache_dir()
    cached = all(file_path(spec, cache, entry).is_file() for entry in spec.files)
    if not cached and not (_switch("FDP_REQUIRE_MODEL") or _switch("EMBEDDER_ALLOW_DOWNLOAD")):
        pytest.skip(
            f"the embedding model is not cached in {cache}; set FDP_REQUIRE_MODEL=1 to download it"
        )
    return ensure_model(spec, cache)


@pytest.fixture(scope="module")
def embedder(files: ModelFiles, spec: EmbeddingSpec) -> Embedder:
    return Embedder(files, spec, threads=1)


@pytest.fixture(scope="module")
def real_chunks(
    documents: dict[str, ManualDoc], embedder: Embedder, spec: EmbeddingSpec
) -> dict[str, list[Chunk]]:
    """Both fixtures chunked with the model's own tokenizer."""
    return {
        variant: chunk_manual(doc, embedder.count_tokens, spec)
        for variant, doc in documents.items()
    }


@pytest.fixture(scope="module")
def word_chunks(documents: dict[str, ManualDoc], spec: EmbeddingSpec) -> dict[str, list[Chunk]]:
    """Both fixtures chunked with the stand-in tokenizer."""
    return {variant: chunk_manual(doc, count_words, spec) for variant, doc in documents.items()}


def _as_json(chunks: list[Chunk]) -> list[dict[str, Any]]:
    return [asdict(chunk) for chunk in chunks]


def _golden_path(variant: str) -> Path:
    return GOLDEN / f"chunks-{variant}.json"


def _table_rows(doc: ManualDoc) -> int:
    return sum(len(table.rows) for table in doc.tables)


# --------------------------------------------------------------------------
# Sentence boundaries
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("One. Two.", ["One.", "Two."]),
        ("Line pressure (P2) falls. Load cycle rate is higher.", None),
        ("Do not exceed 95 °C (203 °F): above that limit it stops.", None),
        ("", []),
    ],
)
def test_split_sentences(text: str, expected: list[str] | None) -> None:
    """The boundary: a stop plus a capital, a digit or an opening bracket."""
    parts = split_sentences(text)
    if expected is not None:
        assert parts == expected
    else:
        assert parts == [part for part in parts if part]
        assert " ".join(parts).replace("  ", " ") == text.strip()


# --------------------------------------------------------------------------
# Structure, with the stand-in tokenizer
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_one_chunk_per_table_row(
    variant: str, word_chunks: dict[str, list[Chunk]], documents: dict[str, ManualDoc]
) -> None:
    """Every data row of every table becomes exactly one retrieval unit."""
    chunks = [chunk for chunk in word_chunks[variant] if chunk.kind == "table"]
    assert len(chunks) == _table_rows(documents[variant])
    assert len(chunks) == EXPECTED["variants"][variant]["chunks"]["table"]
    for chunk in chunks:
        assert chunk.table_kind is not None
        assert chunk.page_start == chunk.page_end


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_chunk_counts_match_the_fixture(
    variant: str, word_chunks: dict[str, list[Chunk]]
) -> None:
    """``expected.json`` states how many chunks of each kind the chunker cuts."""
    expected = EXPECTED["variants"][variant]["chunks"]
    counts = dict.fromkeys(("text", "list", "table"), 0)
    for chunk in word_chunks[variant]:
        counts[chunk.kind] += 1
    assert counts == expected


@pytest.mark.parametrize("variant", VARIANTS)
def test_table_chunks_carry_their_links(variant: str, word_chunks: dict[str, list[Chunk]]) -> None:
    """``fault_id``, ``alarm_code`` and ``table_kind`` of ``0008_chunk_links``."""
    chunks = [chunk for chunk in word_chunks[variant] if chunk.kind == "table"]
    troubleshooting = [chunk for chunk in chunks if chunk.table_kind == "troubleshooting"]
    assert len(troubleshooting) == EXPECTED["counts"]["cause_rows"]
    assert {chunk.fault_id for chunk in troubleshooting} == {
        cause["fault_id"]
        for condition in EXPECTED["catalog"]["conditions"]
        for cause in condition["causes"]
    }
    for chunk in troubleshooting:
        assert chunk.alarm_code is None, "a troubleshooting row links a fault, not an alarm"
    alarms = [chunk for chunk in chunks if chunk.table_kind == "alarms"]
    assert [chunk.alarm_code for chunk in alarms] == [
        alarm["code"] for alarm in EXPECTED["catalog"]["alarms"]
    ]
    for chunk in alarms:
        assert chunk.fault_id is None
    for chunk in chunks:
        if chunk.table_kind in ("parameters", "signals"):
            assert chunk.fault_id is None
            assert chunk.alarm_code is None


@pytest.mark.parametrize("variant", VARIANTS)
def test_every_chunk_names_its_section_and_is_numbered_in_order(
    variant: str, word_chunks: dict[str, list[Chunk]]
) -> None:
    """``ordinal`` is dense and page-ordered, and the content opens with the ref."""
    chunks = word_chunks[variant]
    assert [chunk.ordinal for chunk in chunks] == list(range(len(chunks)))
    assert [chunk.page_start for chunk in chunks] == sorted(chunk.page_start for chunk in chunks)
    for chunk in chunks:
        assert chunk.section_ref
        assert chunk.content.startswith(chunk.section_ref)
        assert chunk.content_sha256
        assert chunk.page_start <= chunk.page_end


def test_a_footnote_joins_the_chunk_of_the_paragraph_that_calls_it(
    word_chunks: dict[str, list[Chunk]],
) -> None:
    """The realistic variant prints the footnote under 8.2 but calls it in 8.1."""
    chunks = word_chunks["realistic"]
    carrying = [chunk for chunk in chunks if "[note 1]" in chunk.content]
    assert len(carrying) == 1
    assert carrying[0].section_ref == "8.1"
    assert "cooling circuit.1" in carrying[0].content


def test_the_list_block_is_a_chunk_of_its_own(word_chunks: dict[str, list[Chunk]]) -> None:
    """A bulleted block is ``kind='list'``, never folded into the prose."""
    for variant in VARIANTS:
        lists = [chunk for chunk in word_chunks[variant] if chunk.kind == "list"]
        assert len(lists) == 1
        assert lists[0].section_ref == "8.1"
        assert lists[0].content.count("•") == 3


def test_an_over_long_row_is_truncated_not_split(
    documents: dict[str, ManualDoc], spec: EmbeddingSpec
) -> None:
    """A row is one retrieval unit, so it loses its tail rather than splitting."""
    doc = documents["clean"]
    tiny = _shrunk(spec, 40)
    chunks = chunk_manual(doc, count_words, tiny)
    rows = [chunk for chunk in chunks if chunk.kind == "table"]
    assert len(rows) == _table_rows(doc), "truncation must not change the row count"
    assert any(chunk.truncated for chunk in rows)
    for chunk in rows:
        assert count_words(chunk.content) <= hard_max(tiny)


def test_an_over_long_paragraph_is_split_with_one_sentence_of_overlap(
    spec: EmbeddingSpec,
) -> None:
    """Sentence boundaries, with the last sentence repeated on the next piece.

    Built rather than borrowed: the fixture's prose is short enough to embed
    whole, and a paragraph only overlaps when three of its sentences do not fit
    where two of them do.
    """
    sentences = [f"Sentence number {number} of the long paragraph." for number in range(1, 8)]
    doc = _synthetic_document(" ".join(sentences))
    tiny = _shrunk(spec, 8 + 3 * count_words(sentences[0]))
    chunks = [chunk for chunk in chunk_manual(doc, count_words, tiny) if chunk.kind == "text"]
    assert len(chunks) > 1
    for chunk in chunks:
        assert count_words(chunk.content) <= hard_max(tiny)
        assert not chunk.truncated
    for earlier, later in itertools.pairwise(chunks):
        assert split_sentences(earlier.content)[-1] in later.content
    joined = " ".join(chunk.content for chunk in chunks)
    for sentence in sentences:
        assert sentence in joined


def _synthetic_document(paragraph: str) -> ManualDoc:
    """A one-section document, for the paths the fixtures cannot reach."""
    return ManualDoc(
        path=Path("synthetic-clean.pdf"),
        sha256="0" * 64,
        bytes=0,
        page_count=1,
        title=None,
        variant="clean",
        headings=[Heading(ref="1", title="Safety", level=1, page=1, top=10.0)],
        blocks=[TextBlock(section_ref="1", page=1, ordinal=0, text=paragraph)],
        tables=[],
        furniture=[],
        full_text=paragraph,
        stats=ExtractStats(),
    )


def _shrunk(spec: EmbeddingSpec, max_tokens: int) -> EmbeddingSpec:
    """The pin with a tiny ceiling, to force the splitting paths."""
    return replace(spec, max_tokens=max_tokens)


# --------------------------------------------------------------------------
# The real tokenizer: limits and golden files
# --------------------------------------------------------------------------


@pytest.mark.network
@pytest.mark.parametrize("variant", VARIANTS)
def test_no_chunk_exceeds_the_models_budget(
    variant: str, real_chunks: dict[str, list[Chunk]], spec: EmbeddingSpec, embedder: Embedder
) -> None:
    """``max_tokens - 8``, counted with the tokenizer that embeds them."""
    ceiling = hard_max(spec)
    for chunk in real_chunks[variant]:
        assert chunk.tokens == embedder.count_tokens(chunk.content)
        assert chunk.tokens <= ceiling, f"chunk {chunk.ordinal} of {variant} is {chunk.tokens}"


@pytest.mark.network
@pytest.mark.parametrize("variant", VARIANTS)
def test_the_chunks_match_the_golden_file(
    variant: str, real_chunks: dict[str, list[Chunk]]
) -> None:
    """The committed chunk list, field for field ("same bytes, same list")."""
    rendered = _as_json(real_chunks[variant])
    path = _golden_path(variant)
    if _switch("FDP_UPDATE_GOLDEN"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rendered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    assert path.is_file(), f"{path} is missing; regenerate it with FDP_UPDATE_GOLDEN=1"
    assert rendered == json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.network
@pytest.mark.parametrize("variant", VARIANTS)
def test_chunking_is_reproducible(
    variant: str,
    documents: dict[str, ManualDoc],
    embedder: Embedder,
    spec: EmbeddingSpec,
    real_chunks: dict[str, list[Chunk]],
) -> None:
    """A second run over the same document gives the same chunks."""
    again = chunk_manual(documents[variant], embedder.count_tokens, spec)
    assert _as_json(again) == _as_json(real_chunks[variant])


@pytest.mark.network
def test_the_golden_files_carry_the_whole_document(
    real_chunks: dict[str, list[Chunk]],
) -> None:
    """Nothing the manual prints in a table is missing from the chunks."""
    for variant in VARIANTS:
        content = "\n".join(chunk.content for chunk in real_chunks[variant])
        for condition in EXPECTED["catalog"]["conditions"]:
            for cause in condition["causes"]:
                assert cause["fault_id"] in content
        for alarm in EXPECTED["catalog"]["alarms"]:
            assert alarm["code"] in content


def _golden_files() -> Iterator[Path]:
    return iter(sorted(GOLDEN.glob("chunks-*.json"))) if GOLDEN.is_dir() else iter(())


def test_a_golden_file_exists_for_every_variant() -> None:
    """The committed goldens are the two variants and nothing else."""
    assert [path.name for path in _golden_files()] == [
        f"chunks-{variant}.json" for variant in VARIANTS
    ]

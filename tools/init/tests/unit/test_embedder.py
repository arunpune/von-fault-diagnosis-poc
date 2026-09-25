# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The ONNX embedder against the real pinned model.

The model-dependent tests carry the ``network`` marker: they read
``MODEL_CACHE_DIR`` (``data/models`` by default) and, when it is cold, download
the two hash-verified files of ``embedding.json``. A cold cache without
permission skips instead of pulling 91 MB behind the developer's back;
``FDP_REQUIRE_MODEL=1`` (CI) turns both the download and the parity check
into obligations, so the cross-language fixture can never be silently skipped.

:func:`~fdp_init.embed.assert_dimension` needs no model and no marker: it is
pure SQL-result handling and runs in the plain unit layer.
"""

from __future__ import annotations

import json
import os
import random
import warnings
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from numpy.typing import NDArray

from fdp_init.embed.embedder import Embedder, assert_dimension, default_threads
from fdp_init.embed.model_cache import ModelFiles, ensure_model, file_path
from fdp_init.embed.spec import EmbeddingSpec, load_spec, spec_path
from fdp_init.errors import ExitCode, InitError

ROOT = Path(__file__).resolve().parents[4]
CONTRACTS_DIR = ROOT / "packages" / "contracts"
VENDORED_CONTRACTS_DIR = ROOT / "tools" / "init" / "tests" / "fixtures" / "contracts"
DEFAULT_CACHE_DIR = ROOT / "data" / "models"

DIMENSION = 384
UNIT_NORM_TOLERANCE = 1e-4
BATCH_TOLERANCE = 1e-6
PARITY_MIN_COSINE = 0.9999

BATCH_SIZE = 4
"""Smaller than every batch the tests embed, so batching is really exercised."""

TEXTS = (
    "The oil temperature rises above the warning threshold while the unit is loaded.",
    "A clogged intake filter lowers the delivered flow.",
    "Vibration at the coupling grows while the compressor holds its set pressure.",
    "Standing water in the air receiver points to a condensate drain that no longer opens.",
    "Short line.",
    "The dryer tower fails to switch over and the outlet dew point climbs above the alarm limit.",
)

_TRUE = frozenset({"1", "true", "yes", "on"})

SHUFFLE_SEED = 20260921


def contracts_dir() -> Path:
    """The real contracts package, or the vendored copy when it is absent."""
    return CONTRACTS_DIR if spec_path(CONTRACTS_DIR).is_file() else VENDORED_CONTRACTS_DIR


def cache_dir() -> Path:
    """``MODEL_CACHE_DIR``, or the gitignored development default."""
    configured = os.environ.get("MODEL_CACHE_DIR", "").strip()
    return Path(configured) if configured else DEFAULT_CACHE_DIR


def _switch(name: str) -> bool:
    """A truthy environment switch, empty string counting as unset."""
    return os.environ.get(name, "").strip().lower() in _TRUE


def require_model() -> bool:
    """``FDP_REQUIRE_MODEL=1``: a skip here is a CI failure."""
    return _switch("FDP_REQUIRE_MODEL")


def download_allowed() -> bool:
    """Whether a cold cache may be filled from the network."""
    return require_model() or _switch("EMBEDDER_ALLOW_DOWNLOAD")


@pytest.fixture(scope="module")
def spec() -> EmbeddingSpec:
    """The committed pin."""
    return load_spec(contracts_dir())


@pytest.fixture(scope="module")
def files(spec: EmbeddingSpec) -> ModelFiles:
    """The verified model files, downloaded once when the cache allows it."""
    cache = cache_dir()
    cached = all(file_path(spec, cache, entry).is_file() for entry in spec.files)
    if not cached and not download_allowed():
        pytest.skip(
            f"the embedding model is not cached in {cache}; set FDP_REQUIRE_MODEL=1 to download it"
        )
    return ensure_model(spec, cache)


@pytest.fixture(scope="module")
def embedder(files: ModelFiles, spec: EmbeddingSpec) -> Embedder:
    """One session for the whole module; loading the graph is not cheap."""
    return Embedder(files, spec, batch_size=BATCH_SIZE, threads=1)


def cosine(left: NDArray[np.float32], right: NDArray[np.float32]) -> float:
    """Cosine similarity of two vectors."""
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    return float(np.dot(left, right) / denominator)


def ramp(dimension: int) -> NDArray[np.float64]:
    """``[0, 1, …, dimension - 1]``: the stubbed vector of the first token."""
    return np.arange(dimension, dtype=np.float64)


class _StubSession:
    """A session whose first token points the other way from every other one.

    Lets the ``cls`` branch of the pooling be proven against the ``mean``
    branch on the same input, without pinning a second model.
    The two directions are deliberately far apart, so a pooling mode that is
    quietly ignored cannot pass for the other one.
    """

    def __init__(self, dimension: int) -> None:
        self._dimension = dimension

    def run(
        self, outputs: Sequence[str], feed: dict[str, NDArray[np.int64]]
    ) -> list[NDArray[np.float32]]:
        del outputs
        batch, tokens = feed["input_ids"].shape
        hidden = np.zeros((batch, tokens, self._dimension), dtype=np.float32)
        for row in range(batch):
            hidden[row, 0, :] = ramp(self._dimension) + row
            hidden[row, 1:, :] = ramp(self._dimension)[::-1]
        return [hidden]


def unit(vector: NDArray[np.float64]) -> NDArray[np.float64]:
    """``vector`` scaled to length 1."""
    return vector / np.linalg.norm(vector)


# --- the real model -----------------------------------------------------------


@pytest.mark.network
def test_vectors_have_the_pinned_dimension_and_type(embedder: Embedder) -> None:
    vectors, counts = embedder.embed(TEXTS)
    assert vectors.shape == (len(TEXTS), DIMENSION)
    assert vectors.dtype == np.float32
    assert len(counts) == len(TEXTS)
    assert all(count > 0 for count in counts)


@pytest.mark.network
def test_vectors_are_unit_length(embedder: Embedder) -> None:
    vectors, _ = embedder.embed(TEXTS)
    norms = np.linalg.norm(vectors, axis=1)
    assert np.allclose(norms, 1.0, atol=UNIT_NORM_TOLERANCE)


@pytest.mark.network
def test_an_empty_input_gives_an_empty_result(embedder: Embedder) -> None:
    vectors, counts = embedder.embed([])
    assert vectors.shape == (0, DIMENSION)
    assert counts == []


@pytest.mark.network
def test_a_vector_does_not_depend_on_the_order_of_the_batch(embedder: Embedder) -> None:
    straight, straight_counts = embedder.embed(TEXTS)
    order = list(range(len(TEXTS)))
    random.Random(SHUFFLE_SEED).shuffle(order)
    shuffled, shuffled_counts = embedder.embed([TEXTS[index] for index in order])

    for position, index in enumerate(order):
        assert np.allclose(shuffled[position], straight[index], atol=BATCH_TOLERANCE)
        assert shuffled_counts[position] == straight_counts[index]


@pytest.mark.network
def test_a_vector_does_not_depend_on_the_padding_of_its_neighbours(embedder: Embedder) -> None:
    together, _ = embedder.embed(TEXTS)
    for index, text in enumerate(TEXTS):
        alone, _ = embedder.embed([text])
        assert np.allclose(alone[0], together[index], atol=BATCH_TOLERANCE)


@pytest.mark.network
def test_the_token_count_is_reported_and_capped_at_the_pinned_maximum(
    embedder: Embedder, spec: EmbeddingSpec
) -> None:
    long_text = " ".join(["pressure"] * 2000)
    assert embedder.count_tokens(long_text) == spec.max_tokens

    _, counts = embedder.embed([TEXTS[4], long_text])
    assert counts == [embedder.count_tokens(TEXTS[4]), spec.max_tokens]


@pytest.mark.network
def test_the_tokenizer_is_exposed_for_the_chunker(embedder: Embedder) -> None:
    encoding = embedder.tokenizer.encode(TEXTS[4])
    assert sum(encoding.attention_mask) == embedder.count_tokens(TEXTS[4])


@pytest.mark.network
def test_pooling_and_normalisation_follow_the_pin(
    files: ModelFiles, spec: EmbeddingSpec, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both pooling branches, on one stubbed hidden state."""
    text = TEXTS[4]
    mean_embedder = Embedder(files, spec, batch_size=1, threads=1)
    cls_embedder = Embedder(files, replace(spec, pooling="cls"), batch_size=1, threads=1)
    raw_embedder = Embedder(files, replace(spec, normalize=False), batch_size=1, threads=1)
    tokens = mean_embedder.count_tokens(text)
    for instance in (mean_embedder, cls_embedder, raw_embedder):
        monkeypatch.setattr(instance, "_session", _StubSession(spec.dimension))

    first = ramp(spec.dimension)
    rest = first[::-1]
    expected_cls = unit(first)
    expected_mean = unit((first + (tokens - 1) * rest) / tokens)

    cls_vectors, _ = cls_embedder.embed([text])
    mean_vectors, _ = mean_embedder.embed([text])
    raw_vectors, _ = raw_embedder.embed([text])

    assert np.allclose(cls_vectors[0], expected_cls, atol=1e-5)
    assert np.allclose(mean_vectors[0], expected_mean, atol=1e-5)
    assert cosine(mean_vectors[0], cls_vectors[0]) < 0.9
    assert float(np.linalg.norm(raw_vectors[0])) > 1.0 + UNIT_NORM_TOLERANCE


@pytest.mark.network
def test_the_batch_size_does_not_change_a_vector(files: ModelFiles, spec: EmbeddingSpec) -> None:
    one_at_a_time = Embedder(files, spec, batch_size=1, threads=1)
    all_at_once = Embedder(files, spec, batch_size=len(TEXTS), threads=1)
    assert np.allclose(
        one_at_a_time.embed(TEXTS)[0], all_at_once.embed(TEXTS)[0], atol=BATCH_TOLERANCE
    )


@pytest.mark.network
def test_the_default_thread_count_is_used_when_none_is_given(
    files: ModelFiles, spec: EmbeddingSpec
) -> None:
    assert default_threads() >= 1
    vectors, _ = Embedder(files, spec).embed([TEXTS[4]])
    assert vectors.shape == (1, DIMENSION)


@pytest.mark.network
def test_a_batch_size_below_one_is_refused(files: ModelFiles, spec: EmbeddingSpec) -> None:
    with pytest.raises(InitError) as caught:
        Embedder(files, spec, batch_size=0)
    assert caught.value.exit_code is ExitCode.MODEL


@pytest.mark.network
def test_an_output_the_graph_does_not_have_is_refused(
    files: ModelFiles, spec: EmbeddingSpec
) -> None:
    with pytest.raises(InitError, match="has no output"):
        Embedder(files, replace(spec, onnx_output="pooler_output_that_is_not_there"))


@pytest.mark.network
def test_an_input_the_pin_does_not_list_is_refused(files: ModelFiles, spec: EmbeddingSpec) -> None:
    with pytest.raises(InitError, match="the pin does not list"):
        Embedder(files, replace(spec, onnx_inputs=("input_ids",)))


@pytest.mark.network
def test_parity_with_the_contracts_fixture(embedder: Embedder, spec: EmbeddingSpec) -> None:
    """Cosine ≥ 0.9999 against the contracts' reference vectors."""
    fixture = spec.fixture_path(contracts_dir())
    if not fixture.is_file():
        message = (
            f"{fixture} does not exist yet; the Python/Node embedding parity is NOT being checked"
        )
        if require_model():
            pytest.fail(message)
        warnings.warn(message, stacklevel=1)
        pytest.skip(message)

    document: dict[str, Any] = json.loads(fixture.read_text(encoding="utf-8"))
    assert document["model_id"] == spec.model_id
    assert document["revision"] == spec.revision
    assert document["dimension"] == spec.dimension
    assert document["pooling"] == spec.pooling
    assert document["normalize"] == spec.normalize

    sentences = document["sentences"]
    assert sentences, "the parity fixture carries no sentences"
    vectors, _ = embedder.embed([sentence["text"] for sentence in sentences])

    for index, sentence in enumerate(sentences):
        reference = np.asarray(sentence["vector"], dtype=np.float32)
        assert reference.shape == (spec.dimension,)
        similarity = cosine(vectors[index], reference)
        assert similarity >= PARITY_MIN_COSINE, (
            f"sentence {index} drifted from the contracts fixture: cosine {similarity:.6f}"
        )


# --- the database dimension check --------------------------------------------


class _FakeConnection:
    """Just enough of ``pg8000.native.Connection`` for one query."""

    def __init__(self, rows: list[list[Any]]) -> None:
        self._rows = rows
        self.queries: list[str] = []

    def run(self, sql: str) -> list[list[Any]]:
        self.queries.append(sql)
        return self._rows


def test_assert_dimension_accepts_the_pinned_width() -> None:
    spec = load_spec(contracts_dir())
    connection = _FakeConnection([[f"vector({spec.dimension})"]])
    assert_dimension(connection, spec)  # type: ignore[arg-type]
    assert "app" in connection.queries[0]
    assert "format_type" in connection.queries[0]


def test_assert_dimension_rejects_a_different_width() -> None:
    spec = load_spec(contracts_dir())
    connection = _FakeConnection([["vector(768)"]])
    with pytest.raises(InitError) as caught:
        assert_dimension(connection, spec)  # type: ignore[arg-type]
    assert caught.value.exit_code is ExitCode.CONFIG
    assert "vector(768)" in caught.value.message


def test_assert_dimension_rejects_a_column_that_is_not_a_vector() -> None:
    spec = load_spec(contracts_dir())
    connection = _FakeConnection([["text"]])
    with pytest.raises(InitError, match="not a pgvector column"):
        assert_dimension(connection, spec)  # type: ignore[arg-type]


def test_assert_dimension_rejects_a_missing_column() -> None:
    spec = load_spec(contracts_dir())
    connection = _FakeConnection([])
    with pytest.raises(InitError) as caught:
        assert_dimension(connection, spec)  # type: ignore[arg-type]
    assert caught.value.exit_code is ExitCode.CONFIG
    assert "migrations" in caught.value.message

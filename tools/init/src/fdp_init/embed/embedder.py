# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The ONNX embedder.

``onnxruntime`` and ``tokenizers`` only: no ``torch``, no ``huggingface_hub``,
no ``fastembed``, because the backend runs the very same graph through
``onnxruntime-node`` and the two sides have to land within a cosine of 0.9999
of each other. Everything that could drift — the input names, the
output name, the pooling mode, the normalisation, the token ceiling — is read
from :class:`~fdp_init.embed.spec.EmbeddingSpec`, never decided here.

:func:`assert_dimension` closes the other half of the contract: the vector
width of ``app.chunks.embedding`` must be the width the pin promises, checked
before a single row is written.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

import numpy as np
import onnxruntime as ort
from numpy.typing import NDArray
from tokenizers import Encoding, Tokenizer

from fdp_init.embed.model_cache import ModelFiles
from fdp_init.embed.spec import EmbeddingSpec
from fdp_init.errors import ExitCode, InitError

if TYPE_CHECKING:  # only the annotation needs the driver here
    import pg8000.native

STEP = "model"

DEFAULT_BATCH_SIZE = 32
"""``INIT_EMBED_BATCH_SIZE``'s default, for callers without settings."""

PAD_TOKEN = "[PAD]"  # noqa: S105 - a tokenizer piece, not a credential
"""The padding piece of the pinned WordPiece vocabulary."""

MEAN_EPSILON = 1e-9
"""Floor of the mask sum, so an all-padding row cannot divide by zero."""

NORM_EPSILON = 1e-12
"""Floor of the L2 norm, same reason."""

DIMENSION_SQL = """
SELECT format_type(a.atttypid, a.atttypmod)
FROM pg_attribute AS a
JOIN pg_class AS c ON c.oid = a.attrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'app'
  AND c.relname = 'chunks'
  AND a.attname = 'embedding'
  AND NOT a.attisdropped
"""
"""The declared type of the column the vectors go into, ``vector(384)``."""

_VECTOR_TYPE = re.compile(r"^vector\((?P<dimension>\d+)\)$")

logger = logging.getLogger(__name__)


def default_threads() -> int:
    """``min(4, cpu_count)``, the default of ``INIT_ORT_THREADS``."""
    return min(4, os.cpu_count() or 1)


def _fail(message: str) -> InitError:
    """Exit code 7: the model is there but cannot be run."""
    return InitError(ExitCode.MODEL, message, STEP)


def _pool(
    hidden: NDArray[np.float32], mask: NDArray[np.int64], pooling: str
) -> NDArray[np.float32]:
    """Reduce ``(batch, tokens, dim)`` to ``(batch, dim)`` the way the pin says.

    ``mean`` averages over the real tokens only, so padding a batch differently
    cannot move a vector; ``cls`` takes the first position. Both branches are
    what the backend implements in TypeScript.
    """
    if pooling == "cls":
        return hidden[:, 0, :].astype(np.float32)
    if pooling != "mean":
        raise _fail(f"embedding.json: unknown pooling {pooling!r}")
    weights = mask.astype(np.float32)[:, :, None]
    summed = (hidden * weights).sum(axis=1)
    counts = np.maximum(weights.sum(axis=1), MEAN_EPSILON)
    return (summed / counts).astype(np.float32)


def _normalize(vectors: NDArray[np.float32]) -> NDArray[np.float32]:
    """Scale every row to unit L2 length."""
    norms = np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), NORM_EPSILON)
    return (vectors / norms).astype(np.float32)


class Embedder:
    """Turns text into the vectors ``app.chunks.embedding`` stores.

    The session and the tokenizer are built once; :meth:`embed` may be called
    as often as the pipeline needs. Batches are cut at ``batch_size`` after
    sorting by token length, which keeps padding small, and the rows are put
    back in the caller's order before they are returned.

    Args:
        files: The verified cache entries from
            :func:`~fdp_init.embed.model_cache.ensure_model`.
        spec: The pin those files belong to.
        batch_size: ``INIT_EMBED_BATCH_SIZE``.
        threads: ``INIT_ORT_THREADS``; ``None`` means :func:`default_threads`.

    Raises:
        InitError: exit code 7, when the graph or the tokenizer cannot be
            loaded, or when either disagrees with the pin.
    """

    def __init__(
        self,
        files: ModelFiles,
        spec: EmbeddingSpec,
        *,
        batch_size: int = DEFAULT_BATCH_SIZE,
        threads: int | None = None,
    ) -> None:
        if batch_size < 1:
            raise _fail(f"the embedding batch size must be >= 1, got {batch_size}")
        self._spec = spec
        self._batch_size = batch_size
        self._tokenizer = _load_tokenizer(files, spec)
        self._session = _load_session(files, threads if threads is not None else default_threads())
        self._inputs = _resolve_inputs(self._session, spec)
        _require_output(self._session, spec)

    @property
    def spec(self) -> EmbeddingSpec:
        """The pin this embedder was built from."""
        return self._spec

    @property
    def tokenizer(self) -> Tokenizer:
        """The model's own tokenizer, so the chunker counts what the graph sees."""
        return self._tokenizer

    def count_tokens(self, text: str) -> int:
        """The number of real tokens ``text`` produces, padding excluded.

        Truncation is on, so the answer never exceeds ``spec.max_tokens``.
        """
        return int(sum(self._tokenizer.encode(text).attention_mask))

    def embed(self, texts: Sequence[str]) -> tuple[NDArray[np.float32], list[int]]:
        """Embed ``texts`` and report how many tokens each one used.

        Returns:
            A ``(len(texts), spec.dimension)`` float32 array in the order the
            texts came in, and the per-text token counts before padding.

        Raises:
            InitError: exit code 7, when the graph returns a width the pin
                does not promise.
        """
        vectors = np.zeros((len(texts), self._spec.dimension), dtype=np.float32)
        counts = [self.count_tokens(text) for text in texts]
        order = sorted(range(len(texts)), key=lambda index: (counts[index], index))
        for start in range(0, len(order), self._batch_size):
            batch = order[start : start + self._batch_size]
            vectors[batch] = self._run([texts[index] for index in batch])
        return vectors, counts

    def _run(self, batch: Sequence[str]) -> NDArray[np.float32]:
        """Tokenize, run and pool one batch, padded to its own longest text."""
        encodings: list[Encoding] = self._tokenizer.encode_batch(list(batch))
        feed = {name: _column(encodings, name) for name in self._inputs}
        hidden = self._session.run([self._spec.onnx_output], feed)[0].astype(np.float32)
        pooled = _pool(hidden, _column(encodings, "attention_mask"), self._spec.pooling)
        if pooled.shape[1] != self._spec.dimension:
            raise _fail(
                f"the graph produced {pooled.shape[1]}-wide vectors, "
                f"but the pin promises {self._spec.dimension}"
            )
        return _normalize(pooled) if self._spec.normalize else pooled


def _column(encodings: Sequence[Encoding], name: str) -> NDArray[np.int64]:
    """One int64 model input built from a batch of encodings."""
    if name == "input_ids":
        return np.array([encoding.ids for encoding in encodings], dtype=np.int64)
    if name == "attention_mask":
        return np.array([encoding.attention_mask for encoding in encodings], dtype=np.int64)
    if name == "token_type_ids":
        return np.array([encoding.type_ids for encoding in encodings], dtype=np.int64)
    raise _fail(f"the graph asks for an input this embedder cannot build: {name!r}")


def _load_tokenizer(files: ModelFiles, spec: EmbeddingSpec) -> Tokenizer:
    """The pinned tokenizer, truncating at ``max_tokens`` and padding a batch."""
    try:
        tokenizer: Tokenizer = Tokenizer.from_file(str(files.tokenizer_path))
    except Exception as exc:  # tokenizers raises bare Exception subclasses
        raise _fail(f"cannot load the tokenizer {files.tokenizer_path}: {exc}") from exc
    tokenizer.enable_truncation(max_length=spec.max_tokens)
    pad_id = tokenizer.token_to_id(PAD_TOKEN)
    if pad_id is None:
        raise _fail(f"{files.tokenizer_path}: no {PAD_TOKEN} token to pad a batch with")
    tokenizer.enable_padding(direction="right", pad_id=pad_id, pad_token=PAD_TOKEN)
    return tokenizer


def _load_session(files: ModelFiles, threads: int) -> ort.InferenceSession:
    """A CPU session with every graph optimisation on."""
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    try:
        session: ort.InferenceSession = ort.InferenceSession(
            str(files.model_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
    except Exception as exc:  # onnxruntime raises its own Fail/InvalidGraph
        raise _fail(f"cannot load the ONNX graph {files.model_path}: {exc}") from exc
    return session


def _resolve_inputs(session: ort.InferenceSession, spec: EmbeddingSpec) -> tuple[str, ...]:
    """The inputs to feed: the ones the graph declares, checked against the pin.

    A graph that wants an input the pin does not list means the cached file and
    ``embedding.json`` have drifted apart, which is worth failing over rather
    than feeding zeros.
    """
    declared = tuple(node.name for node in session.get_inputs())
    unexpected = [name for name in declared if name not in spec.onnx_inputs]
    if unexpected:
        raise _fail(
            f"the graph declares input(s) the pin does not list: {', '.join(unexpected)}; "
            f"embedding.json names {', '.join(spec.onnx_inputs)}"
        )
    return declared


def _require_output(session: ort.InferenceSession, spec: EmbeddingSpec) -> None:
    """Fail now when the graph has no output by the pinned name."""
    available = [node.name for node in session.get_outputs()]
    if spec.onnx_output not in available:
        raise _fail(
            f"the graph has no output {spec.onnx_output!r}; it offers {', '.join(available)}"
        )


def assert_dimension(connection: pg8000.native.Connection, spec: EmbeddingSpec) -> None:
    """Check that ``app.chunks.embedding`` is ``vector(spec.dimension)``.

    The repository keeps the dimension in exactly two places — the migration and
    ``embedding.json`` — so the only way they can disagree is a model swap
    without a migration. That is a configuration mistake, caught before the
    first chunk is embedded.

    Raises:
        InitError: exit code 2, when the column is missing, is not a
            ``vector`` or has a different width.
    """
    rows: Sequence[Sequence[Any]] = connection.run(DIMENSION_SQL)
    if not rows:
        raise InitError(
            ExitCode.CONFIG,
            "app.chunks.embedding does not exist; run the migrations first",
            STEP,
        )
    declared = str(rows[0][0])
    match = _VECTOR_TYPE.match(declared)
    if match is None:
        raise InitError(
            ExitCode.CONFIG,
            f"app.chunks.embedding is {declared}, not a pgvector column",
            STEP,
        )
    found = int(match.group("dimension"))
    if found != spec.dimension:
        raise InitError(
            ExitCode.CONFIG,
            f"app.chunks.embedding is vector({found}) but {spec.model_id} "
            f"produces {spec.dimension} dimensions",
            STEP,
        )
    logger.debug(
        "embedding dimension agrees with the pin",
        extra={"step": STEP, "dimension": found, "model_id": spec.model_id},
    )

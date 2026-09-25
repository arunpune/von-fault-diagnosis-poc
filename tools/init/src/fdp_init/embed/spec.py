# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The embedding pin (``embedding.json``) as a frozen value.

`packages/contracts/embedding.json` is the single place that says which model
the project embeds with: the repository, the commit, the two files and their
SHA-256, the pooling mode, whether vectors are normalised and how many tokens
fit. Init reads it, the backend reads it and neither hard-codes a
model fact, so swapping the model is a configuration change plus a bump of
``INGEST_VERSION``.

Every malformed or missing field is a configuration error — exit code 2,
raised before the first byte is downloaded.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from fdp_init.errors import ExitCode, InitError

STEP = "model"

EMBEDDING_FILENAME = "embedding.json"
"""The pin's name inside ``CONTRACTS_DIR``."""

POOLINGS = ("mean", "cls")
"""The two pooling modes the embedder implements."""

HUGGINGFACE_RESOLVE = "https://huggingface.co/{model_id}/resolve/{revision}/{path}"
"""Download URL template; the only place a host name appears."""

ONNX_SUFFIX = ".onnx"
TOKENIZER_NAME = "tokenizer.json"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _fail(message: str) -> InitError:
    """The one error every check in this module raises."""
    return InitError(ExitCode.CONFIG, message, STEP)


def _field(document: Mapping[str, object], name: str, where: str) -> object:
    """The raw value of ``name``, or a configuration error naming it."""
    try:
        return document[name]
    except KeyError:
        raise _fail(f"{where}: missing field {name!r}") from None


def _string(document: Mapping[str, object], name: str, where: str, *, empty: bool = False) -> str:
    """A string field; ``empty=True`` allows ``""`` (the two prefixes)."""
    value = _field(document, name, where)
    if not isinstance(value, str):
        raise _fail(f"{where}: {name} must be a string, got {type(value).__name__}")
    if not value and not empty:
        raise _fail(f"{where}: {name} must not be empty")
    return value


def _integer(document: Mapping[str, object], name: str, where: str) -> int:
    """A positive integer field. ``bool`` is not an integer here."""
    value = _field(document, name, where)
    if isinstance(value, bool) or not isinstance(value, int):
        raise _fail(f"{where}: {name} must be an integer, got {type(value).__name__}")
    if value < 1:
        raise _fail(f"{where}: {name} must be >= 1, got {value}")
    return value


def _boolean(document: Mapping[str, object], name: str, where: str) -> bool:
    """A JSON ``true``/``false`` field."""
    value = _field(document, name, where)
    if not isinstance(value, bool):
        raise _fail(f"{where}: {name} must be true or false, got {type(value).__name__}")
    return value


def _mapping(document: Mapping[str, object], name: str, where: str) -> Mapping[str, object]:
    """A nested object field."""
    value = _field(document, name, where)
    if not isinstance(value, dict):
        raise _fail(f"{where}: {name} must be an object, got {type(value).__name__}")
    return value


def _sequence(document: Mapping[str, object], name: str, where: str) -> Sequence[object]:
    """A non-empty array field."""
    value = _field(document, name, where)
    if not isinstance(value, list):
        raise _fail(f"{where}: {name} must be an array, got {type(value).__name__}")
    if not value:
        raise _fail(f"{where}: {name} must not be empty")
    return value


def _names(document: Mapping[str, object], name: str, where: str) -> tuple[str, ...]:
    """A non-empty array of non-empty strings (``onnx.inputs``)."""
    values = _sequence(document, name, where)
    for index, value in enumerate(values):
        if not isinstance(value, str) or not value:
            raise _fail(f"{where}: {name}[{index}] must be a non-empty string, got {value!r}")
    return tuple(str(value) for value in values)


@dataclass(frozen=True, slots=True)
class ModelFile:
    """One pinned artefact of the model repository.

    Attributes:
        path: The path inside the model repository, for example
            ``onnx/model.onnx``. It is also the path inside the cache.
        sha256: Lowercase hexadecimal digest the download is held to.
        bytes: The expected size, used to spot a truncated cache entry
            without hashing 90 MB first.
    """

    path: str
    sha256: str
    bytes: int

    @classmethod
    def parse(cls, entry: object, where: str) -> ModelFile:
        """Build one entry of ``files[]``, or raise a configuration error."""
        if not isinstance(entry, dict):
            raise _fail(f"{where}: must be an object, got {type(entry).__name__}")
        path = _string(entry, "path", where)
        if PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts:
            raise _fail(f"{where}: path must be relative and free of '..', got {path!r}")
        sha256 = _string(entry, "sha256", where)
        if _SHA256.match(sha256) is None:
            raise _fail(f"{where}: sha256 must be 64 lowercase hex characters, got {sha256!r}")
        return cls(path=path, sha256=sha256, bytes=_integer(entry, "bytes", where))


@dataclass(frozen=True, slots=True)
class EmbeddingSpec:
    """``embedding.json``, validated.

    Attributes:
        model_id: The model repository, ``<owner>/<name>``.
        revision: The commit the pin freezes; part of the cache path.
        license: The model's SPDX identifier; a shipped model is permissive.
        dimension: Vector width; must equal the ``vector(N)`` of
            ``app.chunks.embedding`` (:func:`~fdp_init.embed.assert_dimension`).
        pooling: ``mean`` or ``cls``.
        normalize: Whether vectors are L2-normalised after pooling.
        max_tokens: The truncation ceiling the chunker also respects.
        query_prefix: Prepended to a retrieval query (empty for this model).
        passage_prefix: Prepended to a stored chunk (empty for this model).
        onnx_inputs: The input names the pinned graph declares.
        onnx_output: The token-level output the embedder pools.
        files: Every artefact to download, in pin order.
        fixture: The parity fixture, relative to ``CONTRACTS_DIR``.
    """

    model_id: str
    revision: str
    license: str
    dimension: int
    pooling: str
    normalize: bool
    max_tokens: int
    query_prefix: str
    passage_prefix: str
    onnx_inputs: tuple[str, ...]
    onnx_output: str
    files: tuple[ModelFile, ...]
    fixture: str

    @classmethod
    def load(cls, path: Path) -> EmbeddingSpec:
        """Read and validate the pin at ``path``.

        Raises:
            InitError: exit code 2, when the file is missing or unreadable, is
                not a JSON object, or has a field that is absent, of the wrong
                type or out of range.
        """
        where = str(path)
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise _fail(f"cannot read the embedding pin {path}: {exc}") from exc
        except ValueError as exc:
            raise _fail(f"{where}: not valid JSON: {exc}") from exc
        if not isinstance(document, dict):
            raise _fail(f"{where}: must be a JSON object, got {type(document).__name__}")

        pooling = _string(document, "pooling", where)
        if pooling not in POOLINGS:
            raise _fail(f"{where}: pooling must be one of {', '.join(POOLINGS)}, got {pooling!r}")

        onnx = _mapping(document, "onnx", where)
        onnx_where = f"{where}: onnx"
        inputs = _names(onnx, "inputs", onnx_where)

        files = tuple(
            ModelFile.parse(entry, f"{where}: files[{index}]")
            for index, entry in enumerate(_sequence(document, "files", where))
        )

        spec = cls(
            model_id=_string(document, "model_id", where),
            revision=_string(document, "revision", where),
            license=_string(document, "license", where),
            dimension=_integer(document, "dimension", where),
            pooling=pooling,
            normalize=_boolean(document, "normalize", where),
            max_tokens=_integer(document, "max_tokens", where),
            query_prefix=_string(document, "query_prefix", where, empty=True),
            passage_prefix=_string(document, "passage_prefix", where, empty=True),
            onnx_inputs=inputs,
            onnx_output=_string(onnx, "output", onnx_where),
            files=files,
            fixture=_string(document, "fixture", where),
        )
        # A pin that names no graph or no tokenizer fails here, not half-way
        # through a 91 MB download.
        spec.onnx_file()
        spec.tokenizer_file()
        return spec

    @property
    def key(self) -> str:
        """The identity the ingest idempotency check compares."""
        return f"{self.model_id}@{self.revision}:{self.pooling}:{self.max_tokens}"

    @property
    def cache_subdir(self) -> Path:
        """``<model_id with "/" → "--">/<revision>``, the layout the backend shares."""
        return Path(self.model_id.replace("/", "--")) / self.revision

    def file_url(self, path: str) -> str:
        """The resolve URL of one pinned file."""
        return HUGGINGFACE_RESOLVE.format(model_id=self.model_id, revision=self.revision, path=path)

    def fixture_path(self, contracts_dir: Path) -> Path:
        """The parity fixture the contracts write, resolved against ``CONTRACTS_DIR``."""
        return contracts_dir / self.fixture

    def onnx_file(self) -> ModelFile:
        """The pinned ONNX graph.

        Raises:
            InitError: exit code 2, when ``files[]`` lists no ``*.onnx``.
        """
        return self._only(lambda file: file.path.endswith(ONNX_SUFFIX), f"*{ONNX_SUFFIX} graph")

    def tokenizer_file(self) -> ModelFile:
        """The pinned ``tokenizer.json``.

        Raises:
            InitError: exit code 2, when ``files[]`` lists no tokenizer.
        """
        return self._only(
            lambda file: PurePosixPath(file.path).name == TOKENIZER_NAME, TOKENIZER_NAME
        )

    def _only(self, matches: Callable[[ModelFile], bool], what: str) -> ModelFile:
        """The single ``files[]`` entry that satisfies ``matches``."""
        found = [file for file in self.files if matches(file)]
        if not found:
            raise _fail(f"{EMBEDDING_FILENAME}: files[] lists no {what}")
        if len(found) > 1:
            names = ", ".join(file.path for file in found)
            raise _fail(f"{EMBEDDING_FILENAME}: files[] lists {what} more than once: {names}")
        return found[0]


def spec_path(contracts_dir: Path) -> Path:
    """Where the pin lives inside ``CONTRACTS_DIR``."""
    return contracts_dir / EMBEDDING_FILENAME


def load_spec(contracts_dir: Path) -> EmbeddingSpec:
    """Load the pin of a contracts directory (``settings.contracts_dir``)."""
    return EmbeddingSpec.load(spec_path(contracts_dir))

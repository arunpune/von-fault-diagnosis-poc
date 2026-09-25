# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.13,<3.14"
# dependencies = [
#     "huggingface-hub==1.32.0",
#     "numpy==2.5.3",
#     "onnxruntime==1.30.0",
#     "tokenizers==0.23.2",
# ]
# ///
"""Reference embedder behind ``packages/contracts/embedding.json``.

Init (Python) and the backend (Node) must put manual chunks and retrieval queries in the
same vector space, so both read this pin and both prove themselves against the fixture this
script writes. Three sub-commands:

``pin``
    Resolve the model repository's current commit, download the two pinned files, hash them,
    read the input and output names off the real ONNX graph and write ``embedding.json``.

``embed``
    Embed the eight reference sentences with the pinned files and write
    ``fixtures/embeddings/all-minilm-l6-v2.json``.

``check``
    Re-embed the committed sentences and require cosine ≥ 0.9999 against the committed
    vectors, with the downloaded files still matching the pinned SHA-256.

Model files are large and are never committed: they live in ``--cache`` (default
``~/.cache/fdp-embed``) under the same ``<model_id with "/" → "--">/<revision>/<path>``
layout init uses for the shared ``model-cache`` volume.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import numpy as np
import onnxruntime as ort
from huggingface_hub import HfApi, hf_hub_download
from numpy.typing import NDArray
from tokenizers import Encoding, Tokenizer

MODEL_ID: Final = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_LICENSE: Final = "Apache-2.0"
MODEL_FILES: Final = ("onnx/model.onnx", "tokenizer.json")
ONNX_FILE: Final = "onnx/model.onnx"
TOKENIZER_FILE: Final = "tokenizer.json"

DIMENSION: Final = 384
POOLING: Final = "mean"
NORMALIZE: Final = True
MAX_TOKENS: Final = 256
QUERY_PREFIX: Final = ""
PASSAGE_PREFIX: Final = ""

RUNTIME: Final = {
    "onnxruntime": "1.30.0",
    "onnxruntime_node": "1.30.0",
    "tokenizers": "0.23.2",
    "huggingface_tokenizers": "0.2.0",
}
"""The four runtime pins, mirrored into the config."""

FIXTURE_REL: Final = "fixtures/embeddings/all-minilm-l6-v2.json"
PACKAGE_ROOT: Final = Path(__file__).resolve().parents[1]
CONFIG_PATH: Final = PACKAGE_ROOT / "embedding.json"
FIXTURE_PATH: Final = PACKAGE_ROOT / FIXTURE_REL

DEFAULT_CACHE: Final = Path.home() / ".cache" / "fdp-embed"
PARITY_MIN_COSINE: Final = 0.9999
UNIT_NORM_TOLERANCE: Final = 1e-4
VECTOR_DECIMALS: Final = 7
PAD_TOKEN: Final = "[PAD]"  # noqa: S105 - a tokenizer's padding piece, not a credential
HASH_BLOCK_BYTES: Final = 1024 * 1024

SENTENCES: Final = (
    "The oil temperature rises above the warning threshold while the unit is loaded.",
    "Frequent load cycles with a fast pressure drop indicate a leak in the downstream network.",
    "The dryer tower fails to switch over and the outlet dew point climbs above the alarm limit.",
    "A clogged intake filter lowers the delivered flow and raises the motor current at the same "
    "discharge pressure.",
    "Standing water in the air receiver points to a condensate drain that no longer opens.",
    "The unit trips on high discharge temperature after a long period of running unloaded.",
    "Vibration at the coupling grows while the compressor holds its set pressure.",
    "The controller reports a sensor fault when the pressure reading stays flat during a load "
    "change.",
)
"""Eight fictional manual-like lines, brand-free, that both languages must embed alike."""


class EmbedError(RuntimeError):
    """Something the operator has to fix: a missing pin, a bad hash, a drifting vector."""


@dataclass(frozen=True)
class PinnedFile:
    """One pinned model file: where it lives upstream and what it must hash to."""

    path: str
    sha256: str
    size: int


def file_url(path: str, revision: str) -> str:
    """The resolve URL init and the backend both derive from the pin."""
    return f"https://huggingface.co/{MODEL_ID}/resolve/{revision}/{path}"


def model_dir(cache: Path, revision: str) -> Path:
    """Where the two files of one revision live, in init's shared-volume layout."""
    return cache / MODEL_ID.replace("/", "--") / revision


def sha256_of(path: Path) -> str:
    """Stream the file and return its lowercase hexadecimal SHA-256."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(HASH_BLOCK_BYTES):
            digest.update(block)
    return digest.hexdigest()


def download(cache: Path, revision: str) -> dict[str, Path]:
    """Fetch the pinned files of one revision into the cache and return their paths."""
    target = model_dir(cache, revision)
    target.mkdir(parents=True, exist_ok=True)
    return {
        name: Path(
            hf_hub_download(
                repo_id=MODEL_ID,
                filename=name,
                revision=revision,
                local_dir=str(target),
            )
        )
        for name in MODEL_FILES
    }


def resolve_revision() -> str:
    """The model repository's current commit SHA, the value the pin freezes."""
    sha = HfApi().model_info(MODEL_ID).sha
    if sha is None:
        raise EmbedError(f"{MODEL_ID}: the model info carries no commit sha")
    return sha


def make_session(onnx_path: Path) -> ort.InferenceSession:
    """A single-threaded CPU session, so two runs on one machine agree bit for bit."""
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(
        str(onnx_path), sess_options=options, providers=["CPUExecutionProvider"]
    )


def inspect_graph(session: ort.InferenceSession) -> dict[str, Any]:
    """Read the input names and the token-level output name off the real graph."""
    inputs = [node.name for node in session.get_inputs()]
    outputs = session.get_outputs()
    token_level = [node for node in outputs if len(node.shape) == 3]
    chosen = token_level[0] if token_level else outputs[0]
    return {"inputs": inputs, "output": chosen.name}


def make_tokenizer(tokenizer_path: Path, max_tokens: int) -> Tokenizer:
    """The pinned tokenizer, truncating at ``max_tokens`` and padding a batch to its longest."""
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    tokenizer.enable_truncation(max_length=max_tokens)
    pad_id = tokenizer.token_to_id(PAD_TOKEN)
    if pad_id is None:
        raise EmbedError(f"{tokenizer_path}: no {PAD_TOKEN} token to pad a batch with")
    tokenizer.enable_padding(direction="right", pad_id=pad_id, pad_token=PAD_TOKEN)
    return tokenizer


def _feed(encodings: Sequence[Encoding], names: Sequence[str]) -> dict[str, NDArray[np.int64]]:
    """The model inputs the graph asks for, built from one batch of encodings."""
    available = {
        "input_ids": np.array([encoding.ids for encoding in encodings], dtype=np.int64),
        "attention_mask": np.array(
            [encoding.attention_mask for encoding in encodings], dtype=np.int64
        ),
        "token_type_ids": np.array([encoding.type_ids for encoding in encodings], dtype=np.int64),
    }
    missing = [name for name in names if name not in available]
    if missing:
        raise EmbedError(f"{ONNX_FILE}: unsupported graph input(s) {', '.join(missing)}")
    return {name: available[name] for name in names}


def _pool(
    hidden: NDArray[np.float32], mask: NDArray[np.int64], pooling: str
) -> NDArray[np.float32]:
    """Mean pooling over the attention mask, or the CLS vector; the config picks."""
    if pooling == "cls":
        return hidden[:, 0, :].astype(np.float32)
    if pooling != "mean":
        raise EmbedError(f"embedding.json: unknown pooling {pooling!r}")
    weights = mask.astype(np.float32)[:, :, None]
    summed = (hidden * weights).sum(axis=1)
    counts = np.maximum(weights.sum(axis=1), 1e-9)
    return (summed / counts).astype(np.float32)


class Embedder:
    """The reference implementation the Node side has to match to four nines of cosine."""

    def __init__(self, config: dict[str, Any], files: dict[str, Path]) -> None:
        self._config = config
        self._session = make_session(files[ONNX_FILE])
        self._tokenizer = make_tokenizer(files[TOKENIZER_FILE], int(config["max_tokens"]))
        self._inputs: list[str] = list(config["onnx"]["inputs"])
        self._output: str = str(config["onnx"]["output"])

    def embed(self, texts: Sequence[str]) -> NDArray[np.float32]:
        """Embed a batch and return one row per text, pooled and normalised per the config."""
        encodings = self._tokenizer.encode_batch(list(texts))
        feed = _feed(encodings, self._inputs)
        hidden = self._session.run([self._output], dict(feed))[0].astype(np.float32)
        pooled = _pool(hidden, feed["attention_mask"], str(self._config["pooling"]))
        if not self._config["normalize"]:
            return pooled
        norms = np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
        return (pooled / norms).astype(np.float32)


def write_json(path: Path, document: dict[str, Any]) -> None:
    """Write a document the way Prettier would, so the tree stays format-stable."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_config() -> dict[str, Any]:
    """The committed pin, or a message saying to run ``pin`` first."""
    if not CONFIG_PATH.exists():
        raise EmbedError(f"{CONFIG_PATH}: missing; run `uv run {_script_rel()} pin` first")
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise EmbedError(f"{CONFIG_PATH}: not a JSON object")
    return config


def _script_rel() -> str:
    """This script's path as the README spells it."""
    return "packages/contracts/scripts/embed_fixture.py"


def pinned_files(config: dict[str, Any]) -> dict[str, PinnedFile]:
    """The ``files[]`` block as a lookup by repository path."""
    return {
        str(entry["path"]): PinnedFile(
            path=str(entry["path"]), sha256=str(entry["sha256"]), size=int(entry["bytes"])
        )
        for entry in config["files"]
    }


def ensure_files(config: dict[str, Any], cache: Path) -> dict[str, Path]:
    """Download what the cache lacks, then hold every file to its pinned size and hash."""
    revision = str(config["revision"])
    expected = pinned_files(config)
    directory = model_dir(cache, revision)
    present = {name: directory / name for name in expected}
    if not all(path.exists() for path in present.values()):
        present = download(cache, revision)
    for name, pinned in expected.items():
        path = present[name]
        size = path.stat().st_size
        if size != pinned.size:
            raise EmbedError(f"{path}: {size} bytes, pinned at {pinned.size}")
        actual = sha256_of(path)
        if actual != pinned.sha256:
            raise EmbedError(f"{path}: sha256 {actual}, pinned at {pinned.sha256}")
    return present


def _rounded(value: float) -> float:
    """One fixture component: short enough to read in a diff, exact enough for parity."""
    rounded = round(value, VECTOR_DECIMALS)
    return 0.0 if rounded == 0.0 else rounded


def cosine(left: NDArray[np.float32], right: NDArray[np.float32]) -> float:
    """Cosine similarity of two vectors; both sides are normalised, so this is their dot."""
    denominator = float(np.linalg.norm(left)) * float(np.linalg.norm(right))
    if denominator == 0.0:
        raise EmbedError("cosine: a zero vector has no direction to compare")
    return float(np.dot(left, right) / denominator)


def cmd_pin(args: argparse.Namespace) -> int:
    """Resolve the revision, hash the files, read the graph and write ``embedding.json``."""
    cache = Path(args.cache).expanduser()
    revision = resolve_revision()
    print(f"pin: {MODEL_ID} at {revision}")
    files = download(cache, revision)
    graph = inspect_graph(make_session(files[ONNX_FILE]))
    document = {
        "model_id": MODEL_ID,
        "revision": revision,
        "license": MODEL_LICENSE,
        "dimension": DIMENSION,
        "pooling": POOLING,
        "normalize": NORMALIZE,
        "max_tokens": MAX_TOKENS,
        "query_prefix": QUERY_PREFIX,
        "passage_prefix": PASSAGE_PREFIX,
        "onnx": graph,
        "runtime": dict(RUNTIME),
        "files": [
            {
                "path": name,
                "sha256": sha256_of(files[name]),
                "bytes": files[name].stat().st_size,
                "url": file_url(name, revision),
            }
            for name in MODEL_FILES
        ],
        "fixture": FIXTURE_REL,
    }
    write_json(CONFIG_PATH, document)
    for entry in document["files"]:
        print(f"pin: {entry['path']} {entry['bytes']} bytes sha256 {entry['sha256']}")
    print(f"pin: graph inputs {', '.join(graph['inputs'])} -> output {graph['output']}")
    print(f"pin: wrote {CONFIG_PATH.relative_to(PACKAGE_ROOT.parents[1])}")
    return 0


def cmd_embed(args: argparse.Namespace) -> int:
    """Embed the eight reference sentences and write the committed fixture."""
    config = load_config()
    files = ensure_files(config, Path(args.cache).expanduser())
    vectors = Embedder(config, files).embed(SENTENCES)
    dimension = int(config["dimension"])
    if vectors.shape != (len(SENTENCES), dimension):
        raise EmbedError(f"embed: got {vectors.shape}, expected {(len(SENTENCES), dimension)}")
    document = {
        "model_id": str(config["model_id"]),
        "revision": str(config["revision"]),
        "dimension": dimension,
        "pooling": str(config["pooling"]),
        "normalize": bool(config["normalize"]),
        "sentences": [
            {"text": text, "vector": [_rounded(float(value)) for value in vector]}
            for text, vector in zip(SENTENCES, vectors, strict=True)
        ],
    }
    write_json(FIXTURE_PATH, document)
    print(f"embed: wrote {len(SENTENCES)} vectors of {dimension} components to {FIXTURE_REL}")
    return 0


def _load_fixture() -> dict[str, Any]:
    """The committed fixture, or a message saying to run ``embed`` first."""
    if not FIXTURE_PATH.exists():
        raise EmbedError(f"{FIXTURE_PATH}: missing; run `uv run {_script_rel()} embed` first")
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    if not isinstance(fixture, dict):
        raise EmbedError(f"{FIXTURE_PATH}: not a JSON object")
    return fixture


def _check_header(config: dict[str, Any], fixture: dict[str, Any]) -> None:
    """The fixture must have been produced by exactly the pinned model and settings."""
    for key in ("model_id", "revision", "dimension", "pooling", "normalize"):
        if fixture.get(key) != config.get(key):
            raise EmbedError(f"check: fixture {key} {fixture.get(key)!r} != pin {config[key]!r}")


def cmd_check(args: argparse.Namespace) -> int:
    """Re-embed the committed sentences and hold every vector to cosine ≥ 0.9999."""
    config = load_config()
    fixture = _load_fixture()
    _check_header(config, fixture)
    files = ensure_files(config, Path(args.cache).expanduser())
    entries = list(fixture["sentences"])
    texts = [str(entry["text"]) for entry in entries]
    if texts != list(SENTENCES):
        raise EmbedError("check: the committed sentences differ from SENTENCES; re-run `embed`")
    recomputed = Embedder(config, files).embed(texts)
    worst = 1.0
    for index, entry in enumerate(entries):
        committed = np.asarray(entry["vector"], dtype=np.float32)
        if committed.shape != (int(config["dimension"]),):
            raise EmbedError(f"check: sentence {index} has {committed.shape[0]} components")
        norm = float(np.linalg.norm(committed))
        if abs(norm - 1.0) > UNIT_NORM_TOLERANCE:
            raise EmbedError(f"check: sentence {index} has norm {norm}, expected 1")
        similarity = cosine(committed, recomputed[index])
        worst = min(worst, similarity)
        if similarity < PARITY_MIN_COSINE:
            raise EmbedError(
                f"check: sentence {index} drifted, cosine {similarity} < {PARITY_MIN_COSINE}"
            )
    print(f"check: {len(entries)} sentences match the fixture, worst cosine {worst:.7f}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """The three sub-commands and the one option they share."""
    parser = argparse.ArgumentParser(
        prog="embed_fixture.py", description="Pin and verify the embedding model."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    commands = (
        ("pin", "resolve the revision and write embedding.json", cmd_pin),
        ("embed", "write the reference fixture", cmd_embed),
        ("check", "verify the committed fixture against a fresh run", cmd_check),
    )
    for name, help_text, handler in commands:
        subparser = subparsers.add_parser(name, help=help_text)
        subparser.add_argument(
            "--cache",
            default=str(DEFAULT_CACHE),
            metavar="DIR",
            help=f"where the model files live (default: {DEFAULT_CACHE})",
        )
        subparser.set_defaults(handler=handler)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Parse the command line, run the sub-command and turn its errors into exit code 1."""
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except EmbedError as error:
        print(f"embed_fixture: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The embedding pin loader.

Every test starts from the committed pin — ``packages/contracts/embedding.json``
when it is present, the vendored copy otherwise — and mutates one field, so a
real change to the contract shows up here rather than in a hand-made document
that has quietly drifted from it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from fdp_init.embed.spec import (
    EMBEDDING_FILENAME,
    EmbeddingSpec,
    load_spec,
    spec_path,
)
from fdp_init.errors import ExitCode, InitError

ROOT = Path(__file__).resolve().parents[4]
CONTRACTS_DIR = ROOT / "packages" / "contracts"
VENDORED_CONTRACTS_DIR = ROOT / "tools" / "init" / "tests" / "fixtures" / "contracts"

MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"


def contracts_dir() -> Path:
    """The real contracts package, or the vendored copy when it is absent."""
    return CONTRACTS_DIR if spec_path(CONTRACTS_DIR).is_file() else VENDORED_CONTRACTS_DIR


def pin_document() -> dict[str, Any]:
    """The committed pin as a mutable document."""
    text = spec_path(contracts_dir()).read_text(encoding="utf-8")
    document: dict[str, Any] = json.loads(text)
    return document


@pytest.fixture
def pin(tmp_path: Path) -> Path:
    """A writable copy of the committed pin."""
    target = tmp_path / EMBEDDING_FILENAME
    target.write_text(json.dumps(pin_document()), encoding="utf-8")
    return target


def write(path: Path, document: object) -> Path:
    """Write ``document`` as the pin at ``path``."""
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def test_the_committed_pin_loads() -> None:
    spec = load_spec(contracts_dir())
    assert spec.model_id == MODEL_ID
    assert spec.license == "Apache-2.0"
    assert spec.dimension == 384
    assert spec.pooling == "mean"
    assert spec.normalize is True
    assert spec.max_tokens == 256
    assert spec.query_prefix == ""
    assert spec.passage_prefix == ""
    assert spec.onnx_inputs == ("input_ids", "attention_mask", "token_type_ids")
    assert spec.onnx_output == "last_hidden_state"
    assert len(spec.revision) == 40
    assert {file.path for file in spec.files} == {"onnx/model.onnx", "tokenizer.json"}


def test_key_is_the_idempotency_identity() -> None:
    spec = load_spec(contracts_dir())
    assert spec.key == f"{MODEL_ID}@{spec.revision}:mean:256"


def test_cache_subdir_replaces_the_slash_of_the_model_id() -> None:
    spec = load_spec(contracts_dir())
    assert spec.cache_subdir == Path("sentence-transformers--all-MiniLM-L6-v2") / spec.revision


def test_file_url_is_the_huggingface_resolve_url() -> None:
    spec = load_spec(contracts_dir())
    assert spec.file_url("onnx/model.onnx") == (
        f"https://huggingface.co/{MODEL_ID}/resolve/{spec.revision}/onnx/model.onnx"
    )


def test_fixture_path_resolves_against_the_contracts_directory() -> None:
    spec = load_spec(contracts_dir())
    assert spec.fixture_path(contracts_dir()) == contracts_dir() / spec.fixture


def test_the_two_pinned_files_are_found_by_role() -> None:
    spec = load_spec(contracts_dir())
    assert spec.onnx_file().path == "onnx/model.onnx"
    assert spec.tokenizer_file().path == "tokenizer.json"
    assert spec.onnx_file().bytes > 0
    assert len(spec.tokenizer_file().sha256) == 64


@pytest.mark.parametrize(
    "missing",
    [
        "model_id",
        "revision",
        "license",
        "dimension",
        "pooling",
        "normalize",
        "max_tokens",
        "query_prefix",
        "passage_prefix",
        "onnx",
        "files",
        "fixture",
    ],
)
def test_a_missing_field_is_a_configuration_error(pin: Path, missing: str) -> None:
    document = pin_document()
    del document[missing]
    write(pin, document)
    with pytest.raises(InitError) as caught:
        EmbeddingSpec.load(pin)
    assert caught.value.exit_code is ExitCode.CONFIG
    assert caught.value.step == "model"
    assert missing in caught.value.message


@pytest.mark.parametrize("missing", ["inputs", "output"])
def test_a_missing_onnx_field_is_a_configuration_error(pin: Path, missing: str) -> None:
    document = pin_document()
    del document["onnx"][missing]
    write(pin, document)
    with pytest.raises(InitError) as caught:
        EmbeddingSpec.load(pin)
    assert caught.value.exit_code is ExitCode.CONFIG
    assert missing in caught.value.message


@pytest.mark.parametrize("missing", ["path", "sha256", "bytes"])
def test_a_missing_file_field_is_a_configuration_error(pin: Path, missing: str) -> None:
    document = pin_document()
    del document["files"][0][missing]
    write(pin, document)
    with pytest.raises(InitError) as caught:
        EmbeddingSpec.load(pin)
    assert caught.value.exit_code is ExitCode.CONFIG
    assert "files[0]" in caught.value.message


@pytest.mark.parametrize(
    ("field", "value", "fragment"),
    [
        ("model_id", 7, "must be a string"),
        ("model_id", "", "must not be empty"),
        ("dimension", "384", "must be an integer"),
        ("dimension", True, "must be an integer"),
        ("dimension", 0, "must be >= 1"),
        ("max_tokens", -1, "must be >= 1"),
        ("normalize", "yes", "must be true or false"),
        ("pooling", "max", "pooling must be one of"),
        ("onnx", [], "must be an object"),
        ("files", [], "must not be empty"),
        ("files", {}, "must be an array"),
    ],
)
def test_a_malformed_field_is_a_configuration_error(
    pin: Path, field: str, value: object, fragment: str
) -> None:
    document = pin_document()
    document[field] = value
    write(pin, document)
    with pytest.raises(InitError) as caught:
        EmbeddingSpec.load(pin)
    assert caught.value.exit_code is ExitCode.CONFIG
    assert fragment in caught.value.message


def test_a_non_hexadecimal_digest_is_rejected(pin: Path) -> None:
    document = pin_document()
    document["files"][0]["sha256"] = "not-a-digest"
    write(pin, document)
    with pytest.raises(InitError, match="64 lowercase hex"):
        EmbeddingSpec.load(pin)


def test_an_escaping_file_path_is_rejected(pin: Path) -> None:
    document = pin_document()
    document["files"][0]["path"] = "../../etc/passwd"
    write(pin, document)
    with pytest.raises(InitError, match="free of"):
        EmbeddingSpec.load(pin)


def test_a_pin_without_an_onnx_graph_is_rejected(pin: Path) -> None:
    document = pin_document()
    document["files"] = [file for file in document["files"] if not file["path"].endswith(".onnx")]
    write(pin, document)
    with pytest.raises(InitError, match=r"no \*\.onnx graph"):
        EmbeddingSpec.load(pin)


def test_a_pin_without_a_tokenizer_is_rejected(pin: Path) -> None:
    document = pin_document()
    document["files"] = [file for file in document["files"] if file["path"] != "tokenizer.json"]
    write(pin, document)
    with pytest.raises(InitError, match=re.escape("no tokenizer.json")):
        EmbeddingSpec.load(pin)


def test_two_graphs_in_one_pin_are_rejected(pin: Path) -> None:
    document = pin_document()
    graph = next(file for file in document["files"] if file["path"].endswith(".onnx"))
    document["files"].append({**graph, "path": "onnx/model_quantized.onnx"})
    write(pin, document)
    with pytest.raises(InitError, match="more than once"):
        EmbeddingSpec.load(pin)


def test_a_missing_pin_is_a_configuration_error(tmp_path: Path) -> None:
    with pytest.raises(InitError) as caught:
        load_spec(tmp_path)
    assert caught.value.exit_code is ExitCode.CONFIG
    assert EMBEDDING_FILENAME in caught.value.message


def test_a_pin_that_is_not_json_is_a_configuration_error(tmp_path: Path) -> None:
    broken = tmp_path / EMBEDDING_FILENAME
    broken.write_text("{ not json", encoding="utf-8")
    with pytest.raises(InitError, match="not valid JSON"):
        EmbeddingSpec.load(broken)


def test_a_pin_that_is_not_an_object_is_a_configuration_error(tmp_path: Path) -> None:
    broken = write(tmp_path / EMBEDDING_FILENAME, ["nope"])
    with pytest.raises(InitError, match="must be a JSON object"):
        EmbeddingSpec.load(broken)


def test_spec_path_names_the_pin_inside_the_contracts_directory(tmp_path: Path) -> None:
    assert spec_path(tmp_path) == tmp_path / EMBEDDING_FILENAME

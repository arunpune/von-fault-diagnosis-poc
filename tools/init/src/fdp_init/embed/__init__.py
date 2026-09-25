# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Embeddings: the pin, the model cache and the ONNX embedder.

Nothing here hard-codes a model fact. ``packages/contracts/embedding.json``
names the repository, the commit, the two files with their SHA-256,
the pooling mode, the normalisation and the token ceiling; this package reads
that pin, fills the shared cache from it and runs the graph.

The public surface is re-exported so callers — the pipeline, the chunker and
the store — import from :mod:`fdp_init.embed` and never need to
know which module a name lives in.
"""

from fdp_init.embed.embedder import Embedder, assert_dimension
from fdp_init.embed.model_cache import ModelFiles, ensure_model, model_dir
from fdp_init.embed.spec import EMBEDDING_FILENAME, EmbeddingSpec, ModelFile, load_spec

__all__ = [
    "EMBEDDING_FILENAME",
    "Embedder",
    "EmbeddingSpec",
    "ModelFile",
    "ModelFiles",
    "assert_dimension",
    "ensure_model",
    "load_spec",
    "model_dir",
]

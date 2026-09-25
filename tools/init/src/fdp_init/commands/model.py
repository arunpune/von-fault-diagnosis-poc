# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init model``: pre-warm the shared model cache.

``fdp-init run`` fills the cache on its way through the pipeline, but the first
``make up`` then pays for a 91 MB download while Postgres waits. This
sub-command does only that step, so the cache can be warmed — or a CI job's
cache restored and checked — on its own. A warm cache makes no request and the
command still prints where the files are.
"""

from __future__ import annotations

import argparse
import logging

from fdp_init.config import Settings
from fdp_init.embed import ensure_model, load_spec, model_dir
from fdp_init.errors import ExitCode

STEP = "model"

logger = logging.getLogger(__name__)


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Download and verify the pinned model files, then print their paths.

    Args:
        args: Unused; the sub-command takes no options.
        settings: The environment contract; ``CONTRACTS_DIR`` holds the pin and
            ``MODEL_CACHE_DIR`` is the cache to fill.

    Returns:
        :attr:`~fdp_init.errors.ExitCode.OK`.

    Raises:
        InitError: exit code 2 when ``embedding.json`` is missing or malformed,
            exit code 7 when a file cannot be downloaded or verified. Both are
            turned into the process exit code by :func:`fdp_init.cli.main`.
    """
    del args
    spec = load_spec(settings.contracts_dir)
    logger.info(
        "filling the model cache",
        extra={
            "step": STEP,
            "event": "start",
            "model_id": spec.model_id,
            "revision": spec.revision,
            "license": spec.license,
            "cache_dir": str(model_dir(spec, settings.model_cache_dir)),
        },
    )
    files = ensure_model(
        spec,
        settings.model_cache_dir,
        timeout_s=settings.download_timeout_s,
        retries=settings.download_retries,
    )
    logger.info(
        "model cache filled",
        extra={
            "step": STEP,
            "event": "done",
            "key": spec.key,
            "dimension": spec.dimension,
            "model_path": str(files.model_path),
            "tokenizer_path": str(files.tokenizer_path),
        },
    )
    return int(ExitCode.OK)

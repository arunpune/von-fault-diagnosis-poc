#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.13,<3.14"
# dependencies = [
#     "anthropic==1.7.0",
# ]
# ///
"""Drive the mock Anthropic Messages server with the real Python client.

``mock/anthropic-sdk-compat.test.ts`` runs this through ``uv run --no-project`` and reads the
JSON it writes to stdout, so the mock is exercised by both official SDKs in one test and the
two recorded requests can be compared field by field.

The Python side reaches the one structured-output wire shape through ``messages.create`` with a
raw JSON Schema, because ``tools/init``'s structurer works from the committed contracts catalog
schema and not from a Pydantic model. The Node side reaches the same shape through
``messages.parse`` with ``zodOutputFormat``. Nothing here is specific to the mock: the same call
goes to the real API when ``LLM_BASE_URL`` is unset.

It is a PEP 723 script and not a uv workspace member on purpose: nothing else in the repository
depends on the Anthropic Python client yet (tools/init picks it up with its optional ``llm``
extra), and a compatibility test should pin its own version.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from anthropic import Anthropic

#: The structured output the catalog structurer asks for, as a plain JSON Schema. It is the
#: same shape the Node side derives from its Zod schema, so the two requests can be compared.
OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "fault_id": {"type": "string", "description": "The chosen candidate id"},
        "confidence": {"type": "number"},
    },
    "additionalProperties": False,
    "required": ["fault_id", "confidence"],
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__ or "")
    parser.add_argument("--base-url", required=True, help="Base URL of the mock server")
    parser.add_argument("--api-key", default="test", help="Key sent as x-api-key")
    parser.add_argument("--model", default="claude-opus-5")
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--prompt", default="Which candidate fits the observations?")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    client = Anthropic(api_key=args.api_key, base_url=args.base_url, max_retries=0)
    message = client.messages.create(
        model=args.model,
        max_tokens=args.max_tokens,
        messages=[{"role": "user", "content": args.prompt}],
        output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )
    text = next((block.text for block in message.content if block.type == "text"), None)
    json.dump(
        {
            "id": message.id,
            "model": message.model,
            "stop_reason": message.stop_reason,
            "parsed": None if text is None else json.loads(text),
            "usage": {
                "input_tokens": message.usage.input_tokens,
                "output_tokens": message.usage.output_tokens,
            },
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

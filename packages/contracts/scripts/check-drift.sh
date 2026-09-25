#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Proves that the committed generated artefacts still match their sources. It
# runs both generators and then diffs the three output locations:
#
#   packages/contracts/src/generated/**                      (schemas, types, topics, register map)
#   packages/contracts/generated/register-map.json           (the canonical map)
#   services/modbus/internal/regmap/register_map_gen.go      (the simulator's table)
#
# Exit 0 means the tree is in sync; exit 1 means somebody edited a schema,
# `topics.json` or one of the manual's registries without running
# `pnpm --filter @fdp/contracts generate`. CI runs it, and
# `pnpm --filter @fdp/contracts check-drift` runs it locally.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package_root=$(dirname -- "$script_dir")
repo_root=$(cd -- "${package_root}/../.." && pwd)

generated_paths=(
  "packages/contracts/src/generated"
  "packages/contracts/generated"
  "services/modbus/internal/regmap/register_map_gen.go"
)

cd -- "$package_root"
node --conditions=@fdp/source scripts/generate.ts
node --conditions=@fdp/source scripts/generate-regmap.ts

cd -- "$repo_root"
if ! git diff --exit-code -- "${generated_paths[@]}"; then
  echo "check-drift: the generated files above are stale." >&2
  echo "check-drift: run \`pnpm --filter @fdp/contracts generate\` and commit the result." >&2
  exit 1
fi

untracked=$(git ls-files --others --exclude-standard -- "${generated_paths[@]}")
if [ -n "$untracked" ]; then
  echo "check-drift: the generator wrote files that are not committed:" >&2
  echo "$untracked" >&2
  exit 1
fi

echo "check-drift: generated files are in sync with their sources."

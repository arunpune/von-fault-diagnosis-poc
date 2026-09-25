#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Validate the three Compose file combinations and their invariants.
# `make compose-check` runs this, and `make lint` runs it with everything else.
#
# For each variant it renders the configuration Docker would act on and pipes
# it into scripts/ops/compose-invariants.py, which judges the service set, the
# start order, the healthchecks, the restart policies, the volume targets, the
# reach of the two API keys, the published ports and the image pins, and reads
# the compose files and the root .dockerignore for what a rendering cannot show.
#
# `--env-file /dev/null` is not optional: without it Compose reads the
# developer's own .env and `config` prints the interpolated result, keys and
# all. With it the two key variables render empty, so this script is safe to
# run anywhere and its output is safe to paste into an issue.
#
# Without Docker only the source checks run, and the script says so; set
# FDP_REQUIRE_DOCKER=1 (CI does) to make a missing Docker a failure instead.
#
# Usage: scripts/ops/compose-check.sh [--help]
#
# Exit codes: 0 every invariant holds, 1 one does not, 2 usage error.

set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
INVARIANTS="$ROOT/scripts/ops/compose-invariants.py"

EXIT_FAILURE=1
EXIT_USAGE=2

say() {
	printf '%s\n' "compose-check: $*"
}

fail() {
	say "$*" >&2
	exit "$EXIT_FAILURE"
}

usage() {
	cat <<'USAGE'
Usage: scripts/ops/compose-check.sh [--help]

Renders compose.yaml, compose.yaml + compose.dev.yaml and
compose.yaml + compose.ci.yaml with `docker compose --env-file /dev/null …
config --format json` and asserts the stack's invariants on each of them.

  --help   print this text and exit 0

Environment:
  FDP_REQUIRE_DOCKER=1   fail instead of skipping when Docker is absent
USAGE
}

# One variant: the label the invariant script reports under, then the compose
# files to render. Kept as a function rather than an array so the script stays
# Bash 3.2 compatible (macOS ships 3.2).
check_variant() {
	local variant="$1"
	shift
	say "rendering the $variant variant"
	"$@" | python3 "$INVARIANTS" "$variant" --root "$ROOT"
}

main() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--help | -h)
			usage
			exit 0
			;;
		*)
			say "unknown argument: $1" >&2
			usage >&2
			exit "$EXIT_USAGE"
			;;
		esac
	done

	command -v python3 >/dev/null 2>&1 || fail "python3 is not installed, but this script needs it"
	[ -f "$INVARIANTS" ] || fail "$INVARIANTS is missing"

	if ! command -v docker >/dev/null 2>&1; then
		if [ -n "${FDP_REQUIRE_DOCKER:-}" ]; then
			fail "docker is not installed and FDP_REQUIRE_DOCKER is set"
		fi
		say "docker is not installed; checking the compose sources only"
		python3 "$INVARIANTS" sources --root "$ROOT"
		return 0
	fi

	cd "$ROOT"
	check_variant base \
		docker compose --env-file /dev/null -f compose.yaml config --format json
	check_variant dev \
		docker compose --env-file /dev/null -f compose.yaml -f compose.dev.yaml config --format json
	check_variant ci \
		docker compose --env-file /dev/null -f compose.yaml -f compose.ci.yaml config --format json

	if command -v uv >/dev/null 2>&1; then
		say "checking the variables against .env.example and the README table"
		uv run fdp-checks env --compose
	else
		say "uv is not installed; skipping the .env.example cross-check"
	fi

	say "ok: every Compose invariant holds"
}

main "$@"

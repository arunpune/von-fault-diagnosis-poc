#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Wait until a Compose project is up: every long-running service running and
# healthy — or just running when it has no healthcheck — and every one-shot
# service (restart policy "no", i.e. `init`) exited 0. `scripts/smoke.sh`
# runs it after `docker compose up --wait` as a second opinion, and the CI
# stack job can run it on its own.
#
# The containers are found by their Compose labels, so the script needs neither
# the compose files nor the project's .env: nothing here can render a key. It
# prints one line whenever a service changes state, which is what a CI log
# should show, and nothing while it waits.
#
# Usage: scripts/ops/wait-for-stack.sh [--timeout S] [--interval S] PROJECT
#
# The deadline is --timeout (default 900 s) multiplied by FDP_TIMING_SLACK
# (default 1; CI sets 3).
#
# Exit codes: 0 ready; 1 a one-shot service exited non-zero; 2 the deadline
# passed first; 4 usage error.

set -euo pipefail

EXIT_FAILED=1
EXIT_TIMEOUT=2
EXIT_USAGE=4

DEFAULT_TIMEOUT_S=900
DEFAULT_INTERVAL_S=2

# One line per container: service, restart policy, status, health, exit code.
INSPECT_FORMAT='{{index .Config.Labels "com.docker.compose.service"}} {{.HostConfig.RestartPolicy.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.ExitCode}}'

say() {
	printf '%s\n' "wait-for-stack: $*"
}

usage() {
	cat <<'USAGE'
Usage: scripts/ops/wait-for-stack.sh [--timeout S] [--interval S] PROJECT

Waits until every long-running service of the Compose project PROJECT is
running and healthy (running is enough without a healthcheck) and every
one-shot service has exited 0. Prints one line per state change.

  --timeout S    deadline in seconds, multiplied by FDP_TIMING_SLACK (900)
  --interval S   seconds between two looks at the containers (2)
  --help         print this text and exit 0

Exit codes: 0 ready, 1 a one-shot service failed, 2 deadline passed,
4 usage error.
USAGE
}

usage_error() {
	say "$*" >&2
	usage >&2
	exit "$EXIT_USAGE"
}

is_count() {
	case "$1" in
	'' | *[!0-9]*) return 1 ;;
	*) [ "$1" -gt 0 ] ;;
	esac
}

# FDP_TIMING_SLACK scales every wall-clock bound; it may be fractional.
check_slack() {
	case "${FDP_TIMING_SLACK:-1}" in
	'' | . | *[!0-9.]* | *.*.*) usage_error "FDP_TIMING_SLACK must be a positive number, got '${FDP_TIMING_SLACK:-}'" ;;
	esac
}

# A bound in whole seconds: the base times FDP_TIMING_SLACK, at least 1.
scaled() {
	awk -v base="$1" -v slack="${FDP_TIMING_SLACK:-1}" \
		'BEGIN { value = base * slack; if (value < 1) value = 1; printf "%d\n", value }'
}

# The state of every container of the project, one "service=state" line each,
# where state is what the wait cares about: completed, failed(<code>),
# healthy, running (no healthcheck), or whatever Docker says otherwise.
states() {
	local project="$1" ids
	ids=$(docker ps -aq \
		--filter "label=com.docker.compose.project=$project" \
		--filter "label=com.docker.compose.oneoff=False")
	[ -n "$ids" ] || return 0
	# shellcheck disable=SC2086 # one argument per container id
	docker inspect --format "$INSPECT_FORMAT" $ids | while read -r service restart status health code; do
		printf '%s=%s\n' "$service" "$(state_of "$restart" "$status" "$health" "$code")"
	done | sort
}

state_of() {
	local restart="$1" status="$2" health="$3" code="$4"
	if [ "$restart" = "no" ] && [ "$status" = "exited" ]; then
		if [ "$code" = "0" ]; then echo completed; else echo "failed($code)"; fi
	elif [ "$status" = "running" ] && [ "$health" = "none" ]; then
		echo running
	elif [ "$status" = "running" ]; then
		echo "$health"
	elif [ "$status" = "exited" ]; then
		echo "exited($code)"
	else
		echo "$status"
	fi
}

# True when there is at least one container and every one is done.
all_ready() {
	local current="$1"
	[ -n "$current" ] || return 1
	! printf '%s\n' "$current" | grep -Ev '=(completed|healthy|running)$' >/dev/null
}

main() {
	local timeout_s="$DEFAULT_TIMEOUT_S" interval_s="$DEFAULT_INTERVAL_S" project=""
	while [ $# -gt 0 ]; do
		case "$1" in
		--help | -h)
			usage
			exit 0
			;;
		--timeout)
			if [ $# -lt 2 ] || ! is_count "$2"; then usage_error "--timeout needs a positive number of seconds"; fi
			timeout_s="$2"
			shift 2
			;;
		--interval)
			if [ $# -lt 2 ] || ! is_count "$2"; then usage_error "--interval needs a positive number of seconds"; fi
			interval_s="$2"
			shift 2
			;;
		-*) usage_error "unknown option: $1" ;;
		*)
			[ -z "$project" ] || usage_error "only one project name, got '$project' and '$1'"
			project="$1"
			shift
			;;
		esac
	done
	[ -n "$project" ] || usage_error "the project name is missing"
	check_slack

	local deadline_s started previous="" current line
	deadline_s=$(scaled "$timeout_s")
	started=$(date +%s)
	say "waiting up to ${deadline_s}s for project $project"
	while :; do
		current=$(states "$project")
		while IFS= read -r line; do
			[ -n "$line" ] || continue
			if ! printf '%s\n' "$previous" | grep -Fqx -- "$line"; then
				say "${line%%=*} ${line#*=}"
			fi
		done <<EOF
$current
EOF
		previous="$current"

		if printf '%s\n' "$current" | grep -q '=failed('; then
			say "a one-shot service failed; see 'docker compose -p $project logs'" >&2
			exit "$EXIT_FAILED"
		fi
		if all_ready "$current"; then
			say "project $project is ready after $(($(date +%s) - started))s"
			exit 0
		fi
		if [ $(($(date +%s) - started)) -ge "$deadline_s" ]; then
			say "project $project was not ready after ${deadline_s}s" >&2
			exit "$EXIT_TIMEOUT"
		fi
		sleep "$interval_s"
	done
}

main "$@"

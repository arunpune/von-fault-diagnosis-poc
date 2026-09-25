#!/bin/sh
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Toolchain check (docs/development.md). One line per tool with the
# version found. Exits 1 when a required tool is missing or below its floor;
# golangci-lint, Docker and shellcheck are reported as WARN, because only the
# Go linter and the integration tests need them.
#
# It never reads or prints an environment variable value.

set -u

status=0

report() { # report LEVEL TOOL FOUND REQUIREMENT
	printf '%-5s %-14s %-24s %s\n' "$1" "$2" "$3" "$4"
}

# Numeric compare of two dotted versions; true when $1 >= $2.
version_ge() {
	_i=1
	while [ "$_i" -le 3 ]; do
		_h=$(printf '%s' "$1" | cut -d. -f"$_i" | tr -cd '0-9')
		_w=$(printf '%s' "$2" | cut -d. -f"$_i" | tr -cd '0-9')
		[ -n "$_h" ] || _h=0
		[ -n "$_w" ] || _w=0
		if [ "$_h" -gt "$_w" ]; then return 0; fi
		if [ "$_h" -lt "$_w" ]; then return 1; fi
		_i=$((_i + 1))
	done
	return 0
}

# True when $1 < $2.
version_lt() {
	if version_ge "$1" "$2"; then return 1; fi
	return 0
}

# check_required TOOL FOUND MIN MAX_EXCLUSIVE ("-" for no upper bound)
check_required() {
	_tool=$1
	_found=$2
	_min=$3
	_max=$4
	if [ "$_max" = "-" ]; then
		_req=">=$_min"
	else
		_req=">=$_min <$_max"
	fi
	if [ -z "$_found" ]; then
		report MISS "$_tool" "not found" "$_req"
		status=1
		return
	fi
	if ! version_ge "$_found" "$_min"; then
		report OLD "$_tool" "$_found" "$_req"
		status=1
		return
	fi
	if [ "$_max" != "-" ] && ! version_lt "$_found" "$_max"; then
		report NEW "$_tool" "$_found" "$_req"
		status=1
		return
	fi
	report OK "$_tool" "$_found" "$_req"
}

# check_optional TOOL FOUND PURPOSE
check_optional() {
	if [ -z "$2" ]; then
		report WARN "$1" "not found" "$3"
		return
	fi
	report OK "$1" "$2" "$3"
}

# found_version COMMAND ARGS... -> the first dotted number of the first output
# line, ignoring a "v" or "go" prefix ("go version go1.27.1 darwin/arm64").
found_version() {
	if ! command -v "$1" >/dev/null 2>&1; then
		printf ''
		return
	fi
	"$@" 2>/dev/null | head -n 1 | tr ' ' '\n' |
		sed -n 's/^\(go\)\{0,1\}v\{0,1\}\([0-9][0-9.]*\).*$/\2/p' | head -n 1
}

echo "Toolchain"
echo

check_required node "$(found_version node --version)" 24.18.0 25
check_required pnpm "$(found_version pnpm --version)" 11.0.0 12
check_required go "$(found_version go version)" 1.27.0 1.28
check_required uv "$(found_version uv --version)" 0.12.12 -
check_required python3 "$(found_version python3 --version)" 3.13.0 3.14
check_required git "$(found_version git --version)" 2.31.0 -
check_required make "$(found_version make --version)" 3.81 -

check_optional golangci-lint "$(found_version golangci-lint --version)" "needed by make lint-go"
check_optional docker "$(found_version docker --version)" "needed by the integration tests and make up"
check_optional shellcheck "$(found_version shellcheck --version)" "needed by the shell lint in CI"

echo
if [ "$status" -eq 0 ]; then
	echo "doctor: every required tool is present."
else
	echo "doctor: install or update the tools marked MISS, OLD or NEW above."
fi
exit "$status"

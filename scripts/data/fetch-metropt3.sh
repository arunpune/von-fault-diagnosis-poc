#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Download MetroPT-3 and verify it against data/SHA256SUMS (ground rule 5:
# the dataset reaches a machine by download only, never through Git).
#
# It downloads $METROPT_URL when that variable is set and the UCI archive
# otherwise, identifies what arrived by its SHA-256 — the zip line or the CSV
# line of data/SHA256SUMS — extracts the CSV member when it was the zip, and
# verifies the CSV before leaving it in data/metropt3/. Anything that matches
# neither line is deleted and the script exits non-zero: an unverified 218 MB
# file must never look like the dataset.
#
# Callers: humans through `make fetch-dataset` and CI's dataset-cache step on
# a cache miss. The init container keeps its own downloader; this one is for
# the host side, where `make fixtures` cuts the slices from what it leaves
# behind.
#
# Usage: scripts/data/fetch-metropt3.sh [--force] [--help]
#
# Exit codes: 0 verified, 1 download or verification failed, 2 usage error.
#
# It prints progress but never the value of an environment variable: curl runs
# with the progress bar on and its own messages off (-s without -S), so a URL
# from the environment cannot reach the log through a curl error either.

set -euo pipefail

CSV_NAME='MetroPT3(AirCompressor).csv'
ZIP_NAME='metropt+3+dataset.zip'
FALLBACK_URL='https://archive.ics.uci.edu/static/public/791/metropt+3+dataset.zip'

EXIT_FAILURE=1
EXIT_USAGE=2

say() {
	printf '%s\n' "fetch-metropt3: $*"
}

fail() {
	say "$*" >&2
	exit "$EXIT_FAILURE"
}

usage() {
	cat <<'USAGE'
Usage: scripts/data/fetch-metropt3.sh [--force] [--help]

Downloads MetroPT-3 into data/metropt3/ and verifies it against
data/SHA256SUMS. Set METROPT_URL to use a mirror instead of the UCI archive.

  --force   download again even when a verified CSV is already there
  --help    print this text and exit 0
USAGE
}

require_tool() {
	command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed, but this script needs it"
}

# The hash of one bare file name in data/SHA256SUMS, or nothing when the name
# is not listed. The format is `<sha256><two spaces><name>`, and a name may
# contain parentheses and plus signs, so it is compared literally.
expected_hash() {
	awk -v want="$1" '
		{
			separator = index($0, "  ")
			if (separator > 0 && substr($0, separator + 2) == want) {
				print substr($0, 1, separator - 1)
				exit
			}
		}
	' "$SUMS_FILE"
}

force=no
while [ "$#" -gt 0 ]; do
	case "$1" in
	--force)
		force=yes
		shift
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		usage >&2
		exit "$EXIT_USAGE"
		;;
	esac
done

require_tool curl
require_tool unzip
require_tool awk

if command -v sha256sum >/dev/null 2>&1; then
	sha256_of() { sha256sum -- "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256_of() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
else
	fail "neither sha256sum nor shasum is installed"
fi

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
DATA_DIR="$ROOT/data/metropt3"
SUMS_FILE="$ROOT/data/SHA256SUMS"
CSV_PATH="$DATA_DIR/$CSV_NAME"
DOWNLOAD="$DATA_DIR/.download.part"

[ -f "$SUMS_FILE" ] || fail "data/SHA256SUMS is missing; it holds the hashes this script verifies against"

csv_sha=$(expected_hash "$CSV_NAME")
zip_sha=$(expected_hash "$ZIP_NAME")
[ -n "$csv_sha" ] || fail "data/SHA256SUMS has no line for $CSV_NAME"
[ -n "$zip_sha" ] || fail "data/SHA256SUMS has no line for $ZIP_NAME"

if [ -f "$CSV_PATH" ] && [ "$force" = no ]; then
	if [ "$(sha256_of "$CSV_PATH")" = "$csv_sha" ]; then
		say "data/metropt3/$CSV_NAME is already there and verifies; nothing to do"
		exit 0
	fi
	say "data/metropt3/$CSV_NAME does not match data/SHA256SUMS; downloading it again"
fi

if [ -n "${METROPT_URL:-}" ]; then
	url=$METROPT_URL
	origin='METROPT_URL'
else
	url=$FALLBACK_URL
	origin='the UCI archive'
fi

mkdir -p "$DATA_DIR"
rm -f "$DOWNLOAD"
say "downloading about 218 MB from $origin into data/metropt3"

status=0
curl --fail --location --silent --progress-bar --retry 3 --retry-delay 2 \
	--output "$DOWNLOAD" "$url" || status=$?
if [ "$status" -ne 0 ]; then
	rm -f "$DOWNLOAD"
	fail "the download failed (curl exit $status); check METROPT_URL, the mirror and the network"
fi

downloaded_sha=$(sha256_of "$DOWNLOAD")
case "$downloaded_sha" in
"$zip_sha")
	say "the download matches the $ZIP_NAME line; extracting $CSV_NAME"
	unzip -o -j -q "$DOWNLOAD" "$CSV_NAME" -d "$DATA_DIR"
	rm -f "$DOWNLOAD"
	;;
"$csv_sha")
	say "the download matches the $CSV_NAME line"
	mv -f "$DOWNLOAD" "$CSV_PATH"
	;;
*)
	rm -f "$DOWNLOAD"
	fail "the download ($downloaded_sha) matches neither the CSV nor the zip line of data/SHA256SUMS"
	;;
esac

[ -f "$CSV_PATH" ] || fail "$CSV_NAME is not in data/metropt3 after the download"
csv_actual=$(sha256_of "$CSV_PATH")
if [ "$csv_actual" != "$csv_sha" ]; then
	rm -f "$CSV_PATH"
	fail "$CSV_NAME hashes to $csv_actual, but data/SHA256SUMS says $csv_sha"
fi

say "verified data/metropt3/$CSV_NAME; run 'make fixtures' to cut the slices"

#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Regenerates infra/mosquitto/passwd — the hashed form of the committed
# passwd.txt defaults.
#
# The broker image does not need this file: its entrypoint renders one at every
# start. It exists for the testcontainers helpers of the backend, the simulator
# and init, which copy mosquitto.conf, acl and passwd into a stock
# eclipse-mosquitto container instead of building the image.
#
# Hashing happens inside the pinned image, so the PBKDF2-SHA512 parameters come
# from the broker that will read the file and no mosquitto_passwd has to be
# installed on the host. Salts are random, so run this only when passwd.txt
# changes — an unnecessary run produces a diff with no meaning.
#
# Usage: scripts/ops/mosquitto-passwd.sh   (or `make mosquitto-passwd`)

set -euo pipefail

MQTT_IMAGE="${MQTT_IMAGE:-eclipse-mosquitto:2.0.22}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source_file="$repo_root/infra/mosquitto/passwd.txt"
target_file="$repo_root/infra/mosquitto/passwd"

if [ ! -f "$source_file" ]; then
	echo "mosquitto-passwd: $source_file is missing" >&2
	exit 1
fi

# mosquitto_passwd -U rewrites the file in place and treats every line as a
# record — a comment line would be hashed into a credential — so passwd.txt and
# passwd carry no SPDX header and are annotated in REUSE.toml instead.
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
cp "$source_file" "$work_dir/passwd"
chmod 0600 "$work_dir/passwd"

docker run --rm -v "$work_dir:/w" "$MQTT_IMAGE" sh -c 'mosquitto_passwd -U /w/passwd'

cp "$work_dir/passwd" "$target_file"
chmod 0644 "$target_file"
echo "mosquitto-passwd: wrote $target_file from $source_file with $MQTT_IMAGE"

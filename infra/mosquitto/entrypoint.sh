#!/bin/sh
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Renders /mosquitto/config/passwd at every container start
# (infra/mosquitto/README.md), then hands over to the official entrypoint of
# eclipse-mosquitto:2.0.22.
#
# For every `user:default` line of passwd.txt the password is the environment
# variable MQTT_<USER>_PASSWORD when it is set and non-empty, else the committed
# default; `-` becomes `_` and the name is upper-cased, so `backend-diag` reads
# MQTT_BACKEND_DIAG_PASSWORD. Overriding a password in `.env` therefore needs no
# image rebuild — but the same value must reach the client service, which
# compose.yaml guarantees by passing the same variable to both sides.
#
# Nothing here prints a password: the rendered file is the only place a value
# goes, and mosquitto_passwd takes it as an argument, not on stdout.
#
# This runs as root, before the official entrypoint chowns /mosquitto and the
# broker drops privileges, so the 0600 file it writes is readable by mosquitto.

set -eu

SOURCE=/mosquitto/config/passwd.txt
TARGET=/mosquitto/config/passwd

# Deliberately explicit sets: busybox `tr` ranges differ between images, and a
# silently wrong variable name would fall back to the default password instead
# of failing.
LOWER='abcdefghijklmnopqrstuvwxyz-'
UPPER='ABCDEFGHIJKLMNOPQRSTUVWXYZ_'

rendered=0

# `|| [ -n "$line" ]` keeps a last line without a trailing newline.
while IFS= read -r line || [ -n "$line" ]; do
	case "$line" in
	'' | '#'*) continue ;;
	esac

	user=${line%%:*}
	password=${line#*:}
	if [ -z "$user" ] || [ "$user" = "$line" ]; then
		echo "entrypoint: $SOURCE has a line that is not 'user:password'" >&2
		exit 1
	fi

	variable="MQTT_$(printf '%s' "$user" | tr "$LOWER" "$UPPER")_PASSWORD"
	override=$(printenv "$variable" || true)
	if [ -n "$override" ]; then
		password=$override
	fi

	if [ "$rendered" -eq 0 ]; then
		mosquitto_passwd -c -b "$TARGET" "$user" "$password"
	else
		mosquitto_passwd -b "$TARGET" "$user" "$password"
	fi
	rendered=$((rendered + 1))
done <"$SOURCE"

if [ "$rendered" -eq 0 ]; then
	echo "entrypoint: $SOURCE holds no credential" >&2
	exit 1
fi

chmod 0600 "$TARGET"
chown mosquitto:mosquitto "$TARGET"
echo "entrypoint: rendered $rendered credentials into $TARGET"

exec /docker-entrypoint.sh /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf

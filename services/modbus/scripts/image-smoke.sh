#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The image smoke: the proof that the two images this module ships actually
# run. It builds both targets, starts a broker, the machine and the gateway on
# a scratch Docker network, waits on the two `probe` healthchecks, watches five
# telemetry batches arrive, and then checks what the images are made of —
# non-root, small, and free of any credential.
#
# Usage: services/modbus/scripts/image-smoke.sh [--help]
#        make -C services/modbus docker-smoke
#        make docker-smoke-sim
#
# Everything it creates carries a random suffix — the network, the three
# containers and the three image tags — so several worktrees can run it at the
# same time, and the EXIT trap removes all of it. Nothing is published on a
# host port: the containers talk to each other over the scratch network only.
#
# The broker is this repository's own `mqtt` image when infra/mosquitto is in
# the checkout, so the smoke runs under the real ACL; the sim and the gateway
# then authenticate with the committed default passwords, which
# MQTT_SIM_PASSWORD and MQTT_GATEWAY_PASSWORD override. Without infra/mosquitto
# it falls back to a stock eclipse-mosquitto with a generated anonymous
# configuration, and both credentials are empty.
#
# The telemetry subscription is anonymous, which the ACL allows for `plant/#`;
# `gt/#` is not readable anonymously and this script never asks for it.
#
# Exit codes: 0 every assertion holds, 1 one does not, 2 usage error.

set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)"

# The pinned broker image.
MOSQUITTO_IMAGE=eclipse-mosquitto:2.0.22

# Each image must stay under 25 MB.
MAX_IMAGE_BYTES=$((25 * 1024 * 1024))

# The Compose healthcheck gives the machine a 60 s start period for the index
# pass; the gateway only has to reach the broker and the device.
SIM_PROBE_TIMEOUT_S=60
GATEWAY_PROBE_TIMEOUT_S=60
BROKER_TIMEOUT_S=30

# How much telemetry proves the chain works, and how long to wait for it.
TELEMETRY_MESSAGES=5
TELEMETRY_TIMEOUT_S=20

# The replay speed the smoke runs at: a day of the recording in 24 s.
REPLAY_SPEED=3600

# The unit the register map, the topics and the ACL are written for.
UNIT_ID=cau-7

# compose.ci.yaml hands this literal to the mock decision service. It is not a
# secret, which is exactly what makes it a usable sentinel: if a build context
# ever leaked an environment file into a layer, this is the string that would
# travel with it.
SENTINEL=fdp-ci-mock-key

EXIT_FAILURE=1
EXIT_USAGE=2

say() {
	printf '%s\n' "image-smoke: $*"
}

fail() {
	say "$*" >&2
	exit "$EXIT_FAILURE"
}

usage() {
	cat <<'USAGE'
Usage: services/modbus/scripts/image-smoke.sh [--help]

Builds the sim and gateway targets of services/modbus/Dockerfile, runs them
against a Mosquitto broker on a scratch Docker network, and asserts that both
probes report healthy, that five telemetry batches reach the broker, that both
images run as non-root, stay under 25 MB and carry no credential.

  --help   print this text and exit 0

Environment:
  MQTT_SIM_PASSWORD       password of the `sim` credential (default: sim)
  MQTT_GATEWAY_PASSWORD   password of the `gateway` credential (default: gateway)
USAGE
}

case "${1-}" in
--help | -h)
	usage
	exit 0
	;;
'') ;;
*)
	say "unknown argument: $1" >&2
	usage >&2
	exit "$EXIT_USAGE"
	;;
esac

command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"
docker info >/dev/null 2>&1 || fail "no Docker daemon is reachable"

SUFFIX="$$-${RANDOM}"
NETWORK="fdp-smoke-net-$SUFFIX"
BROKER_NAME="fdp-smoke-mqtt-$SUFFIX"
SIM_NAME="fdp-smoke-sim-$SUFFIX"
GATEWAY_NAME="fdp-smoke-gateway-$SUFFIX"
SIM_IMAGE="fdp-smoke-sim:$SUFFIX"
GATEWAY_IMAGE="fdp-smoke-gateway:$SUFFIX"
BROKER_IMAGE="fdp-smoke-mqtt:$SUFFIX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fdp-image-smoke.XXXXXX")" ||
	fail "cannot create a temporary directory"

# Print what the containers said before they are removed; a probe that never
# turns healthy is otherwise invisible.
dump_logs() {
	for name in "$BROKER_NAME" "$SIM_NAME" "$GATEWAY_NAME"; do
		if docker container inspect "$name" >/dev/null 2>&1; then
			say "--- last log lines of $name"
			docker logs --tail 40 "$name" 2>&1 | sed 's/^/    /' || true
		fi
	done
}

cleanup() {
	status=$?
	if [ "$status" -ne 0 ]; then
		dump_logs
	fi
	docker rm -f "$GATEWAY_NAME" "$SIM_NAME" "$BROKER_NAME" >/dev/null 2>&1 || true
	docker network rm "$NETWORK" >/dev/null 2>&1 || true
	docker image rm -f "$SIM_IMAGE" "$GATEWAY_IMAGE" "$BROKER_IMAGE" >/dev/null 2>&1 || true
	rm -rf "$WORK"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Poll a command until it succeeds, giving up at a deadline. The container the
# command talks to must stay up: a binary that exited is a failure now, not in
# a minute (`$1` is the container, `$2` the label, `$3` the budget in seconds).
wait_for() {
	local container="$1" label="$2" timeout="$3"
	shift 3
	local deadline
	deadline=$(($(date +%s) + timeout))
	while :; do
		if "$@" >/dev/null 2>&1; then
			return 0
		fi
		if [ "$(docker container inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
			fail "$label exited before it became ready"
		fi
		if [ "$(date +%s)" -ge "$deadline" ]; then
			fail "$label was not ready within ${timeout}s"
		fi
		sleep 1
	done
}

say "building the two images from $ROOT"
docker build --quiet --file "$ROOT/services/modbus/Dockerfile" --target sim \
	--tag "$SIM_IMAGE" "$ROOT" >/dev/null
docker build --quiet --file "$ROOT/services/modbus/Dockerfile" --target gateway \
	--tag "$GATEWAY_IMAGE" "$ROOT" >/dev/null

# The cut slice when `make fixtures` has produced it, else the synthetic
# waveform, which is committed and needs no dataset.
FIXTURE="$ROOT/data/fixtures/metropt3/sim-day-2020-02-01.csv"
if [ ! -f "$FIXTURE" ]; then
	FIXTURE="$ROOT/services/modbus/testdata/synthetic-tiny.csv"
	say "data/fixtures/metropt3/sim-day-2020-02-01.csv is absent (run 'make fixtures');"
	say "replaying the committed synthetic waveform instead"
fi
[ -f "$FIXTURE" ] || fail "no replay source: $FIXTURE does not exist"

say "creating the network $NETWORK"
docker network create "$NETWORK" >/dev/null

# The broker. With infra/mosquitto the smoke runs under the real ACL and the
# real credentials; without it, an anonymous listener and empty passwords.
SIM_PASSWORD="${MQTT_SIM_PASSWORD-}"
GATEWAY_PASSWORD="${MQTT_GATEWAY_PASSWORD-}"
if [ -f "$ROOT/infra/mosquitto/Dockerfile" ] && [ -f "$ROOT/infra/mosquitto/mosquitto.conf" ]; then
	say "building the broker image from infra/mosquitto"
	docker build --quiet --file "$ROOT/infra/mosquitto/Dockerfile" \
		--tag "$BROKER_IMAGE" "$ROOT" >/dev/null
	SIM_PASSWORD="${SIM_PASSWORD:-sim}"
	GATEWAY_PASSWORD="${GATEWAY_PASSWORD:-gateway}"
	docker run --detach --name "$BROKER_NAME" --network "$NETWORK" \
		--env "MQTT_SIM_PASSWORD=$SIM_PASSWORD" \
		--env "MQTT_GATEWAY_PASSWORD=$GATEWAY_PASSWORD" \
		"$BROKER_IMAGE" >/dev/null
else
	say "infra/mosquitto is absent; running an anonymous $MOSQUITTO_IMAGE"
	cat >"$WORK/mosquitto.conf" <<'CONF'
listener 1883 0.0.0.0
protocol mqtt
allow_anonymous true
persistence false
log_dest stdout
CONF
	docker run --detach --name "$BROKER_NAME" --network "$NETWORK" \
		--volume "$WORK/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
		"$MOSQUITTO_IMAGE" >/dev/null
fi

# $SYS is a broker topic, not a shell variable, hence the single quotes.
# shellcheck disable=SC2016
wait_for "$BROKER_NAME" "the broker" "$BROKER_TIMEOUT_S" \
	docker exec "$BROKER_NAME" mosquitto_sub -h 127.0.0.1 \
	-t '$SYS/broker/uptime' -C 1 -W 3 -i "smoke-$SUFFIX"
say "the broker answers on \$SYS/broker/uptime"

say "starting the machine over $(basename "$FIXTURE") at ${REPLAY_SPEED}x"
docker run --detach --name "$SIM_NAME" --network "$NETWORK" \
	--volume "$FIXTURE:/data/fixture.csv:ro" \
	--env METROPT_CSV=/data/fixture.csv \
	--env SIM_AUTOPLAY=true \
	--env SIM_LOOP=true \
	--env "REPLAY_SPEED=$REPLAY_SPEED" \
	--env GT_DIR=/gt \
	--env "MQTT_URL=mqtt://$BROKER_NAME:1883" \
	--env "MQTT_SIM_PASSWORD=$SIM_PASSWORD" \
	--env "UNIT_ID=$UNIT_ID" \
	"$SIM_IMAGE" run >/dev/null

wait_for "$SIM_NAME" "the machine's probe" "$SIM_PROBE_TIMEOUT_S" \
	docker exec "$SIM_NAME" /modbus-sim probe
say "the machine reports healthy"

say "starting the gateway against $SIM_NAME:5020"
docker run --detach --name "$GATEWAY_NAME" --network "$NETWORK" \
	--env "MODBUS_ADDR=$SIM_NAME:5020" \
	--env "MQTT_URL=mqtt://$BROKER_NAME:1883" \
	--env "MQTT_GATEWAY_PASSWORD=$GATEWAY_PASSWORD" \
	--env "UNIT_ID=$UNIT_ID" \
	"$GATEWAY_IMAGE" run >/dev/null

wait_for "$GATEWAY_NAME" "the gateway's probe" "$GATEWAY_PROBE_TIMEOUT_S" \
	docker exec "$GATEWAY_NAME" /gateway probe
say "the gateway reports healthy"

TELEMETRY_TOPIC="plant/$UNIT_ID/telemetry/samples"
say "waiting for $TELEMETRY_MESSAGES messages on $TELEMETRY_TOPIC"
status=0
docker run --rm --network "$NETWORK" "$MOSQUITTO_IMAGE" \
	mosquitto_sub -h "$BROKER_NAME" -p 1883 -t "$TELEMETRY_TOPIC" \
	-C "$TELEMETRY_MESSAGES" -W "$TELEMETRY_TIMEOUT_S" -i "smoke-sub-$SUFFIX" \
	>"$WORK/telemetry.jsonl" || status=$?

received=$(grep -c '"seq"' "$WORK/telemetry.jsonl" || true)
if [ "$status" -ne 0 ] || [ "$received" -ne "$TELEMETRY_MESSAGES" ]; then
	fail "expected $TELEMETRY_MESSAGES telemetry messages carrying \"seq\" within ${TELEMETRY_TIMEOUT_S}s, got $received (mosquitto_sub exit $status)"
fi
say "observed $received telemetry batches"

# What the images are made of. `docker export` flattens the filesystem into one
# uncompressed tar whatever image store the daemon uses, so the listing and the
# string scan below see the real layers; `docker save` adds the image's own
# metadata, where a build argument would show up.
assert_image_is_sound() {
	local image="$1" label="$2" size user container

	size=$(docker image inspect --format '{{.Size}}' "$image")
	if [ "$size" -gt "$MAX_IMAGE_BYTES" ]; then
		fail "the $label image is $size bytes, over the $MAX_IMAGE_BYTES byte ceiling"
	fi

	user=$(docker image inspect --format '{{.Config.User}}' "$image")
	[ "$user" = "nonroot" ] || fail "the $label image runs as '$user', not nonroot"

	container=$(docker create "$image")
	docker export "$container" >"$WORK/$label-fs.tar"
	docker rm -f "$container" >/dev/null
	docker save "$image" -o "$WORK/$label-image.tar"
	tar -tf "$WORK/$label-fs.tar" >"$WORK/$label-fs.list"
	tar -tf "$WORK/$label-image.tar" >"$WORK/$label-image.list"

	grep -q 'nonroot:x:65532:65532' "$WORK/$label-fs.tar" ||
		fail "the $label image has no nonroot (65532) account in /etc/passwd"

	if grep -Eq '(^|/)\.env' "$WORK/$label-fs.list" "$WORK/$label-image.list"; then
		fail "the $label image carries an environment file"
	fi
	if grep -aq "$SENTINEL" "$WORK/$label-fs.tar" "$WORK/$label-image.tar"; then
		fail "the $label image carries the $SENTINEL sentinel"
	fi

	say "the $label image is $size bytes, runs as nonroot (65532) and carries no credential"
}

assert_image_is_sound "$SIM_IMAGE" sim
assert_image_is_sound "$GATEWAY_IMAGE" gateway

say "green: both probes healthy, $received telemetry batches, both images clean"

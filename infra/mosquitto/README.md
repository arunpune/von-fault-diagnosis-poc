<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# The `mqtt` service

The broker every service talks through: telemetry, status, suspect events, decisions, alerts and
simulator control on `plant/cau-7/…`, ground truth on `gt/cau-7/…`. It is built from
`Dockerfile` on `eclipse-mosquitto:2.0.22` and configured by the files beside it, listed below;
the image copies all of them but `passwd`, which only the testcontainers helpers read.

| File | Committed | Written by | Read by |
| --- | --- | --- | --- |
| `mosquitto.conf` | yes | hand | the broker, and every testcontainers helper |
| `acl` | yes | `make mosquitto-acl` from `packages/contracts/topics.json` | the broker, and every testcontainers helper |
| `passwd.txt` | yes | hand | `entrypoint.sh` inside the image |
| `passwd` | yes | `make mosquitto-passwd` from `passwd.txt` | testcontainers helpers only |
| `entrypoint.sh` | yes | hand | the image |

The ACL is an isolation boundary, not a security control: authentication is out of scope for the
PoC ([`docs/security.md`](../../docs/security.md)) and every password below is a published default.

## Credentials and environment overrides

`passwd.txt` holds five `user:password` defaults. At every container start `entrypoint.sh` hashes
them into `/mosquitto/config/passwd` with `mosquitto_passwd -b`, taking `MQTT_<USER>_PASSWORD`
instead of the default whenever that variable is set and non-empty (`-` becomes `_`, upper case).
The file is written with mode 0600 owned by `mosquitto`, and no value is ever printed.

| Credential | Environment variable | Default | Rights |
| --- | --- | --- | --- |
| `gateway` | `MQTT_GATEWAY_PASSWORD` | `gateway` | writes telemetry and its own status |
| `sim` | `MQTT_SIM_PASSWORD` | `sim` | reads `control/cmd`; writes `control/ack`, its status and all of `gt/#` |
| `backend-diag` | `MQTT_BACKEND_DIAG_PASSWORD` | `backend-diag` | reads telemetry and status; writes events, decisions, alerts and its status |
| `backend-ops` | `MQTT_BACKEND_OPS_PASSWORD` | `backend-ops` | reads `control/ack` and `gt/#`; writes `control/cmd` |
| `eval` | `MQTT_EVAL_PASSWORD` | `eval` | reads `plant/#`, `gt/#` and `$SYS/#`; writes nothing |

Overriding a password needs no image rebuild, but the same value has to reach the client: the
compose file passes each `${MQTT_*_PASSWORD}` to both sides. Adding or renaming a credential is
three edits — `packages/contracts/topics.json`, `make mosquitto-acl`, `passwd.txt` — followed by
`make mosquitto-passwd`; `scripts/ops/acl.test.ts` fails until all four files agree.

`eval` is read-only on purpose. It is the positive control of every non-delivery assertion in the
repository and the credential the evaluation harness, the simulator's stack gate test and manual debugging use;
it must never gain a write filter.

## ACL semantics, as measured on 2.0.22

Verified by `scripts/ops/mosquitto.integration.test.ts`, which is the reference every other
isolation test in the repository follows. Mosquitto's ACL file does not behave the way a first
reading suggests:

1. **The general block applies to anonymous clients only.** The `topic` lines before the first
   `user` line are not a default for everybody: an authenticated client gets exactly its own
   `user` block. `backend-diag` therefore cannot read `plant/cau-7/control/cmd`, which its own
   block does not list, whatever the general block grants; and since the general block grants no
   control topic, an anonymous client cannot read it either.
2. **A denied subscribe is granted, then never delivered.** The file is checked at delivery time,
   so `SUBSCRIBE` to a forbidden filter returns `SUBACK` reason **0** on MQTT 3.1.1 and on MQTT 5.
   Isolation is proven by non-delivery: publish a retained message as an allowed credential,
   subscribe as the denied one, expect nothing within 2 s, and assert the positive control in the
   same test. Never assert `SUBACK` 0x80.
3. **A denied publish is refused.** On MQTT 5 the `PUBACK` carries reason **135** (`0x87`, not
   authorized) and the broker logs `Denied PUBLISH`; on MQTT 3.1.1 the message is dropped silently
   with a normal `PUBACK`, so a test that asserts publish denial must connect with
   `protocolVersion: 5`.
4. **A wrong password is refused at CONNECT**, with reason **135** on MQTT 5.
5. **Anonymous clients read the plant topics and `$SYS/#` and write nothing.**
   `mosquitto_sub -h localhost -p 1883 -t 'plant/#' -v` works with no credentials; `gt/#` and
   `control/#` do not, so diagnosis code that connects without credentials cannot reach
   ground truth.
6. **World-readable credential files are deprecated.** 2.0.22 warns that they "will be refused by
   future versions", so the image copies `acl` and `passwd.txt` with mode 0600 owned by
   `mosquitto`, the entrypoint writes `passwd` the same way, and consumers must copy them with
   mode 0600 too.

`passwd.txt` and `passwd` carry no SPDX header: `mosquitto_passwd -U` and the broker's own loader
treat every line as a record, so a comment would become a credential named
`# SPDX-FileCopyrightText`. They are annotated in the repository's `REUSE.toml` instead.

## Healthcheck

```text
mosquitto_sub -h 127.0.0.1 -t '$SYS/broker/uptime' -C 1 -W 3 -i hc
```

`$SYS` topics are retained, so the subscription returns within milliseconds and the container is
healthy about five seconds after `docker run`. The general ACL block grants `$SYS/#` to anonymous
clients, which is what lets the healthcheck run without a credential.

## Using the files from testcontainers

The backend (`apps/backend/test/helpers/containers.ts`), the simulator
(`services/modbus/internal/testutil/mosquitto.go`) and init (`tools/init/tests/conftest.py`)
start a stock `eclipse-mosquitto:2.0.22` rather than building this image. They copy three files
into `/mosquitto/config/` and use the defaults of `passwd.txt`:

| Source | Target | Mode |
| --- | --- | --- |
| `infra/mosquitto/mosquitto.conf` | `/mosquitto/config/mosquitto.conf` | 0644 |
| `infra/mosquitto/acl` | `/mosquitto/config/acl` | 0600 |
| `infra/mosquitto/passwd` | `/mosquitto/config/passwd` | 0600 |

The hashed `passwd` exists for exactly this: the stock image has no entrypoint that would render
one. The stock image also has no healthcheck and `mosquitto.conf` logs only error, warning and
notice, so there is no startup line to wait for — wait for the healthcheck command to succeed
instead of for a log message, as the last `describe` block of
`scripts/ops/mosquitto.integration.test.ts` does. Salts are random, so regenerate `passwd` only
when `passwd.txt` changes.

Building this image from a test needs BuildKit (`GenericContainerBuilder.withBuildkit()` in
testcontainers for Node): `COPY --chmod` is a BuildKit instruction and the legacy builder refuses
it.

## Upgrading to the 2.1 line

The PoC stays on the 2.0 line. Moving to `eclipse-mosquitto:2.1.2-alpine`
is a tag change in `Dockerfile` (through `ARG MQTT_IMAGE`), in `BASE_IMAGE` of the integration
test and in the testcontainers helpers, plus a smoke run: 2.1 changes the persistence rules —
harmless here, because `persistence false` and every retained message is republished on connect —
and is expected to refuse world-readable credential files outright, which the 0600 modes already
satisfy. The CI workflow keeps an optional, manually triggered job for the upgrade: run it with
the `mosquitto_next` input to smoke-test the stack on 2.1.

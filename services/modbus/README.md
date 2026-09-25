<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# `services/modbus` — the CAU-7 emulator and its MQTT gateway

One Go module, `fault-diagnosis-poc/services/modbus`, that ships two binaries:

| Binary | Role |
| --- | --- |
| `modbus-sim` | The machine. A read-only Modbus TCP device (FC03 only) that replays MetroPT-3 rows into a ring buffer at a chosen speed, evaluates the CTRL-7 controller messages, applies fault-injection overlays and publishes its ground truth under `gt/#`. |
| `gateway` | The edge connector. It polls the device, decodes slots with the generated register map, stamps every sample with simulated time and publishes schema-valid telemetry batches. It computes nothing and knows nothing about fault injection. |

How the device, the replay clock, the gateway, the presets and the fault
injections behave is in [`docs/simulation.md`](../../docs/simulation.md); where
the two binaries sit in the stack is in
[`docs/architecture.md`](../../docs/architecture.md).

## What is here

Both binaries run: `modbus-sim` replays, serves and takes its commands on
`plant/<unit>/control/cmd`, `gateway` polls and publishes. The control plane is
the only publisher of `gt/#`, and the broker is not optional for it: `run` fails
fast when `MQTT_URL` answers nothing for a minute, and `/healthz` reports
`mqtt_connected=false` — a 503, so `probe` fails too — until the session is up.
A healthy machine in the image smoke or under Compose therefore proves the
broker session, not only the CSV index and the register listener.

```text
internal/regmap/     layout.go (addresses) · register_map_gen.go (generated table)
                     codec.go (header and slot encode/decode, scaling, alarm bits)
internal/replay/     the CSV parser, the time index and the cursor
internal/injection/  the fault-overlay primitives, envelopes and catalog
internal/ctrl7/      the alarm evaluator and its derived quantities
internal/machine/    the loaded/unloaded/off rule of docs/dataset.md
internal/sim/        the engine, the clock, the register store, the Modbus server and /healthz
internal/gateway/    the poller, the ring reader, the publisher, the heartbeat and /healthz
internal/mqttio/     the MQTT 5 client · envelope helpers · topic builders
internal/contracts/  the message shapes and the schema validator both binaries share
internal/arch/       the import-boundary, write-call and no-leak scans, and the
                     pinned-library assertion
internal/schematest/ test-only: validates a message against packages/contracts/schemas/v1
internal/testutil/   FakeClock, fixture paths, the synthetic CSV generator, the slice
                     resolver, the embedded broker and the Mosquitto container
testdata/            synthetic-tiny.csv and the gt/ fixtures (CC BY 4.0)
scripts/             image-smoke.sh, the proof that both images run
Dockerfile           one build stage, two distroless runtime stages
```

## The register model in one paragraph

Holding registers only, unit id 1, big-endian words, multi-word values high
word first. Addresses 0–13 are the header (`head_seq`, `sim_ts_now`,
`replay_state`, `replay_speed`, the ring geometry and the map version) inside a
reserved block that runs to 31. Addresses 1024–9215 are 256 slots of 32
registers; the slot for sample `seq` starts at `1024 + (seq mod 256) × 32` and
holds the sequence number, the simulated timestamp, the discontinuity and
missing flags, seven analog signals as scaled `int16`, eight digital signals as
`0`/`1`, the synthetic ambient temperature and a 32-bit alarm field. The
simulator writes a slot and then `head_seq` under one lock and never blocks on
a reader; a reader that lags by 256 samples sees a slot whose `seq` is not the
one it expected, which is how loss is detected.

`internal/regmap/register_map_gen.go` is **generated**, by
`@fdp/contracts generate` from `manual/spec/signals.yaml`, `alarms.yaml` and
`settings.yaml`; `pnpm --filter @fdp/contracts check-drift` fails when the
checked-in file and the specs disagree, so the tag ids, the alarm bits and the
thresholds come from the manual's sources, not from this module. No simulator
code hard-codes a tag: the replay maps CSV columns through `Signal.Column`, the
codec places values through `Signal.Offset` and the gateway emits
`values[Signal.Tag]`.

## The MQTT wrapper in one paragraph

`internal/mqttio` is the only place either binary talks to the broker. It wraps
[`github.com/eclipse/paho.golang`](https://github.com/eclipse-paho/paho.golang)
(`autopaho` + `paho`, MQTT 5) — dual-licensed EPL-2.0 **OR** EDL-1.0, and **this
project elects the EDL-1.0 (BSD-3-Clause) half**, the election `NOTICE` states.
MQTT 5 is the point: a publish the broker's ACL refuses comes back as a PUBACK
reason code, which `Publish` and `Subscribe` return as a
`*ReasonError{Code, Op, Topic}` so the isolation tests can assert the boundary.
A refused *subscribe* is different — Mosquitto grants it and then never delivers
([`infra/mosquitto`](../../infra/mosquitto/README.md)) — so those tests assert
non-delivery against a positive control instead. Every filter passed to
`Subscribe` is remembered and re-sent when the connection comes back, received
messages are dispatched from an unbounded in-order queue so a slow handler never
stalls the network loop, and no credential ever reaches a log line: the password
is never logged and any userinfo is stripped from the broker URL before it is
dialled.

`envelope.go` builds the message envelope of
[`@fdp/contracts`](../../packages/contracts/README.md) (`SchemaID`, `WallTS`,
`SimTS`, `ParseTS`; `2006-01-02T15:04:05.000Z`, always UTC) and `topics.go`
builds every topic of that table for a unit id; a test compares the builders
with `packages/contracts/topics.json` whenever the generated contracts are in
the checkout.

## Commands

All verbs run from this directory, or from the repository root with
`make -C services/modbus <verb>`.

| Command | What it does |
| --- | --- |
| `make test` | `go test ./...` — the unit tests; green with or without the dataset |
| `make test-race` | the same under the race detector |
| `make test-integration` | `go test -tags integration -race ./...` |
| `make e2e` | the full-stack scenarios alone: sim + gateway + a Mosquitto container |
| `make bench` | the emit path and the register store; see [Performance](#performance) |
| `make vet` | `go vet ./...` |
| `make lint` / `make fmt` | `golangci-lint run` / `golangci-lint fmt`; `lint` falls back to `go vet` when the binary is not installed |
| `make build` | both binaries into `out/` |
| `make docker-smoke` | builds both images and proves they run (`make docker-smoke-sim` from the root) |
| `make fixtures` | delegates to the root target that cuts the MetroPT-3 slices |
| `make tidy` | `go mod tidy` |
| `make clean` | removes `out/` |

`golangci-lint` is installed as a binary, never with `go get`: `brew install
golangci-lint` locally, the official action pinned to v2.13.2 in CI.

## Performance

`make bench` measures the two paths that decide whether the simulator can hold
3600× (one row every 2.8 ms of wall time, ~360 samples/s) with room to spare.
`BenchmarkEmitRow` is one whole turn of the emit loop — the load-state rule,
the ambient extra, the fault overlays, the alarm evaluation, the slot encoding
and the store write — and `BenchmarkStoreRead` is the 96-register, three-slot
window the gateway asks for on every poll.

| Benchmark | ns/op | B/op | allocs/op | Budget |
| --- | --- | --- | --- | --- |
| `BenchmarkEmitRow/idle` | 885 | 0 | 0 | < 20 000 |
| `BenchmarkEmitRow/injected` | 1 046 | 336 | 3 | < 20 000 |
| `BenchmarkStoreRead` | 128 | 192 | 1 | < 1 000 |

Measured with `make bench` (`-benchtime 2s`) on darwin/arm64, Apple M1 Pro, Go
1.27.1. The emit path is twenty times inside its budget and allocates nothing
at all while no overlay is running: the engine reuses the value slices and the
slot it hands the codec, so a sample costs no garbage. An active injection
costs three allocations — the per-instance transform state — which is why the
two cases are reported separately. `BenchmarkStoreRead` runs in parallel,
because that is how the Modbus server calls it; its single allocation is the
copy the reader hands back, which is what keeps the ring lock-free for the
writer.

Both benchmarks run offline on a synthetic waveform and a fake clock, so the
numbers do not depend on the dataset or on a timer.

## Images

One `Dockerfile`, one build stage and two runtime stages. **The build context is
the repository root**, like every image of this project, because the simulator
copies `packages/ground-truth/data/` out of it:

```bash
docker build -f services/modbus/Dockerfile --target sim     -t fdp-modbus-sim .
docker build -f services/modbus/Dockerfile --target gateway -t fdp-modbus-gateway .
```

The build stage is `golang:1.27.1-trixie`; both runtime stages are
`gcr.io/distroless/static-debian13:nonroot`, pinned by digest because `nonroot`
is a floating tag. The binaries are static (`CGO_ENABLED=0`) and stripped
(`-trimpath -ldflags="-s -w"`), which keeps each image just under 10 MB against
the 25 MB ceiling the image smoke enforces. Both run as `nonroot` (uid 65532),
expose 5020 and 8081 (sim) and 8082 (gateway), and their entrypoint is the
binary, whose default subcommand is `run`.

There is **no shell, no package manager and no `curl`** in either image, so the
healthcheck is the binary's own `probe` subcommand: it requests `/healthz` on
the loopback interface and exits 0 only when the service reports healthy.

```bash
docker run --rm --name sim --network fdp \
  -v "$PWD/data/fixtures/metropt3/sim-day-2020-02-01.csv:/data/fixture.csv:ro" \
  -e METROPT_CSV=/data/fixture.csv -e SIM_AUTOPLAY=true -e REPLAY_SPEED=3600 \
  fdp-modbus-sim run
docker exec sim /modbus-sim probe && echo healthy
docker exec gw  /gateway probe    && echo healthy
```

`services/modbus/scripts/image-smoke.sh` is the end-to-end proof, and
`make -C services/modbus docker-smoke` runs it: it builds both targets, starts a
broker, the machine at 3600× over the day slice and the gateway on a scratch
Docker network, waits on both probes, asserts that five telemetry batches carry
a `seq`, and then checks that each image is non-root, under 25 MB and carries
neither an environment file nor a credential. Everything it creates carries a
random suffix and is removed on the way out, so two checkouts can run it at
once. With `infra/mosquitto` in the checkout it builds this repository's broker
image and authenticates as `sim` and `gateway`, which `MQTT_SIM_PASSWORD` and
`MQTT_GATEWAY_PASSWORD` override; without it, an anonymous
`eclipse-mosquitto:2.0.22` and two empty passwords.

### What the root `.dockerignore` must exclude

The daemon reads the whole repository as the context, and a file next to this
`Dockerfile` would not be consulted, so the root `.dockerignore` is the only
exclusion list. This image needs it to keep out `.env` and `.env.*` (secrets
reach a container through its environment only,
[ground rule 7](../../CONTRIBUTING.md#ground-rules)), `.git`, `.claude`,
`**/node_modules`, `**/.venv`, `data/metropt3` and `data/byo-manual` — the
218 MB recording and any
bring-your-own manual must never reach a layer (ground rules 1, 5 and 6). It must
keep `packages/ground-truth/data` **in**, because the `sim` stage copies it to
`/gt` and the build fails without it, which is intended: an image with no
`presets.json` cannot serve a jump target.

### Compose

These are the two blocks `compose.yaml` holds for this module, with the logging
settings left out and the shared MQTT URL written out:

```yaml
modbus-sim:
  build: { context: ., dockerfile: services/modbus/Dockerfile, target: sim }
  environment:
    METROPT_CSV: ${METROPT_CSV:-/data/metropt3/MetroPT3(AirCompressor).csv}
    REPLAY_SPEED: ${REPLAY_SPEED:-600}
    SIM_AUTOPLAY: "false"
    SIM_LOOP: "true"
    MQTT_URL: mqtt://mqtt:1883
    MQTT_SIM_PASSWORD: ${MQTT_SIM_PASSWORD:-sim}
    UNIT_ID: cau-7
    LOG_LEVEL: ${LOG_LEVEL:-info}
  volumes:
    - ./data/metropt3:/data/metropt3:ro
    - ./data/fixtures:/data/fixtures:ro
  ports: ["${MODBUS_PORT:-5020}:5020"]
  healthcheck:
    test: ["CMD", "/modbus-sim", "probe"]
    interval: 5s
    timeout: 3s
    retries: 12
    start_period: 60s # index build over the full CSV on a slow disk
  depends_on:
    init: { condition: service_completed_successfully }
    mqtt: { condition: service_healthy }
  restart: unless-stopped

gateway:
  build: { context: ., dockerfile: services/modbus/Dockerfile, target: gateway }
  environment:
    MODBUS_ADDR: modbus-sim:5020
    POLL_INTERVAL_MS: ${POLL_INTERVAL_MS:-50}
    MQTT_URL: mqtt://mqtt:1883
    MQTT_GATEWAY_PASSWORD: ${MQTT_GATEWAY_PASSWORD:-gateway}
    UNIT_ID: cau-7
    LOG_LEVEL: ${LOG_LEVEL:-info}
  healthcheck:
    test: ["CMD", "/gateway", "probe"]
    interval: 5s
    timeout: 3s
    retries: 12
    start_period: 15s
  depends_on:
    modbus-sim: { condition: service_healthy }
    mqtt: { condition: service_healthy }
  restart: unless-stopped
```

`compose.ci.yaml` overrides `METROPT_CSV=/data/fixtures/metropt3/ci-slice.csv`
and `SIM_AUTOPLAY=true` on `modbus-sim`; the fixture directory is already
mounted by the base file. Every variable not named above keeps the default of
the runtime tables below, which is why the blocks are short.

## Test data

No MetroPT-3 row is committed: the dataset reaches a machine by download only
([ground rule 5](../../CONTRIBUTING.md#ground-rules)).

- **Offline tests** use `internal/testutil.SynthCSV`, which writes the dataset's
  verbatim header and a normal load/unload cycle built from the published
  statistics, with seeded noise and requested gaps. It is a pure function of its
  options, and `testdata/synthetic-tiny.csv` (120 rows, seed 1, a 5 min and a
  1 h hole) is its committed output. After an intentional change to the
  waveform, refresh it with:

  ```bash
  go test ./internal/testutil -run TestSynthCSVFixtureIsReproducible -update
  ```

- **Tests that need real telemetry** ask `internal/testutil.SliceCSV(t, name)`
  for a slice `make fixtures` cut into the gitignored
  `data/fixtures/metropt3/<name>.csv`. Without the slice the test skips with the
  command that produces it; with `FDP_REQUIRE_DATASET=1` — which CI sets after
  its dataset-cache step — the same case fails instead.

- `testdata/gt/presets.json` and `testdata/gt/metropt3-failures.json` are small
  test fixtures with the shapes the simulator forwards on `gt/cau-7/catalog`.
  The files the image ships come from `packages/ground-truth/data`.

## Environment

The binaries read their configuration from the environment; the configuration
sections of [`docs/simulation.md`](../../docs/simulation.md) describe it with the
behaviour it steers, and every user-facing variable is in the repository's
`.env.example` and README table. `modbus-sim`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `METROPT_CSV` | `/data/metropt3/MetroPT3(AirCompressor).csv` | the recording to replay; a cut slice in CI |
| `REPLAY_SPEED` | `600` | initial speed and the value `reset` restores; 1…3600 |
| `MODBUS_BIND` / `MODBUS_PORT` | `0.0.0.0` / `5020` | the listener; Compose publishes `MODBUS_PORT` |
| `SIM_HTTP_PORT` | `8081` | `/healthz` and `/status`, and what `probe` requests |
| `SIM_AUTOPLAY` | `false` | start playing at boot; the image smoke and the eval set `true` |
| `SIM_LOOP` | `true` | wrap at the end of the data |
| `GT_DIR` | `/gt` | `presets.json`, `injections.json` and `metropt3-failures.json`, copied into the image |
| `MQTT_URL` | `mqtt://mqtt:1883` | the broker |
| `MQTT_SIM_PASSWORD` | the PoC default of `.env.example` | the username is always `sim` |
| `UNIT_ID` | `cau-7` | topic segment and envelope field |
| `MODBUS_MAX_CLIENTS` | `5` | concurrent Modbus clients |
| `LOG_LEVEL` | `info` | the `slog` level |

`gateway`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODBUS_ADDR` | `modbus-sim:5020` | the device to poll |
| `MODBUS_TIMEOUT_MS` | `1000` | per request |
| `POLL_INTERVAL_MS` | `50` | idle sleep between two poll cycles |
| `GATEWAY_MAX_BATCH` | `25` | samples per telemetry message (the schema maximum) |
| `GATEWAY_STATUS_INTERVAL_S` | `5` | heartbeat period |
| `GATEWAY_HTTP_PORT` | `8082` | `/healthz`, and what `probe` requests |
| `MQTT_URL`, `MQTT_GATEWAY_PASSWORD`, `UNIT_ID`, `LOG_LEVEL` | as above | the username is always `gateway` |

A password is never logged: the `slog` handler of both binaries replaces any
attribute named `password`, and the MQTT wrapper strips the userinfo from the
broker URL before it dials.

The variables the tests read:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FDP_REQUIRE_DATASET` | unset | `1` turns an absent MetroPT-3 slice from a skip into a failure |
| `FDP_CONTRACTS_DIR` | `../../../../packages/contracts` (from the package) | where the generated contracts live, for the register-map and topic comparison tests |
| `FDP_SCHEMAS_DIR` | `../../../../packages/contracts/schemas/v1` (from the package) | where `internal/schematest` loads the JSON Schemas from |
| `FDP_REQUIRE_SCHEMAS` | unset | `1` turns absent generated contracts from a skip into a failure |
| `FDP_MOSQUITTO_DIR` | `../../../../infra/mosquitto` (from the package) | the broker configuration the Mosquitto container mounts; without it the container runs a generated anonymous config and the ACL assertions are skipped |
| `FDP_TIMING_SLACK` | `1` | multiplies every wall-clock bound in the tests; CI sets `3` |
| `MQTT_<USER>_PASSWORD` | the committed default in `infra/mosquitto/passwd.txt` | the password the integration tests use for a broker credential; `-` becomes `_`, so `backend-diag` reads `MQTT_BACKEND_DIAG_PASSWORD` |

Every relative default above is resolved from the package directory, which
`go test` makes the working directory: each `internal/<pkg>` sits four levels
below the repository root.

The tests behind the `integration` build tag need a Docker daemon; without one
they skip with a message. `make test-integration` pulls
`eclipse-mosquitto:2.0.22` on a random host port, under a container name that
carries a random suffix so parallel runs never collide.

## Troubleshooting

**The simulator takes a while to answer after it starts.** `run` indexes the
whole recording before it serves anything: it reads every line once and keeps
one index entry every few hundred rows, so a `Seek` never rescans the file.
Over the full MetroPT-3 CSV that is 1 516 948 rows and 331 gaps, about 0.6 s on
a warm SSD and several seconds on a cold or networked volume — which is what
the `start_period: 60s` of the Compose healthcheck buys. Ask for the numbers
without starting a server:

```bash
go run ./cmd/modbus-sim index --csv "../../data/metropt3/MetroPT3(AirCompressor).csv"
```

A CI run or a demo that does not need seven months of data should point
`METROPT_CSV` at a cut slice (`make fixtures`) instead; `ci-slice.csv` indexes
in milliseconds.

**`bind: address already in use`.** Only `MODBUS_PORT` is published to the host
(5020 by default), so that is the one that collides — with a second stack in
another checkout, or with a leftover container. `MODBUS_PORT=5021 docker compose
up` moves it; `SIM_HTTP_PORT` and `GATEWAY_HTTP_PORT` stay inside the network
and only matter when a binary is run directly. The tests never take a fixed
port: they bind `127.0.0.1:0` and read the port back, and the Mosquitto
container gets a mapped one, so parallel runs do not collide.

**`the broker at mqtt://… did not answer within 1m0s`.** Both binaries need the
broker at startup and neither degrades without it: the simulator is the only
publisher of `gt/#` and the gateway has nowhere to put a sample. The client
retries with backoff for a minute and then gives up, so a refused credential
looks exactly like an absent broker from the outside — the difference is in the
`mqtt connection attempt failed` warnings it logs on the way. Three causes,
in the order worth checking: the broker is not up yet (`docker compose ps
mqtt`, whose healthcheck both services wait on), the URL is wrong (`MQTT_URL`,
`mqtt://` and port 1883 inside the network), or the credential was refused. The
usernames are fixed — `sim` and `gateway` — and only `MQTT_SIM_PASSWORD` and
`MQTT_GATEWAY_PASSWORD` are yours to set; they must match
`infra/mosquitto/passwd.txt`, and the PoC defaults are in `.env.example`. While
the attempt runs, `/healthz` answers 503 with `mqtt_connected=false`, so
`probe` fails and Compose reports the service unhealthy instead of hiding a
broker problem behind a running container.

**A test that needs a slice skips.** `make fixtures` cuts them from the full
recording into the gitignored `data/fixtures/metropt3/`. Set
`FDP_REQUIRE_DATASET=1` to turn those skips into failures when you expect the
slices to be there.

## Boundaries

[Ground rule 3](../../CONTRIBUTING.md#ground-rules) keeps the gateway away from
ground truth, and `internal/arch` is where that is proved. Four checks, from the
coarsest to the bluntest:

| Check | What it proves |
| --- | --- |
| `imports_test.go` | `go list -deps ./cmd/gateway` reaches none of `internal/sim`, `internal/injection`, `internal/replay`, `internal/ctrl7`, `internal/machine`; `./cmd/modbus-sim` does not reach `internal/gateway`; neither binary reaches `internal/testutil` or `internal/schematest`. The closure is transitive, so a violation hidden behind an intermediate package is caught too. |
| `isolation_test.go` — go/ast scan | no file under `internal/gateway` or `cmd/gateway`, tests included, calls `WriteRegister`, `WriteRegisters`, `WriteCoil`, `WriteCoils` or `WriteMultipleRegisters`. The connector holds a read-only client, and the import graph cannot see this because the write lives in the same library as the read it needs. |
| `isolation_test.go` — substring scan | nothing the connector *ships* mentions `gt/`, `inject` or `GT_DIR`, and the files of the whole module that name a `gt/` topic are exactly the eight the test lists. A leak that arrived as a string constant, a comment or a golden payload is caught here. Test files are exempt, because a no-leak test has to name what it forbids. |
| `.golangci.yml` | `depguard` mirrors the import edges per file and `forbidigo` the write calls, both for editor-speed feedback in the gateway only. Lint is the mirror; the tests are what CI trusts. |

Each scan has a positive control: `testdata/violating/` is a self-contained
gateway that breaks every one of these rules, and a test asserts that each
check finds exactly the violation planted there. Run them alone with
`go test ./internal/arch/... -v`.

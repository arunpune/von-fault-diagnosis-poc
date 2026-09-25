<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# `@fdp/contracts`

The source of truth for every message the unit's services exchange: MQTT payloads, WebSocket
frames, REST bodies, the topic tree and the Modbus register map. Hand-written JSON Schemas are the
contract: the TypeScript types and validators are generated from them, and the Go and Python tests
check their own code against the same schema files and fixtures, so the three languages cannot drift
apart unnoticed. [`docs/architecture.md`](../../docs/architecture.md#contracts) shows who consumes
what, and [`VERSIONING.md`](VERSIONING.md) says what may change without a coordinated release.

Nothing here imports anything else from the workspace (rule `contracts-pure`).

## Layout

| Path | What it is |
| --- | --- |
| `schemas/v1/*.schema.json` | Hand-written JSON Schema draft 2020-12, `$id: urn:fdp:schema:<stem>:v1`. **The contract.** |
| `schemas/meta/*.schema.json` | Schemas for the configuration files below; their `$id` lives in `urn:fdp:meta:` so it never appears in a message. |
| `topics.json` | Topic templates, QoS, retain, publisher and the broker ACL. |
| `embedding.json` | The embedding model pin: revision, file hashes, pooling, dimension. Exported as `EMBEDDING`. |
| `fixtures/<stem>/` | At least one `valid-*.json` and one `invalid-*.json` per schema, read by the TypeScript, Go and Python tests alike. |
| `fixtures/embeddings/` | Eight reference sentences with their vectors; init (Python) and the backend (Node) assert cosine ≥ 0.9999 against them. |
| `src/generated/**` | Committed generator output. Never edit by hand. |
| `generated/register-map.json` | The canonical register map, derived from `manual/spec/{signals,alarms,settings}.yaml`. Committed generator output. |
| `scripts/` | `generate.ts` (schemas and topics), `generate-regmap.ts` (the register map), `check-drift.sh`, `embed_fixture.py`. |
| `src/` | `index.ts` (public API), `validate.ts`, `time.ts`, `testing.ts`. |
| `mock/` | The local mock decision servers, a TypeSafe stand-in (`pnpm --filter @fdp/contracts mock`) and an Anthropic stand-in (`mock-anthropic`), exported as `@fdp/contracts/mock`; the CI stack runs the first as its `typesafe-mock` service. |
| `test/` | The fixture harness every other package reuses. |

## Commands

```sh
pnpm --filter @fdp/contracts generate     # schemas + topics.json + register map -> generated output
pnpm --filter @fdp/contracts test         # the fixture harness
pnpm --filter @fdp/contracts typecheck
pnpm --filter @fdp/contracts check-drift  # generate, then fail if the tree changed
pnpm --filter @fdp/contracts build        # tsc -b, for the Docker images
pnpm --filter @fdp/contracts embed-fixture check   # re-embed the reference sentences
```

`embed-fixture` takes `pin`, `embed` or `check` and needs `uv` and the network; it downloads
the pinned model into `~/.cache/fdp-embed` (override with `--cache`) and never commits it.

Development and tests never build: `node --conditions=@fdp/source` and vitest resolve
`@fdp/contracts` to `src/index.ts`, so a change is visible without a build step; images run
`tsc -b` and get `dist/`.

## Adding a schema

1. Write `schemas/v1/<name>.schema.json`. It needs `$schema` (draft 2020-12), `$id`
   (`urn:fdp:schema:<name>:v1`), `title` and `description`. Reference the shared definitions
   with `"$ref": "urn:fdp:schema:common:v1#/$defs/<def>"` rather than repeating a pattern, and
   `allOf`-extend `#/$defs/envelope` for anything published on the broker or the WebSocket.
2. Add `fixtures/<name>/valid-*.json` and `fixtures/<name>/invalid-*.json` — at least one of
   each. An invalid fixture may carry a top-level `"$expect_error"` whose value must appear in
   one of the reported issues; the key is stripped before validation.
3. If the schema is the payload of a topic and `pendingSchemas` in `test/topics.test.ts` lists
   it, delete its line there (one name per line, so concurrent branches do not conflict); the
   test fails while a listed schema exists.
4. `pnpm --filter @fdp/contracts generate`, then `pnpm --filter @fdp/contracts test`.
5. Commit the hand-written files in your feature commit and the regenerated `src/generated/**`
   in a separate `chore(contracts): regenerate` commit, so a conflict in generated output is
   resolved by dropping that commit and running the generator again.

Other packages add their own schemas the same way — the backend's `api-*` bodies, for instance. A new
schema file is a **minor** change; see [`VERSIONING.md`](VERSIONING.md) for what is not.

## Using it

```ts
import { assertValid, topics, validateMqtt, type AlertSystem } from "@fdp/contracts";

client.subscribe(topics.alertsSystem());              // plant/cau-7/alerts/system
const result = validateMqtt(topic, payload);          // schemaForTopic + JSON.parse + validate
const alert: AlertSystem = assertValid("alert-system", body);
```

Test helpers live behind a second entry point, because they read the file system:

```ts
import { fixturesFor, listSchemaNames } from "@fdp/contracts/testing";
```

Go tests read `schemas/v1` and `fixtures` from disk (`CONTRACTS_SCHEMA_DIR`, default
`/contracts/schemas/v1` in an image) and Python tests read `CONTRACTS_DIR`, so the files — not
the TypeScript — are what all three languages agree on.

## The register map

`scripts/generate-regmap.ts` derives the register map from the manual's own registries,
`manual/spec/{signals,alarms,settings}.yaml`, so the device, the gateway and the manual cannot
disagree on a slot. It writes three committed files: `generated/register-map.json` (the
canonical form, validated against its meta-schema), `src/generated/register-map.ts` (a typed
constant with its lookup helpers) and `services/modbus/internal/regmap/register_map_gen.go` (the
simulator's and the gateway's table). `generate` runs it after `scripts/generate.ts`, and
`generate:regmap` runs it alone; the two generators write disjoint files. `check-drift` proves
all three still match their sources.

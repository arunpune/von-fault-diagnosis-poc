<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Versioning `@fdp/contracts`

Three languages exchange these messages, and a producer may add a field while its consumers
are still built against the previous version, so these rules say what may change without a
coordinated release. The package itself is described in [`README.md`](README.md).

## The two numbers

The package is semver. Independently of it, every schema carries a **major** in its `$id`
(`urn:fdp:schema:<name>:v1`), and every message repeats that `$id` in its `schema` field. Only
v1 exists in this proof of concept.

## Minor: additive, `$id` unchanged

A change is minor when no document that was valid before becomes invalid:

- a new **optional** field, at any depth;
- a new schema file under `schemas/v1/` — other packages add their `api-*` schemas this way;
- a new value in a `type`, `cmd` or `kind` enum **only** where consumers keep a default branch;
  they must, because unknown values are expected;
- loosening a constraint: a wider range, a looser pattern, a dropped `required` entry.

Consumers keep ignoring unknown top-level fields: the envelope leaves `additionalProperties`
true on purpose. The generated TypeScript types are closed even so, so a producer that means to
add a field adds it to the schema rather than to the payload only.

## Breaking: a new major, a new directory

A change is breaking when a document that was valid before is not any more:

- removing or renaming a field;
- making an optional field required;
- tightening a pattern, an enum, a range or a unit;
- changing a time format or the meaning of a value.

A breaking change means new files under `schemas/v2/` with `$id: urn:fdp:schema:<name>:v2`.
Both majors ship during the migration window and CI runs the fixtures of both. A consumer that
reads an unknown major rejects the message with a logged error rather than guessing.

## Fixture discipline

A change that turns a committed `valid-*.json` fixture into an invalid document is breaking, by
definition — that is what the fixtures are for. Never edit a fixture to make a schema change
pass; add a new fixture for the new shape and keep the old one under the old major.

## The register map

`generated/register-map.json` carries its own `version.major`/`version.minor`, mirrored in
header registers 12 and 13. The gateway refuses a device whose major differs. Adding a
synthetic signal is minor as long as no existing slot offset moves; moving an offset, changing
a scale or renaming a tag is major.

## The embedding pin

A change to `embedding.json` is breaking for stored vectors. Init re-ingests whenever
`model_id`, `revision`, `pooling` or `max_tokens` differ from the values recorded in
`app.ingest_runs`, so the pin is the cache key, not a comment.

## Generated output

`src/generated/**` is derived, committed and never edited by hand. Regenerate it with
`pnpm --filter @fdp/contracts generate` and commit the result in its own
`chore(contracts): regenerate` commit, so a conflict between two branches is resolved by
dropping both regenerate commits and running the generator once.

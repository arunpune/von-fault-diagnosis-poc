<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# fdp-init

The one-shot `init` service of the stack. It waits for Postgres and the MQTT
broker, applies `db/migrations`, downloads and verifies MetroPT-3, fills the
embedding model cache, ingests the manual PDF (text, tables, fault catalog,
chunks and embeddings) and exits 0. A second run finds the same hashes and
skips the ingest. How it reads a manual is in
[`docs/manual.md`](../../docs/manual.md#how-init-extracts-the-fault-catalog)
and how it fetches the dataset in
[`docs/dataset.md`](../../docs/dataset.md#what-init-does); this page is how to
run it.

`make up` runs it for you: Compose starts `init` once Postgres and the broker
are healthy, and the simulator and the backend start only after it has
exited 0.

## Commands

`fdp-init <command>`; the container runs `fdp-init run` by default.

| Command | What it does |
| --- | --- |
| `run` | The whole sequence below. The container default. |
| `wait [--only all\|postgres\|mqtt]` | Wait for Postgres and the broker, then exit. |
| `migrate [--status]` | Apply `db/migrations`; `--status` lists applied and pending files and changes nothing. |
| `dataset [--rehash]` | Make `METROPT_CSV` exist and verify it; `--rehash` ignores the cached digest and reads the file again. |
| `model` | Download and verify the pinned embedding model into `MODEL_CACHE_DIR`, then print where the files are. |
| `ingest` | Extract, embed and store the manual against a database that is already migrated. The skip check still applies. |
| `report` | Print the newest ingest run as JSON on stdout (id, status, times, error and the stored report). |
| `export-catalog --manual <pdf> --out <json>` | Write the contracts `catalog` document the deterministic path extracts from a PDF, so the evaluation can score the catalog the stack actually ingests (`--catalog file:<json>`). Needs no database, broker or key; a document that is not schema-valid exits 6 and writes nothing. |

`fdp-init --help` lists them, `fdp-init --version` prints the version.

In the stack:

```sh
docker compose run --rm init report              # the last ingest report
docker compose run --rm init migrate --status    # what the database has applied
```

On the host, against a stack started with `make up-dev` (which publishes
Postgres on 5432; the broker is on 1883 in every stack):

```sh
POSTGRES_HOST=localhost MQTT_URL=mqtt://localhost:1883 LOG_FORMAT=text \
  uv run --package fdp-init fdp-init run
```

Outside the container, relative paths resolve against the repository root, so
the defaults read `data/manual/`, `data/metropt3/`, `db/migrations` and
`packages/contracts` of the checkout and cache the model in `data/models/`.

## Run sequence

`fdp-init run` is fail-fast: the first step that fails decides the exit code.

1. **wait**: connect to Postgres and send an MQTT CONNECT to the broker, with
   exponential backoff, for up to `INIT_WAIT_TIMEOUT_S` each. A rejected
   password fails at once; waiting cannot fix it.
2. **migrate**: apply the `db/migrations/*.sql` files the database has not
   seen, in order, each in its own transaction. A file that was applied and
   has changed since is an error, never a re-run.
3. **dataset**: verify or download the MetroPT-3 CSV (see [Dataset](#dataset)).
4. **embedding pin**: load `embedding.json` and check that `app.chunks` was
   built for its vector width.
5. **model**: make sure the model files are in `MODEL_CACHE_DIR` with the
   pinned SHA-256; download them from Hugging Face when they are not.
6. **skip check**: if this manual is already stored with the same embedding
   pin, catalog mode and ingest version, log `skipped`, write the report and
   exit 0 (see [Idempotency](#idempotency)).
7. **extract**: read the PDF's text and tables with pdfplumber.
8. **catalog**: build the fault catalog from the troubleshooting, alarm and
   signal tables. With `LLM_API_KEY` set, Claude restructures that draft; any
   failure of that call falls back to the tables and says why in the report.
9. **validate**: check every catalog entry against the contracts schemas.
   Invalid entries become warnings; a catalog that is structurally broken, or
   mostly invalid, fails the run.
10. **chunk** and **embed**: cut the manual into section-referenced chunks
    and embed them with the pinned model.
11. **store**: replace the stored manual in one transaction, then write the
    report.

Every step logs one JSON line when it starts and one when it is done, failed
or skipped, with `step`, `event` and `elapsed_ms`.

## Exit codes

| Code | Meaning | What to look at |
| --- | --- | --- |
| `0` | Success, including "nothing to do" | |
| `1` | Unexpected error; the traceback is in the log | Open an issue with the log |
| `2` | Configuration: a value that does not parse, a missing or unreadable `MANUAL_PATH` or `SHA256SUMS`, a schema whose vector width differs from `embedding.json` | The log line names the variable |
| `3` | Postgres or the broker did not answer within `INIT_WAIT_TIMEOUT_S`, or rejected the credentials | `make ps`, `make logs` |
| `4` | A migration failed, an applied migration changed, or a role the schema needs is missing | The file named in the log; after a password change, `make reset-db` |
| `5` | The dataset download failed on every URL, or a file does not match `data/SHA256SUMS` | [Dataset](#dataset) |
| `6` | Manual extraction or the catalog failed | [Your own manual](#your-own-manual) |
| `7` | The embedding model could not be downloaded or loaded | Network access to `huggingface.co`; `fdp-init model` |
| `8` | Writing the ingest to the database failed; the transaction was rolled back | The failed run in `fdp-init report` |

## Configuration

The `init` service of `compose.yaml` sets the connection and path values as
literals and passes through the user-facing ones listed in the root README's
configuration table, which `.env` overrides; every other variable keeps the
default below. In the image, `INIT_ROOT_DIR` is `/` and a
relative path is resolved against it, so `MANUAL_PATH=data/byo-manual/x.pdf`
means `/data/byo-manual/x.pdf`, which Compose mounts from `./data/byo-manual`.
An empty value counts as unset.

| Variable | Default (image / checkout) | Meaning |
| --- | --- | --- |
| `POSTGRES_HOST`, `POSTGRES_PORT` | `postgres`, `5432` | Admin connection for migrations and the ingest; Compose sets them |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `fdp_admin`, `fdp_admin`, `fdp` | Admin credentials (PoC defaults, not secrets) |
| `MQTT_URL` | `mqtt://mqtt:1883` | Broker to wait for; init never publishes |
| `METROPT_CSV` | `/data/metropt3/MetroPT3(AirCompressor).csv` / `data/metropt3/…` | The dataset file. Only the canonical name is ever downloaded; any other path must exist |
| `METROPT_URL` | the UCI archive | Primary download (the project mirror once it is published) |
| `METROPT_FALLBACK_URL` | the UCI archive | Tried when `METROPT_URL` fails and differs from it |
| `SHA256SUMS_PATH` | `/data/SHA256SUMS` / `data/SHA256SUMS` | The committed digests, read from its bind mount |
| `MANUAL_PATH` | `data/manual/cau-7-realistic.pdf` | The PDF to ingest |
| `MODEL_CACHE_DIR` | `/models` / `data/models` | The embedding model cache (the `model-cache` volume) |
| `CONTRACTS_DIR` | `/contracts` / `packages/contracts` | `embedding.json` and `schemas/v1` |
| `MIGRATIONS_DIR` | `/db/migrations` / `db/migrations` | The SQL migrations |
| `LLM_PROVIDER` | `anthropic` | Provider of the optional catalog structurer |
| `LLM_API_KEY` | unset | Turns the structurer on. The only secret; it is never logged, stored or baked into the image |
| `LLM_MODEL` | `claude-opus-5` | Model of the structurer |
| `LLM_BASE_URL` | the SDK's endpoint | Endpoint override; only the tests set it, to the contracts mock |
| `INIT_LLM_TIMEOUT_S` | `120` | Timeout of one structuring request |
| `INIT_WAIT_TIMEOUT_S` | `120` | Wait budget per dependency, in seconds |
| `INIT_DOWNLOAD_TIMEOUT_S` | `3600` | Budget for one whole download, retries included |
| `INIT_DOWNLOAD_RETRIES` | `5` | Attempts per URL |
| `INIT_FORCE_INGEST` | `0` | `1` re-ingests even when nothing changed |
| `INIT_SKIP_DATASET`, `INIT_SKIP_MANUAL` | `0`, `0` | Development switches that leave a step out; never set in Compose |
| `INIT_REPORT_DIR` | `/reports` / `reports` | Where the report file goes, when the directory exists and is writable |
| `INIT_EMBED_BATCH_SIZE` | `32` | Chunks per embedding batch |
| `INIT_ORT_THREADS` | `min(4, CPUs)` | onnxruntime threads |
| `CATALOG_FAULT_ID_PATTERN` | snake_case with an underscore | Regex a printed fault id must match |
| `CATALOG_CONDITION_ID_PATTERN` | the fault id pattern | Regex a printed condition id must match |
| `CATALOG_ALARM_CODE_PATTERN` | a letter W, X, S or M and three digits | Regex a printed alarm code must match |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning` or `error` |
| `LOG_FORMAT` | `json` | `text` is easier to read on a terminal |

Log lines mask the value of every variable whose name ends in `_API_KEY`,
`_PASSWORD` or `_TOKEN`, any `sk-ant-…` token and any `Bearer` value, in
messages, extra fields and tracebacks alike.

## Dataset

- A file already at `METROPT_CSV` is hashed and compared with its line in
  `data/SHA256SUMS`. The digest is cached in `<file>.sha256.json` beside it
  and trusted while the size and modification time match, so a later
  `make up` does not re-read 218 MB.
- A file whose name `SHA256SUMS` does not list is accepted when its first
  line is the MetroPT-3 header; the report calls it `unverified`.
- A copy under the canonical name that does not match is renamed to
  `<name>.corrupt-<timestamp>` and downloaded again. A listed fixture that does
  not match is an error (exit 5), because a fixture is never downloaded.
- A missing canonical file is downloaded from `METROPT_URL`, then from
  `METROPT_FALLBACK_URL`, resuming a partial `.part` file, unzipped when the
  payload is the UCI archive, and moved into place only once its digest
  matches.

Fixture mode (`METROPT_CSV=/data/fixtures/metropt3/ci-slice.csv`) needs the
slice on the host first: run `make fixtures`, or init exits 5.

## Idempotency

A run stores nothing and reports `skipped` when the database already holds a
manual with the same SHA-256 whose latest ingest run succeeded with:

- the same embedding model, revision, dimension, pooling and token limit as
  `packages/contracts/embedding.json`;
- the same catalog mode: `llm` when `LLM_API_KEY` is set, `tables` otherwise;
- the same ingest version, which changes whenever extraction, chunking, the
  catalog or the storage do.

Anything else re-ingests, and `INIT_FORCE_INGEST=1` re-ingests regardless.
The catalog and the chunks are written in one transaction, which also deletes
every other manual, so exactly one manual is active afterwards. A failed ingest
of a different file leaves the previous manual in place and keeps the failed
run for `fdp-init report`; re-ingesting the same file (forced, or in the other
catalog mode) clears that file's old rows first.

The report is stored in `app.ingest_runs.stats`, logged as one
`ingest.report` event, and written to
`INIT_REPORT_DIR/init-ingest-<started_at>.json` (`./reports` on the host).

## Your own manual

1. Put the PDF in `data/byo-manual/`. Git ignores that directory; only use a
   manual you are allowed to use.
2. Set `MANUAL_PATH=data/byo-manual/<file>.pdf` in `.env`.
3. Run `make reset-db && make up` to start from an empty database, or `make up`
   to swap the manual in place: the new file's hash differs, so init
   re-ingests and replaces the old manual once the new one is stored.

The deterministic catalog reads the manual's troubleshooting tables: a header
row naming the columns (fault id, possible cause, subsystem, signals, checks,
remedy, or their synonyms), one row per cause, and the fault id printed in the
row. The parser recognises ids by the `CATALOG_*_PATTERN` expressions
(snake_case fault and condition ids, `W104`-style alarm codes by default); an
id the contracts schema would reject is kept with a warning in the report
rather than failing the run. Compose does not pass the three overrides, so set
them when you run `fdp-init` yourself, or add them to the `init` service's
`environment`. With `LLM_API_KEY` set, Claude restructures the draft catalog,
which helps with tables the parser only half understands.

## Troubleshooting

- **Exit 3 at startup.** Postgres or the broker is not healthy yet, or the
  credentials in `.env` changed after the first start: roles are created only
  when the `pgdata` volume is empty, so `make reset-db` applies the new ones.
- **Exit 4 after pulling new code.** An applied migration file changed. The
  PoC has no down migrations: `make reset-db` rebuilds the database.
- **Exit 5.** The download failed or the hash does not match. Point
  `METROPT_URL` at another copy, or place `MetroPT3(AirCompressor).csv` in
  `data/metropt3/` by hand; init checks the hash either way. A file named
  `*.corrupt-*` next to it is the copy that did not match.
- **Exit 7.** The model files come from `huggingface.co` on the first run.
  `docker compose run --rm init model` fills the `model-cache` volume on its
  own, so the cache can be warmed once while there is network; a file that
  does not match its pinned SHA-256 is deleted and fetched again.
- **The ingest took minutes on the first run.** The model download (about
  91 MB) and the embeddings happen once; later runs report `skipped` within
  seconds.
- **The catalog came from the tables although `LLM_API_KEY` is set.** The
  report's `catalog.fallback_reason` says why (`auth`, `rate_limit`,
  `timeout`, `connection`, `invalid_output`, …).

## The image

`tools/init/Dockerfile` builds from the repository root:

```sh
docker build -f tools/init/Dockerfile -t fdp-init:local .
```

It holds the virtual environment with `fdp-init` and its `llm` extra, the
migrations under `/db/migrations`, the contracts schemas and `embedding.json`
under `/contracts`, and pypdfium2's third-party notices under
`/usr/share/doc/third-party/pypdfium2/`. `/models` is a volume; no model is
baked in. The image runs as root, because it writes into host bind mounts
(`./data/metropt3`, `./reports`) whose owner varies between machines; it is a
one-shot that exits, and every long-running service runs as a non-root user.
No `.env` enters the build context and no build argument or environment
variable of the image carries a key.

## Tests

| Layer | Command | Needs |
| --- | --- | --- |
| unit | `make test-init` | nothing (a warm model cache for the embedder tests) |
| integration | `make test-init-integration` | Docker |
| end to end | `make test-init-e2e` | Docker; network for a cold model cache |
| quality | `make test-init-quality` | the committed PDFs and reference catalog; writes `reports/init-extraction-quality.json` |
| live | `uv run --package fdp-init pytest -m live tools/init/tests/live -s` | a real `LLM_API_KEY`; run by a person, never by CI |

The end-to-end test builds the image, starts pgvector and Mosquitto on a
private network and runs the image four times: a first run that ingests, a
second that is skipped, a run with a dummy key whose structurer cannot
connect, and a run with a wrong dataset hash that exits 5. Set
`INIT_TEST_MODEL_CACHE` to a warm cache directory to skip the model download,
and `FDP_REQUIRE_DOCKER=1` to fail instead of skip without Docker.

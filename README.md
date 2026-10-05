<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Fault Diagnosis PoC

<p align="center">Manual-grounded fault triage for an industrial compressed-air unit.<br>Live telemetry goes in; classified alerts and tickets come out. Read-only by design.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/code-Apache--2.0-blue" alt="Code licence: Apache-2.0"></a>
  <a href="LICENSES/CC-BY-4.0.txt"><img src="https://img.shields.io/badge/manual%20%26%20data-CC%20BY%204.0-lightgrey" alt="Manual, catalog and data licence: CC BY 4.0"></a>
  <a href="REUSE.toml"><img src="https://img.shields.io/badge/REUSE-compliant-brightgreen" alt="REUSE compliant"></a>
  <a href="CONTRIBUTING.md#4-commits"><img src="https://img.shields.io/badge/commits-conventional-FE5196" alt="Conventional Commits"></a>
  <a href="#status-and-limitations"><img src="https://img.shields.io/badge/status-proof%20of%20concept-orange" alt="Status: proof of concept"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Docker%20Compose-2.24%2B-2496ED?logo=docker&logoColor=white" alt="Docker Compose 2.24 or newer">
  <img src="https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white" alt="Go 1.27">
  <img src="https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white" alt="Python 3.13">
  <img src="https://img.shields.io/badge/Postgres-18%20%2B%20pgvector-4169E1?logo=postgresql&logoColor=white" alt="Postgres 18 with pgvector">
  <img src="https://img.shields.io/badge/MQTT-Mosquitto-3C5280?logo=eclipsemosquitto&logoColor=white" alt="MQTT broker: Mosquitto">
</p>

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#try-it-in-five-minutes">Tour</a> · <a href="#how-it-works">How it works</a> · <a href="#decision-backends">Decision backends</a> · <a href="#evaluation">Evaluation</a> · <a href="#documentation">Documentation</a> · <a href="#contributing">Contributing</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/ui-dark-1440.png">
    <img src="docs/img/ui-light-1440.png" alt="The dashboard during the replay of the 5 June 2020 air leak: four signal lanes on the left, the simulation controls and the alert feed on the right, the tickets table and the running cost below" width="900">
  </picture>
</p>
<p align="center"><sub>The dashboard paused during the replay of the 5 June 2020 air leak: signals on the left, simulation controls and alerts on the right, tickets and the running cost below. Captured on the CI stack, whose Von endpoint is a mock, so the figures show the interface, not a model's accuracy.</sub></p>

Fault Diagnosis PoC replays real compressor telemetry through an emulated Modbus device, spots suspicious behaviour with plain code, and asks a decision model which fault from the machine manual explains it. Everything is visible live in the browser: signals, alerts with severity, the model's answer and what each decision cost.

- **Grounded in the manual.** Every answer names a fault from the machine's own manual, with the section it comes from. On the first start, init turns the PDF into a fault catalog and a retrieval index.
- **Code watches, the model decides.** Windows, trends and machine state are computed in code, and a rule raises a suspect event. The model answers three questions: which fault (or none), how severe, how sure. It never sees raw time series and never writes to the machine.
- **Ground truth sealed off.** Which fault is active and when is kept away from the diagnosis code by construction: separate package, broker credentials, database roles and lint rules; see [`docs/architecture.md`](docs/architecture.md#ground-truth-isolation).

> [!TIP]
> **Zero setup.** The default decision model is [Von](https://typesafe.ai) by TypeSafe AI. Without an API key the demo falls back to a rules-only baseline that answers the same three questions, so you can try it with nothing but Docker.

**Decision backends:** Von (the default when a key is set), Anthropic Claude, or the rules-only baseline (the default without a key). [Compare them](#decision-backends).

---

## Quick start

You need Docker with Compose v2 (2.24 or newer) and git; `make` is optional (the [Commands](#commands) table gives the underlying commands).

```bash
git clone https://github.com/meddleconnect/von-fault-diagnosis-poc.git
cd von-fault-diagnosis-poc
cp .env.example .env    # optional: add TYPESAFE_API_KEY to enable Von
make up                 # same as: docker compose up --build -d --wait
```

Open **http://localhost:8080**.

`make up` returns once every service is healthy; when the one-shot init service fails, it fails too, with init's exit code in `make logs`. The stack publishes three ports: the web UI on `UI_PORT` (8080), the MQTT broker on `MQTT_PORT` (1883) and the emulated Modbus device on `MODBUS_PORT` (5020). `make up-dev` also publishes the development ports 5432 (Postgres), 3000 (backend), 8081 (simulator status) and 8082 (gateway health) through `compose.dev.yaml`.

> [!NOTE]
> The first run downloads the MetroPT-3 dataset (a 218 MB CSV inside a 218 MB zip) and the embedding model (about 91 MB), ingests the manual and builds the images, so give it a while: typically 10 to 30 minutes, mostly image builds and downloads. Later runs reuse all of it.

### Faster replay

After the first `make up` has downloaded the dataset, `make fixtures` cuts small slices from the verified file. Set `METROPT_CSV=/data/fixtures/metropt3/ci-slice.csv` in `.env` to replay the 20-hour CI slice (six hours of 1 Feb 2020, eight hours around the 5 June 2020 air leak and six hours of a depot depressurisation on 31 July 2020); CI runs in this mode. Only the presets *Normal operation – 1 Feb 2020*, *Air leak – 5 Jun 2020* and *Depot depressurisation – 31 Jul 2020* point into it.

---

## Try it in five minutes

1. Press **Play** in the Simulation panel. The replay starts in February 2020 at 600× real time.
2. Open **Jump to** and pick **Air leak – 5 Jun 2020**. The compressor stays loaded and never reaches its cut-out pressure, and the dryer purge pressure stays high while it runs: the signature of a leak on the dryer's purge side.
3. Follow the **Alerts** feed: a suspect event appears, then a decision with fault, severity badge and confidence.
4. Open the alert to see the candidate faults with probabilities, the manual section behind them and the gate outcome. A decision at 0.85 or more opens a ticket and one from 0.60 (0.65 with Von) a review item, which you close as correct or wrong from the Tickets and Review tabs. With the rules-only backend the leak's decision stays below 0.60, so it is logged and opens neither (see [Status and limitations](#status-and-limitations)).
5. Use **Inject fault → Oil cooler fouling** to see a fault the dataset itself never contains.
6. Check the **Cost** panel for the cost of each decision and the running total.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/ui-dark-1440-decision.png">
    <img src="docs/img/ui-light-1440-decision.png" alt="The decision sheet: the chosen fault with its severity, ticket status and backend, a confidence bar marked with the review and ticket thresholds, and every candidate fault with its probability, evidence match and manual section" width="900">
  </picture>
</p>
<p align="center"><sub>Step 4, the decision sheet: the confidence against the review and ticket thresholds, then every candidate fault with its probability, how well the evidence matches and the manual section it comes from. Same CI stack and mock as above, captured before Von got its own review threshold of 0.65, so the sheet still marks review at 60 %.</sub></p>

Prefer a terminal? Watch the raw stream with any MQTT client:

```bash
mosquitto_sub -h localhost -p 1883 -t 'plant/#' -v
```

Anonymous clients can read telemetry, status, events, decisions and alerts; ground truth and control topics need a credential.

---

## What it does

| Capability | What you get |
| --- | --- |
| **Manual in, fault catalog out** | init reads the manual PDF (text and tables), builds the fault catalog (17 conditions and 39 causes in the bundled manual) and indexes its chunks with embeddings in Postgres and pgvector |
| **Real telemetry, emulated device** | Seven months of MetroPT-3 compressor data (1.5 million samples) replayed as a Modbus TCP device with the 15 MetroPT-3 signals plus a synthetic ambient temperature, at 600× real time by default, with jumps to nine presets |
| **Detection in plain code** | 16 rules (15 on by default) over windows, trends and machine state, with normal bands taken from the first month of data; no model reads raw time series |
| **Three decision backends** | Von, Anthropic Claude or a rules-only baseline that needs no key, all returning the same decision shape: which fault (or none), how severe, how sure |
| **Confidence gate and episodes** | A ticket at 0.85 confidence or more, a review ticket from 0.60, a log line below; one ticket per episode, updated while the symptom lasts |
| **Fault injection** | Nine injection types, six faults and three benign look-alikes such as heavy air demand, for faults the dataset itself never contains |
| **Live dashboard** | Signals, alerts with severity, the candidates behind every decision with their manual section, tickets, a review queue and the cost of each decision |
| **Evaluation harness** | Replays scenarios with known ground truth and reports precision, recall, lead time, false tickets per machine-day and how often "none of these" is right |
| **Ground truth sealed off** | Labels live in their own package, broker root and database schema; broker ACLs, database roles and import boundaries keep the diagnosis from reading them |
| **Built to be audited** | SPDX headers on every file (REUSE), a brand blocklist, pinned dependencies with an audited licence list and one `make` entry point |

---

## How it works

```mermaid
flowchart TB
    PDF["Machine manual (PDF)"] -->|"ingest"| INIT["init · Python<br/>one-shot, on the first start"]
    INIT -->|"downloads, verifies"| CSV["MetroPT-3 (CSV)"]
    INIT -->|"catalog, chunks, embeddings"| DB[("Postgres 18<br/>+ pgvector")]
    CSV -->|"replay"| SIM["modbus-sim · Go<br/>Modbus TCP device"]
    SIM -->|"Modbus TCP"| GW["gateway · Go<br/>polls the device"]
    GW -->|"telemetry"| MQ{{"MQTT broker<br/>Mosquitto + topic ACL"}}
    MQ -->|"telemetry"| BE["backend · Node.js<br/>detection, retrieval,<br/>decisions, gate, tickets"]
    BE -->|"events, decisions,<br/>alerts, control"| MQ
    MQ -->|"control"| SIM
    BE <--> DB
    BE -->|"one request<br/>per decision"| DEC["Decision backend<br/>Von, LLM or rules"]
    BE <-->|"REST + WebSocket"| UI["frontend<br/>React + shadcn/ui"]
```

1. **init** extracts text and tables from the manual PDF, builds the fault catalog and stores chunks with embeddings in Postgres, then exits.
2. **modbus-sim** replays MetroPT-3 as a Modbus TCP device. **gateway** polls it and publishes JSON to MQTT, stamped with simulated time.
3. **backend** computes windows, trends and machine state in code, and raises a suspect event when a rule fires.
4. For each event it retrieves candidate faults from the manual and asks the decision backend: which fault (or none), how severe, how sure. With no key, the rules-only backend answers the same three questions from the catalog's signal-move descriptions, and the UI shows *Rules* as the active backend.
5. A confidence gate turns the answer into a ticket, a review item or a log line. The UI shows it all live.

The model never sees raw time series and never writes to the machine. Design details: [docs/architecture.md](docs/architecture.md); the routes, frames and topics: [docs/api.md](docs/api.md).

### One decision, end to end

```mermaid
sequenceDiagram
    autonumber
    participant SIM as modbus-sim
    participant GW as gateway
    participant MQ as MQTT broker
    participant BE as backend
    participant DB as Postgres + pgvector
    participant DEC as Decision backend
    participant UI as Browser
    GW->>SIM: poll the registers over Modbus TCP
    GW->>MQ: telemetry stamped with simulated time
    MQ->>BE: telemetry
    BE->>BE: windows, trends and machine state
    Note over BE: a rule fires and opens or extends an episode
    BE->>DB: retrieve candidate faults from the manual
    DB-->>BE: candidates with their manual section
    BE->>DEC: which fault (or none), how severe, how sure
    DEC-->>BE: choice, probabilities, severity, confidence, token usage
    BE->>BE: confidence gate
    BE->>DB: store the decision, the ticket and the cost
    BE->>MQ: suspect event, decision and alert
    BE-->>UI: WebSocket frames for the alert, decision, ticket and cost
```

Every decision is published on `plant/cau-7/decisions`. Below is its shape, trimmed from a hand-written contract fixture in [`packages/contracts/fixtures/decision/`](packages/contracts/fixtures/decision/valid-rules-review.json). The fixture's values illustrate the `review` path, which the rules backend does not reach on this leak (see [Status and limitations](#status-and-limitations)):

```jsonc
{
  "backend": "rules",
  "model": "rules-v1",
  "sim_ts": "2020-06-05T09:41:12.000Z",
  "choice": "dryer_purge_leak",
  "probabilities": {
    "dryer_purge_leak": 0.4417,
    "downstream_air_leak": 0.2761,
    "high_air_demand": 0.1104,
    "none_of_these": 0.1718
  },
  "confidence": 0.648,
  "candidates": [
    {
      "fault_id": "dryer_purge_leak",
      "name": "Dryer purge valve not seating",
      "probability": 0.4417,
      "benign": false,
      "manual_ref": { "section": "8.3", "title": "Compressor stays loaded and does not reach cut-out" }
    }
    // … downstream_air_leak and high_air_demand (benign) follow
  ],
  "severity": { "level": "high", "score": 2 },
  "gate": { "outcome": "review", "ticket_min_confidence": 0.85, "review_min_confidence": 0.6 },
  "usage": { "input_tokens": 0, "output_tokens": 0 },
  "cost": { "usd": 0, "prices_as_of": "2026-09-19" }
}
```

### The confidence gate

```mermaid
flowchart LR
    D["Decision<br/>fault, severity, confidence"] --> N{"A named fault?"}
    N -->|"no: none of these"| L["Log line"]
    N -->|"yes"| C{"Confidence"}
    C -->|"0.85 or more"| T["Ticket, open"]
    C -->|"0.60 to 0.85"| R["Ticket in review"]
    C -->|"below 0.60"| L
```

Severity never changes the outcome, and a failed decision never reaches the gate. An episode opens on the first suspect event, is first decided once its symptom has kept firing for a simulated minute (`GATE_PERSIST_SIM_MIN`), is decided again every 30 simulated minutes while its rule keeps firing and closes after 120 minutes of calm (`DECISION_INTERVAL_SIM_MIN`, `EPISODE_CLEAR_SIM_MIN`). Later decisions update the episode's ticket, and a ticket in review is promoted to open when a decision reaches the ticket threshold. Technicians close tickets as correct or wrong. The thresholds and the persistence are configuration: `GATE_TICKET_MIN_CONFIDENCE`, `GATE_REVIEW_MIN_CONFIDENCE` and `GATE_PERSIST_SIM_MIN`. Von reports its own probability, a different scale from the rules backend's confidence, so it has its own pair, `VON_GATE_TICKET_MIN_CONFIDENCE` and `VON_GATE_REVIEW_MIN_CONFIDENCE`. They default to 0.85 and 0.65, the pre-registered choice ([tools/eval/records/von-thresholds-choice.md](tools/eval/records/von-thresholds-choice.md)), whatever the global pair is set to, and the rules and LLM backends keep the global pair.

### Ground truth stays out of the diagnosis

```mermaid
flowchart LR
    SIM["modbus-sim<br/>(the machine)"]
    OVL["backend overlay<br/>menus, chart overlays"]
    EVAL["tools/eval<br/>scoring"]
    subgraph gt["Ground truth"]
        PKG[("packages/ground-truth<br/>failure windows,<br/>presets, injections")]
        TOPIC{{"MQTT root gt/"}}
        SCHEMA[("Postgres schema gt")]
    end
    DIAG["Diagnosis<br/>detection, retrieval,<br/>decision, gate"]

    EVAL ---|"imports in-process"| PKG
    SIM ---|"reads its own copy"| PKG
    SIM ---|"publishes injections,<br/>jumps, markers"| TOPIC
    OVL ---|"subscribes as backend-ops"| TOPIC
    OVL ---|"writes as gt_rw"| SCHEMA
    PKG --x|"import boundaries"| DIAG
    TOPIC --x|"broker ACL"| DIAG
    SCHEMA --x|"role app_rw"| DIAG
```

The simulator is the machine, so it knows which fault it injects; the diagnosis only sees telemetry, which carries no "injected" flag, and a replay jump reaches it only as a discontinuity flag. The UI builds its **Jump to** and **Inject fault** menus and its chart overlays from the backend's overlay module, which is the one part of the backend allowed to read ground truth. `make gt-paths` and `make boundaries` fail the lint when a diagnosis path reaches it.

---

## Decision backends

The backend asks one set of questions per decision, and three interchangeable backends answer it. All three return the same decision shape, so the gate, the tickets, the cost ledger, the UI and the evaluation never depend on which one produced it.

| Backend | Selected when | Needs | How it answers |
| --- | --- | --- | --- |
| **Von** | `TYPESAFE_API_KEY` is set, or `DECISION_BACKEND=von` | `TYPESAFE_API_KEY` | [Von](https://typesafe.ai), TypeSafe AI's System One model, pinned to `von-1.13.0`. One request per decision: a Choice over the candidate faults plus "none of these", one Noul per candidate and a Score for severity. |
| **LLM** | `DECISION_BACKEND=llm` | `LLM_API_KEY` | Anthropic Claude (`claude-opus-5` by default) over the same state, with a structured output schema. The same key enables the optional LLM pass that structures the catalog in init. |
| **Rules** | No key is set, or `DECISION_BACKEND=rules` | Nothing | The catalog's signal-move descriptions, scored in code. Its confidence is derived from the margin between the two best candidates, not a calibrated probability. |

The Cost panel prices every decision with the `*_PRICE_*` variables of the [Configuration](#configuration); the rules backend costs nothing. A backend whose key is missing fails at start-up instead of falling back silently. More in [docs/decision-backends.md](docs/decision-backends.md).

---

## Evaluation

`make eval` replays scenarios with known ground truth for both Von and the rules-only baseline. It reports precision and recall per fault, lead time against the unit's own alarms, tickets per machine-day, and how often the model rightly answers "none of these". Ground truth never reaches the diagnosis code.

| Profile | What it replays | Used by |
| --- | --- | --- |
| `smoke` | Five short scenarios | CI, against the mock Von server; `EVAL_PROFILE=smoke make eval` runs the same profile locally |
| `core` (default) | The core-10: the ten test-split scenarios the gates count | Local runs |
| `full` | 18 scenarios (the core-10 and eight dev scenarios), the whole MetroPT-3 recording included, from the downloaded CSV | The figures below |

Von runs live when `TYPESAFE_API_KEY` is set and the run is confirmed with `--confirm-live`, from recorded cassettes without a key, and against a mock server when there are neither, and every report says which. The evaluation reads its variables, `TYPESAFE_API_KEY` included, from the environment of the command and not from `.env`: set them on the command line or export them. More in [docs/evaluation.md](docs/evaluation.md).

### The recording at a glance

```mermaid
gantt
    title MetroPT-3 as the stack replays it (UTC, 2020)
    dateFormat YYYY-MM-DD HH:mm
    axisFormat %d %b
    todayMarker off
    section Recording
    Replayed telemetry :done, rec, 2020-02-01 00:00, 2020-09-01 00:00
    section Air leaks
    F1 18 Apr :crit, milestone, f1, 2020-04-18 00:00, 0d
    F2 30 May :crit, milestone, f2, 2020-05-29 23:30, 0d
    F3 5 Jun, the tour preset :crit, milestone, f3, 2020-06-05 10:00, 0d
    F4 15 Jul :crit, milestone, f4, 2020-07-15 14:30, 0d
    section Low-pressure switch
    F3 switch 6 Jun :milestone, a3, 2020-06-06 19:42, 0d
    F4 switch 15 Jul :milestone, a4, 2020-07-15 17:20, 0d
```

Seven months of telemetry from one unit with four documented air leaks, F1 to F4, taken from the dataset's failure table as [the dataset guide](docs/dataset.md#how-the-windows-were-resolved) resolves it. For F3 and F4 the recording also shows the unit's low-pressure switch tripping. Lead time is measured against the warnings of the emulated CTRL-7 controller, with that switch reported beside it as a reference ([docs/evaluation.md](docs/evaluation.md#lead-time-against-the-units-own-alarms)); [docs/dataset.md](docs/dataset.md) has the full failure table.

### Results: the rules-only baseline

The rules-only baseline on the whole recording (`EVAL_PROFILE=full make eval`, model `rules-v1`, no key, no cost), run on 2026-09-24. These figures are **in-sample**:

| Measure | Value |
| --- | --- |
| Replayed | 1,516,418 samples, 1 February to 31 August 2020, with 158.1 negative machine-days (the covered time outside the failure windows and the excluded windows) |
| MetroPT-3 check: air leaks caught at ticket level | **0 of 4** |
| False tickets per negative machine-day | **0.063** at ticket level, **0.209** at review level |
| Tickets inside unlabelled episodes, counted separately | 0 |

```mermaid
%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "#7aa6db"}}, "xyChart": {"showDataLabel": true}}}%%
xychart-beta horizontal
    title "Rules baseline, whole recording: from suspect event to ticket"
    x-axis ["Suspect events", "Decisions", "Review or ticket", "Tickets"]
    y-axis "Count" 0 --> 3000
    bar [2704, 1612, 105, 33]
```

Of 2,704 suspect events in 344 episodes, 1,612 led to a decision; 105 of those cleared the review threshold and 33 the ticket threshold. Only one ticket or review item opened inside a failure window, a ticket during F4, and it names a fault other than the air leak. For scale, the full-dataset gate asks for 4 of 4 at ticket level for at least one backend, with a target of at most 0.5 false tickets per negative machine-day for Von.

These figures are in-sample: the detection rules were designed after looking at the four failures, and later design decisions were made after the in-sample results had been seen, on a recording that includes the evaluated days. They also rest on the failure table as [the dataset guide](docs/dataset.md) resolves it. The one clean measurement is a small held-out set, sealed before its single run ([tools/eval/records/heldout-seal.md](tools/eval/records/heldout-seal.md), [tools/eval/records/heldout-final-run.md](tools/eval/records/heldout-final-run.md)). Von was evaluated as well; its results are not published pending the vendor's terms. More in [docs/evaluation.md](docs/evaluation.md#the-rules-only-baseline-on-the-whole-recording).

---

## Configuration

All settings live in `.env`, copied from `.env.example`. Every variable is optional: without a key, the defaults below run the rules backend.

<details>
<summary>Every variable, grouped as in .env.example, with its default</summary>

| Variable | Default | What it does |
| --- | --- | --- |
| **Decision backend** | | |
| `TYPESAFE_API_KEY` | — | Enables Von as the decision backend |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Endpoint of the decision service |
| `VON_MODEL` | `von-1.13.0` | Pinned Von model id; thresholds are tuned per version |
| `DECISION_BACKEND` | `von` if a key is set, else `rules` | `von`, `llm` or `rules` |
| `LLM_PROVIDER` | `anthropic` | Vendor of the optional LLM backend |
| `LLM_API_KEY` | — | Enables the LLM backend and LLM catalog structuring |
| `LLM_MODEL` | `claude-opus-5` | Model id for the LLM backend |
| `LLM_BASE_URL` | vendor default | Endpoint override for the LLM; the tests point it at a mock. The Compose stack does not pass it on |
| **Prices (Cost panel)** | | |
| `VON_PRICE_INPUT_PER_MTOK` | `0.042` | USD per million input tokens, for the Cost panel: Von's price as published by TypeSafe AI, September 2026, with output tokens free |
| `LLM_PRICE_INPUT_PER_MTOK` | `5` | Same, for the LLM: the price of `claude-opus-5` as published by Anthropic, September 2026 |
| `LLM_PRICE_OUTPUT_PER_MTOK` | `25` | USD per million output tokens, for the LLM, as published by Anthropic, September 2026 |
| `PRICES_AS_OF` | `2026-09-19` | When the prices were last checked |
| **Data** | | |
| `METROPT_URL` | the UCI zip | Where init downloads MetroPT-3 |
| `METROPT_FALLBACK_URL` | `https://archive.ics.uci.edu/static/public/791/metropt+3+dataset.zip` | Used when `METROPT_URL` is unreachable |
| `METROPT_CSV` | `/data/metropt3/MetroPT3(AirCompressor).csv` | Container path of the replay source; `/data/fixtures/metropt3/ci-slice.csv` selects the faster replay |
| `METROPT_CSV_HOST` | `data/metropt3/MetroPT3(AirCompressor).csv` | Host path the fixture slices are cut from; read from the environment of `make fixtures`, not from `.env` |
| `MANUAL_PATH` | realistic PDF in `data/manual/` | Manual to ingest |
| `MODEL_CACHE_DIR` | `/models` | Where the embedding model is cached; the Compose stack fixes it at `/models` |
| **Init** | | |
| `INIT_WAIT_TIMEOUT_S` | `120` | How long init waits for the database and the broker |
| `INIT_DOWNLOAD_TIMEOUT_S` | `3600` | How long the dataset download may take |
| `INIT_FORCE_INGEST` | `0` | Set to `1` to re-ingest the manual on the next start |
| **Simulation and ports** | | |
| `REPLAY_SPEED` | `600` | Initial replay speed, × real time |
| `UI_PORT` | `8080` | Published port of the web UI |
| `MQTT_PORT` | `1883` | Published port of the broker |
| `MODBUS_PORT` | `5020` | Published port of the emulated device |
| `POLL_INTERVAL_MS` | `50` | How long the gateway pauses when a poll finds no new sample |
| **Postgres and broker credentials (non-secret PoC defaults)** | | |
| `POSTGRES_USER` | `fdp_admin` | Database superuser |
| `POSTGRES_PASSWORD` | `fdp_admin` | Password of that superuser |
| `POSTGRES_DB` | `fdp` | Database name |
| `PG_APP_PASSWORD` | `app_rw` | Password of the application role |
| `PG_GT_PASSWORD` | `gt_rw` | Password of the ground-truth role |
| `PG_EVAL_PASSWORD` | `eval` | Password of the evaluation role |
| `MQTT_GATEWAY_PASSWORD` | `gateway` | Broker password of the gateway |
| `MQTT_SIM_PASSWORD` | `sim` | Broker password of the simulator |
| `MQTT_BACKEND_DIAG_PASSWORD` | `backend-diag` | Broker password of the diagnosis client |
| `MQTT_BACKEND_OPS_PASSWORD` | `backend-ops` | Broker password of the control client |
| `MQTT_EVAL_PASSWORD` | `eval` | Broker password of the evaluation client |
| **Backend tuning** | | |
| `HEARTBEAT_TELEMETRY_TIMEOUT_S` | `15` | Silence after which telemetry counts as stale |
| `HEARTBEAT_DECISION_TIMEOUT_S` | `60` | Silence after which the decision backend counts as stale |
| `GATE_TICKET_MIN_CONFIDENCE` | `0.85` | Confidence a decision needs to open a ticket |
| `GATE_REVIEW_MIN_CONFIDENCE` | `0.60` | Confidence a decision needs to become a review item |
| `GATE_PERSIST_SIM_MIN` | `1` | Simulated minutes a symptom must keep firing before it can become a review item or a ticket (`0` = at once) |
| `VON_GATE_TICKET_MIN_CONFIDENCE` | `0.85` | Von's own ticket threshold, the pre-registered choice; the rules and LLM backends keep `GATE_TICKET_MIN_CONFIDENCE` |
| `VON_GATE_REVIEW_MIN_CONFIDENCE` | `0.65` | Von's own review threshold, the pre-registered choice; the rules and LLM backends keep `GATE_REVIEW_MIN_CONFIDENCE` |
| `DECISION_INTERVAL_SIM_MIN` | `30` | Simulated minutes between two decisions on one episode |
| `EPISODE_CLEAR_SIM_MIN` | `120` | Simulated minutes of calm that close an episode |
| `TELEMETRY_RETENTION_SIM_DAYS` | `365` | Simulated days of telemetry kept in the database |
| `LOG_LEVEL` | `info` | Log level of every service |
| `EMBEDDER_ALLOW_DOWNLOAD` | `false` | Whether the embedding model may be downloaded at run time |
| `RULES_DISABLED` | `flow_pulses_missing` | Comma-separated detection rules to switch off |
| `WS_TELEMETRY_INTERVAL_MS` | `250` | How often the UI receives a telemetry frame |
| **Evaluation** | | |
| `EVAL_PROFILE` | `core` | Which scenario set the evaluation runs; read from the environment of `make eval`, not from `.env` |
| `EVAL_VON_MODE` | `auto` | How the evaluation runs Von: `live`, `cassette`, `mock`, or `auto` to pick by key; read from the environment of `make eval`, not from `.env` |

</details>

Only the two `*_API_KEY` variables are secrets; every other value is a PoC default you may leave as is. Keys are read only from `.env`, which Git ignores: `TYPESAFE_API_KEY` reaches only the `backend` container and `LLM_API_KEY` the `backend` and `init` containers, and neither appears in images, logs, the UI or `docker compose config` output produced by the Make targets.

---

## Commands

The everyday loop:

```bash
make up       # build and start the stack, wait until it is healthy
make logs     # follow the logs
make eval     # replay the evaluation scenarios and write a report to reports/
make check    # lint and unit tests, the fast gate before a commit
make down     # stop everything, keep the data
```

### Run the stack

| Command | What it does | Plain command |
| --- | --- | --- |
| `make up` | Build and start everything in the background and wait until it is healthy | `docker compose up --build -d --wait` |
| `make up-dev` | Same as `make up`, plus the fixed development ports of `compose.dev.yaml` | `docker compose -f compose.yaml -f compose.dev.yaml up --build -d --wait` |
| `make logs` | Follow the logs | `docker compose logs -f --tail=200` |
| `make ps` | Show the state of every service | `docker compose ps` |
| `make down` | Stop everything, keep the data | `docker compose down --remove-orphans` |
| `make reset` | Stop and delete volumes; the next `make up` re-ingests | `docker compose down -v --remove-orphans` |
| `make reset-db` | Stop and delete only the database volume; the model cache stays, so nothing is downloaded again | `docker compose down --remove-orphans && docker volume rm fault-diagnosis-poc_pgdata` |
| `make fetch-dataset` | Download MetroPT-3 into `data/metropt3/` and verify it, without starting the stack | — |
| `make fixtures` | Cut the MetroPT-3 slices for the faster replay and the tests into `data/fixtures/metropt3/` | — |

### Develop, test and check

| Command | What it does | Plain command |
| --- | --- | --- |
| `make doctor` | Check that the toolchain is installed and current | — |
| `make install` | Install every language's dependencies from the lock files | — |
| `make test` | Unit and contract tests | `pnpm test && pnpm -r test`, `go -C services/modbus test ./...` and `uv run pytest` |
| `make lint` | Every linter and repository check: headers, ground-truth paths, variables, brands, Compose files, workflows, formatting, types, import boundaries | — |
| `make check` | Lint plus the unit tests, the fast gate before a commit or a pull request | — |
| `make test-integration` | Integration tests against real Postgres, broker and container images (Docker) | — |
| `make check-int` | `make check` plus the integration tests: database roles, broker ACL, migrations and images | — |
| `make smoke` | Compose smoke test in CI mode: its own stack on ephemeral ports, the mock decision service, the tour through the API | — |
| `make smoke-quickstart` | The quick start with the rules backend on a throw-away stack, asserted the same way | — |
| `make e2e` | Browser tour against the CI stack that `make smoke SMOKE_ARGS=--keep` leaves running (Von answered by the mock TypeSafe server, the CI slice); it does not pass on a `make up` stack | — |
| `make ci` | The full gate: lint, unit and integration tests, the init end-to-end test, REUSE, licences and the manual checks; CI runs all of it but the init end-to-end test | — |

### Evaluate

| Command | What it does | Plain command |
| --- | --- | --- |
| `make eval` | Run the evaluation scenarios and write a report to `reports/` | `pnpm --filter @fdp/eval run eval` |
| `make eval-stack` | Score the running stack from its database, read-only, and write a report to `reports/eval/` | `pnpm --filter @fdp/eval run score-stack -- --db-url postgres://eval:eval@localhost:5432/fdp` |
| `make eval-sweep` | Choose Von's thresholds as pre-registered: replay the tuning scenarios from recorded Von answers, every resample, and re-gate them over the grid | `pnpm --filter @fdp/eval run sweep -- --preregistered` |
| `make smoke-live` | Opt-in: one Von and one LLM decision through the stack with the keys in `.env` (paid calls) | — |

### Manual and contracts

| Command | What it does | Plain command |
| --- | --- | --- |
| `make manual` | Rebuild the manual PDFs from `manual/spec/` in the pinned container (development only) | `docker build -f tools/manual-build/Dockerfile -t fdp-manual-build:local .`, then `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -e SOURCE_DATE_EPOCH=1767225600 fdp-manual-build:local build` |
| `make check-manual` | Run the acceptance checks of the manual and write `reports/manual-check.*` | — |
| `make generate` | Regenerate the contract artefacts: types, validators and the register map | — |

`make help` lists every target with its description.

---

## Repository layout

| Path | What lives there |
| --- | --- |
| `apps/frontend` | React + shadcn/ui dashboard |
| `apps/backend` | Node.js: detection, decisions, tickets, WebSocket API |
| `services/modbus` | Go: Modbus TCP emulator and MQTT gateway |
| `tools/init` | Python: dataset download, PDF ingestion, embeddings |
| `tools/manual-build` | Python: YAML to PDF for the fictional manual |
| `tools/eval` | Evaluation harness: replays scenarios and scores them against ground truth |
| `tools/repo-checks`, `tools/blocklist` | Repository checks (SPDX headers, variables, licences, commits) and the brand blocklist scanner |
| `packages/contracts` | Register map, MQTT topics, JSON Schemas |
| `packages/ground-truth` | Labels: failure windows, presets, injections; read by `tools/eval` and by the simulator that injects them, which publishes them on the `gt/` topics for the backend's read-only overlay |
| `packages/db-migrate` | Migration runner |
| `db/migrations` | Plain-SQL migrations, applied by init |
| `manual/spec` | Source of truth for the manual |
| `data/` | Manual PDFs (committed) and MetroPT-3 (downloaded) |
| `data/fixtures` | Slice definitions and hashes; `make fixtures` cuts the CSVs into the gitignored `data/fixtures/metropt3/` |
| `infra/mosquitto` | Broker image, ACL and credentials |
| `infra/postgres` | Database roles |
| `compose*.yaml` | The stack, with its development and CI overrides |
| `scripts/` | Smoke test, repo checks |
| `docs/` | The guides listed under [Documentation](#documentation) and the README screenshots |

---

## Data and the manual

**The manual** describes a fictional compressed-air unit: an oil-injected screw compressor with a twin-tower dryer. It is generated from `manual/spec/*.yaml`, and both PDF variants are committed in `data/manual/`. `make manual-scanned` also writes a skewed, noisy, image-only copy for testing OCR, `data/manual/cau-7-scanned.pdf`, which is not committed.

**MetroPT-3** is real telemetry from the air production unit of a metro train. init downloads it from `METROPT_URL` into `data/metropt3/` and checks it against the committed `data/SHA256SUMS`. By default that is the UCI zip, from which init extracts the CSV. To get it by hand, run `make fetch-dataset` or download it from the [UCI page](https://archive.ics.uci.edu/dataset/791/metropt+3+dataset), then drop the CSV in `data/metropt3/`.

The repository holds no MetroPT-3 rows: `data/fixtures/metropt3-slices.json` defines the slices and their hashes, and `make fixtures` cuts them from the verified download into the gitignored `data/fixtures/metropt3/` ([`data/fixtures/README.md`](data/fixtures/README.md)). `data/SHA256SUMS` lists the hashes init and `make fixtures` verify: the CSV, the UCI zip and every cut slice.

**Your own manual** goes in `data/byo-manual/`, which Git ignores. Set `MANUAL_PATH`, then run `make reset && make up`. Only use manuals you are allowed to use.

More in [docs/manual.md](docs/manual.md), [docs/dataset.md](docs/dataset.md) and, for the replay and the fault injections, [docs/simulation.md](docs/simulation.md).

---

## Security and privacy

- **Read-only.** The diagnosis reads telemetry and raises alerts; it never writes to the machine and is not a safety function. The only commands on the broker are the simulation controls (play, speed, jump, inject, reset), which travel under their own broker credential.
- **What leaves the stack.** With the rules backend, decisions are computed inside the stack and nothing is sent to a decision service. With Von or the LLM backend, each decision sends one request that describes the symptom in words and lists the candidate faults; raw telemetry is never sent. With `LLM_API_KEY` set, init also sends text extracted from the manual to the LLM, one request per ingest.
- **Secrets.** Only `TYPESAFE_API_KEY` and `LLM_API_KEY` are secrets; [Configuration](#configuration) says where they go and where they never appear.
- **Exposure.** The UI and the API have no authentication, and the database and broker passwords are non-secret PoC defaults: keep the published ports on a machine or network you trust. Anonymous MQTT clients can only read telemetry, status, events, decisions and alerts.

The threat model and its limits: [docs/security.md](docs/security.md).

---

## Troubleshooting

- **Dataset download fails:** point `METROPT_URL` at another copy, or place the CSV in `data/metropt3/` by hand. init checks the hash either way.
- **Port already in use:** change `UI_PORT`, `MQTT_PORT` or `MODBUS_PORT` in `.env`.
- **Decisions say "rules":** add `TYPESAFE_API_KEY` to `.env` and run `make up` again.
- **Start from scratch:** `make reset`. `make reset-db` drops only the database and keeps the downloaded model.
- **`make up` stops with an init error:** read `make logs`; the exit code names the step (2 configuration, 3 dependency wait, 4 migrations, 5 dataset, 6 manual, 7 model, 8 database). A hash mismatch on a migration file after pulling changes means the database was created from an older branch: `make reset-db`, then `make up`.
- **Changed a password in `.env` after the first start:** Postgres creates its roles once, on an empty volume, so run `make reset-db` and `make up` after changing a database password; the broker picks up its passwords on the next `make up`.
- **Files under `data/` owned by root (Linux):** init runs as root to write the bind mounts; `sudo chown -R "$USER" data reports` gives them back.
- **Slow first start:** image builds, the dataset and the model download; later runs reuse the volumes and the Docker cache. When `make up` gives up while init is still downloading, it says so: run `make logs`, then `make up` again (downloads resume).
- **Running several copies** (for example CI and local): give each copy its own project name and ephemeral ports, as in `UI_PORT=0 MQTT_PORT=0 MODBUS_PORT=0 docker compose -p demo2 up --build -d --wait`, then find its UI with `docker compose -p demo2 port frontend 8080`.

---

## Documentation

The guides below go deeper than this page.

| Guide | What it covers |
| --- | --- |
| [Architecture](docs/architecture.md) | The seven services, how data flows between them, the contracts they share and how ground truth stays out of the diagnosis |
| [Decision backends](docs/decision-backends.md) | The questions Von answers, the LLM and rules backends, the confidence gate, episodes and the cost ledger |
| [Detection rules](docs/detection.md) | The 16 rules, their windows and baselines, and how to tune or switch them off |
| [Simulation and fault injection](docs/simulation.md) | The emulated Modbus device, the replay clock, the jump presets and the injection model |
| [The manual and the fault catalog](docs/manual.md) | The fictional CAU-7 manual, how it is built, how init extracts the catalog and how to bring your own manual |
| [Dataset](docs/dataset.md) | MetroPT-3, the failure table, the fixture slices and the hashes that pin them |
| [Evaluation](docs/evaluation.md) | Scenarios, profiles, metrics, live and recorded runs, and how to read a report |
| [API and topics](docs/api.md) | REST routes, WebSocket frames, MQTT topics and the broker ACL |
| [Security model](docs/security.md) | What the stack exposes, what leaves it and how credentials are handled |
| [Development](docs/development.md) | Toolchain, workspace layout, tests, the three gate levels and the conventions |

Project: [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Status and limitations

Fault Diagnosis PoC is a proof of concept, released as `0.4.0`. What works end to end: init builds the fault catalog and the retrieval index from the bundled manual, the simulator replays MetroPT-3 and injects faults, detection raises suspect events, each of the three decision backends answers them, the gate turns the answers into tickets, review items and log lines, and the dashboard, the API and the evaluation harness show and score all of it. `make ci` runs the whole gate on one machine.

Known limitations:

- **The quick start opens no review item.** With the rules backend, the decision on the 5 June 2020 leak is gated to `log`: its confidence stays below the review threshold of 0.60, so step 4 of the [tour](#try-it-in-five-minutes) shows the decision but no ticket. `make smoke-quickstart` exits 3 at that check. The thresholds were not lowered to pass it.
- **The rules backend misses the recorded failures.** On the whole MetroPT-3 recording it catches none of the four failures: no ticket or review item inside a failure window names its air leak (in-sample; see [Results](#results-the-rules-only-baseline)).
- **Von's results are not published.** Von was evaluated; its figures stay unpublished pending the vendor's terms. Its configuration is public: model `von-1.13.0`, gate pair 0.65 / 0.85, persistence of one simulated minute.
- **Figures are in-sample.** Design decisions were made after the in-sample results had been seen, so every figure from the recording is in-sample. The held-out set is the one clean measurement.
- **Not for production.** The UI and the API have no authentication, and the credentials are non-secret defaults (see [Security and privacy](#security-and-privacy)).

The [CHANGELOG](CHANGELOG.md) lists what each release added and its known limitations.

---

## Contributing

Issues and pull requests are welcome; open an issue first for larger changes. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the ground rules, the checks to run before a pull request (`make check`, and `make eval` when you touch the diagnosis), Conventional Commits and the SPDX headers new files carry. Never commit `data/metropt3`, keys, real manuals, brand names or model codes. Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes, never in a public issue. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). The toolchain, the tests and the gate levels are in [docs/development.md](docs/development.md).

---

## License and credits

Copyright 2026 Meddle S.r.l. Code and configuration are licensed under [Apache-2.0](LICENSE); the manual, the fault catalog, synthetic data and the documentation under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); trivial configuration and lock files under CC0-1.0. Third-party material keeps its own holders and licences, credited below and in [NOTICE](NOTICE); [REUSE.toml](REUSE.toml) and the SPDX headers map every file to its licence.

- MetroPT-3: Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021). *MetroPT-3 Dataset*. UCI Machine Learning Repository. https://doi.org/10.24432/C5VW3R. Licensed CC BY 4.0 and used unchanged: init downloads it, and the repository contains none of its rows, not even the slices `make fixtures` cuts into `data/fixtures/metropt3/`. The statistics derived from it (the normal bands the manual PDFs and the fault catalog print, the first-month statistics and the failure table) carry this credit too.
- Dashboard screenshots (`docs/img/`): CC BY 4.0. Their charts draw replayed MetroPT-3 rows, so they carry the credit above too.
- Fonts: IBM Plex Sans and IBM Plex Mono, Copyright 2017 IBM Corp., SIL OFL 1.1.
- UI components: shadcn/ui component sources, Copyright 2023 shadcn, MIT.
- Stop words: the Snowball english stop word list the backend's search drops, Copyright 2001 Dr Martin Porter and 2002 Richard Boulton, BSD-3-Clause.
- Von is a third-party service by TypeSafe AI. Its terms apply, and you need your own key.

## Disclaimer

This is a proof of concept. The machine and its manual are fictional: do not use them to operate or maintain real equipment. The system only reads data and raises alerts; it is not a safety function.

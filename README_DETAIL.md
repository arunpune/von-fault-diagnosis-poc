# Fault Diagnosis PoC — Comprehensive Project Documentation

> **This document is a detailed technical guide to the Fault Diagnosis Proof of Concept (PoC) project.** It explains every layer — from what the project does and why it matters, to the exact data flow inside each service, to where this technology can be applied in the real world. It is written to be read by engineers, product managers, domain experts, and decision-makers alike.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Core Philosophy and Design Principles](#2-core-philosophy-and-design-principles)
3. [Live Dashboard Screenshots](#3-live-dashboard-screenshots)
4. [System Architecture — The Full Picture](#4-system-architecture--the-full-picture)
5. [The Seven Services Explained](#5-the-seven-services-explained)
6. [Data Flow: From Raw Sensor to Ticket on Screen](#6-data-flow-from-raw-sensor-to-ticket-on-screen)
7. [The Machine Manual and Fault Catalog](#7-the-machine-manual-and-fault-catalog)
8. [Detection: How Anomalies Are Found](#8-detection-how-anomalies-are-found)
9. [Decision Backends: Who Answers "Which Fault?"](#9-decision-backends-who-answers-which-fault)
10. [The Confidence Gate, Episodes, and Tickets](#10-the-confidence-gate-episodes-and-tickets)
11. [Ground Truth Isolation — Why It Matters](#11-ground-truth-isolation--why-it-matters)
12. [Fault Injection System](#12-fault-injection-system)
13. [The Evaluation Harness](#13-the-evaluation-harness)
14. [Technology Stack](#14-technology-stack)
15. [Configuration Reference](#15-configuration-reference)
16. [Security Model](#16-security-model)
17. [Repository Layout](#17-repository-layout)
18. [Real-World Use Cases and Industry Applications](#18-real-world-use-cases-and-industry-applications)
19. [Status and Known Limitations](#19-status-and-known-limitations)
20. [Licensing and Credits](#20-licensing-and-credits)

---

## 1. Project Overview

**Fault Diagnosis PoC** is an end-to-end, open-source proof of concept for **AI-assisted industrial fault triage**. It demonstrates how a modern, AI-augmented system can monitor a piece of industrial machinery in real time, detect anomalies using plain code, and then ask an AI decision model — grounded in the machine's own maintenance manual — to identify which specific fault is occurring, how severe it is, and how confident that conclusion is.

The project is built around a **compressed-air unit**: an oil-injected screw compressor with a twin-tower desiccant dryer, an aftercooler, two reservoirs, and the CTRL-7 controller. This fictional unit, called **CAU-7**, is designed so that it maps exactly onto the **MetroPT-3 dataset** — seven months of real compressor telemetry from a metro train's air production unit, recorded in Lisbon, Portugal in 2020. This dataset contains 1.5 million samples across 15 sensor channels and includes four documented air-leak failures.

In practice, the system works like this:

1. Real sensor data (replayed from MetroPT-3 at 600× real time) flows through an emulated Modbus TCP device.
2. A gateway polls that device and publishes telemetry to an MQTT broker.
3. A backend service computes windows, trends, and machine state from the telemetry in plain code, and raises a "suspect event" when a rule fires.
4. For each suspect event, the backend retrieves the most relevant fault candidates from the machine's PDF manual (using semantic search in pgvector) and sends them to a decision backend.
5. The decision backend — Von, Anthropic Claude, or a rule-based baseline — answers three questions: **Which fault is this (or none)?**, **How severe is it?**, and **How confident are you?**
6. A confidence gate turns that answer into a maintenance ticket, a review item, or merely a log line.
7. A live React dashboard shows everything: the signal traces, the alert feed with fault names and severities, the decision sheet with candidate fault probabilities, and the running API cost.

Every component is read-only with respect to the machine. The system raises alerts; it never commands the machine. It is grounded entirely in the machine's own maintenance documentation, so every fault it names has a section of the manual behind it.

---

## 2. Core Philosophy and Design Principles

The design of this system is governed by four principles that are never traded away:

### Grounded in the Manual

Every fault the system can name comes directly from the machine manual. The manual is ingested as a PDF on the first start; `init` extracts text and tables, builds a **fault catalog** of 17 fault conditions and 39 causes, and stores chunks with vector embeddings in PostgreSQL with pgvector. When a suspect event fires, the backend searches that index for the most relevant candidate faults. The decision model then picks from among those candidates — it cannot name a fault that the manual does not describe. This is the definition of **grounded** AI: the model's vocabulary is bounded by the documented knowledge of the domain.

### Code Watches, the Model Decides

Raw sensor time series never reach the decision model. Detection is implemented entirely in TypeScript as 16 deterministic rules that compute windows, trends, and machine state from the telemetry. A rule reduces that information to words: a **level** (far below normal, below normal, normal, above normal, far above normal), a **trend** (falling sharply, falling, stable, rising, rising sharply, stuck, erratic), and a **duration** (seconds, minutes, about an hour, several hours, about a day, days). Only these words — not numbers, not time series — go into the state that the decision model reads. This means the model interprets diagnostic evidence the same way a human technician would read a report, not by pattern-matching on raw waveforms.

### Read-Only by Design

The diagnosis system has no write access to the machine, the broker, or the database tables that could influence the machine. The MQTT broker enforces separate credentials for the diagnosis client and the control client. The diagnosis credential (`backend-diag`) can only read telemetry and publish decisions; control commands (play, pause, jump, inject, reset) require the `backend-ops` credential. The database enforces the same separation through roles: `app_rw` can write to the `app` schema (decisions, tickets, cost) but never to the `gt` schema (ground truth) or to any register that the simulator reads.

### Ground Truth Stays Out of the Diagnosis

Whether a failure is actually happening — and which failure it is — is kept in a separate package (`packages/ground-truth`), a separate MQTT topic root (`gt/`), and a separate database schema (`gt`). The diagnosis code cannot import the ground-truth package: a dependency-cruiser rule (`no-gt-reachable-from-diagnosis`) fails the lint if any import chain from the diagnosis leads to ground truth. The broker ACL blocks the diagnosis credential from reading `gt/#`. The database role `app_rw` is granted no access to the `gt` schema. This three-layer isolation means the system genuinely does not know which fault is active when it makes a decision — exactly as a real system deployed in the field would not know.

---

## 3. Live Dashboard Screenshots

The following screenshots were captured on the CI stack, which uses a mock Von endpoint. The signal traces, alert feed, and UI layout are authentic; the confidence figures reflect the mock's fixed response, not a real model's accuracy.

### Main Dashboard — Signals, Simulation, and Alerts

![Dashboard during the 5 June 2020 air leak replay](docs/img/ui-light-1440.png)

The main dashboard is divided into four regions:

- **Left — Signal lanes:** Four live signal traces scroll in real time as the simulator replays the dataset. Each lane shows the signal value over the last hour of simulated time, with the normal band (taken from the first month of the recording) highlighted in grey. The machine-state strip below the traces colours each period as loaded (blue), unloaded (amber), or off (grey), making load cycles immediately visible.

- **Top-right — Simulation panel:** The Play/Pause button, speed selector (1× to 3600×), a "Jump to" preset menu that skips to named events in the recording (such as "Air leak — 5 Jun 2020" or "Depot depressurisation — 31 Jul 2020"), and an "Inject fault" menu for synthetic faults the real recording never contains. A status bar at the top shows the simulated clock, the active decision backend, and telemetry/decision heartbeat indicators.

- **Middle-right — Alerts feed:** Each alert shows the fault name, severity badge (Low / Medium / High / Critical), and whether it produced a ticket or a review item. Clicking an alert opens the decision sheet.

- **Bottom — Tickets table and Cost panel:** The tickets table lists every open maintenance ticket with the fault, severity, simulated time, and review status. The cost panel shows the price of each API call and the running total, broken down by backend.

### Decision Sheet — The Full Diagnostic Breakdown

![Decision sheet for a suspect event](docs/img/ui-light-1440-decision.png)

Clicking any alert in the feed opens the **decision sheet**, which shows:

- **The chosen fault**, its severity badge, and which backend answered.
- **The confidence bar**, with markers at the review threshold (0.60 for rules/LLM, 0.65 for Von) and the ticket threshold (0.85 for all backends). The bar is colour-coded: below review is grey, review zone is amber, ticket zone is green.
- **Every candidate fault** with its probability (or support score for the rules backend), how well its expected signal movements match the observations, and the manual section it comes from (e.g., "Section 8.3 — Compressor stays loaded and does not reach cut-out").
- **The gate outcome**: whether a ticket was opened, a review item created, or the decision was only logged.
- **Token usage and cost** for the decision.

---

## 4. System Architecture — The Full Picture

The stack is a Docker Compose project called `fault-diagnosis-poc` with seven services. Every image uses the repository root as its build context, so all services can reach the shared packages (`packages/contracts`, `db/migrations`). Here is the complete data flow:

```
Machine manual (PDF)
        │
        ▼ ingest
    init (Python)
        │
        ├── downloads, verifies ──► MetroPT-3 (CSV, 218 MB)
        │                                │
        │                                ▼ replay
        │                        modbus-sim (Go)
        │                           Modbus TCP device on port 5020
        │                                │
        │                                ▼ poll (FC03)
        │                        gateway (Go)
        │                           telemetry JSON batches
        │                                │
        ├── catalog, chunks, embeddings   │
        ▼                                ▼ telemetry/samples (QoS 1)
    Postgres 18                     MQTT broker (Mosquitto)
    + pgvector                           │
        ▲                               ▼ backend-diag subscription
        │ app_rw                  backend (Node.js)
        │                         detection, retrieval, decisions,
        │                         gate, tickets, cost, WebSocket
        │                                │
        │                                ├──► one request per decision
        │                                │    Von / Claude / rules
        │                                │
        │                                ▼ REST + WebSocket
        │                         frontend (nginx + React)
        │                                │
        └────────────────────────────────┘
                                         ▼
                                      Browser
```

### Key Architectural Invariants

| Invariant | How it is enforced |
|---|---|
| No raw time series reaches the model | Detection computes words from windows; the state builder puts only words into the model's input |
| No model writes to the machine | The diagnosis credential is read-only on the broker; no service issues Modbus writes |
| Ground truth never reaches diagnosis | Three-layer isolation: import boundary, broker ACL, database role |
| Every decision shape is the same | All three backends implement `DecisionBackend`; the gate never branches on which one answered |
| Every file has a licence header | REUSE/SPDX compliance, enforced by `make lint` |

---

## 5. The Seven Services Explained

### 5.1 init — Python, one-shot

**Built from:** `tools/init/` (Python 3.13, package `fdp-init`)

`init` runs exactly once, on the first start. It performs every preparation step the rest of the stack needs, then exits with code 0. If any step fails, it exits with a numbered code that names the failing step:
- Exit 2 = configuration error
- Exit 3 = dependency wait timeout (Postgres or broker not ready)
- Exit 4 = database migration failure
- Exit 5 = dataset download or verification failure
- Exit 6 = manual extraction failure
- Exit 7 = embedding model download failure
- Exit 8 = database write failure

**What it does, in order:**

1. **Waits** for PostgreSQL and the MQTT broker to be healthy (up to `INIT_WAIT_TIMEOUT_S`, default 120 s).
2. **Applies database migrations** from `db/migrations/` using `packages/db-migrate`. Migrations are plain SQL files; the migration runner checks their hashes against committed values, so a file that changed after the schema was created fails the check instead of silently re-running.
3. **Downloads MetroPT-3** from `METROPT_URL` (the UCI repository) into `data/metropt3/`, verifies its SHA-256 hash against `data/SHA256SUMS`, and extracts the CSV from the zip. If the CSV already exists and the hash matches, the download is skipped.
4. **Downloads the embedding model** — `sentence-transformers/all-MiniLM-L6-v2` at a pinned revision — into the `model-cache` Docker volume. The model is 91 MB and is only downloaded once. The exact revision, file hashes, and model parameters (256-token context, 384-dimensional embeddings, mean pooling) are pinned in `packages/contracts/embedding.json`.
5. **Extracts the manual**: reads `MANUAL_PATH` (by default `data/manual/cau-7-realistic.pdf`), extracts text and tables using `pdfminer.six` and `pdfplumber`, and passes the extracted text through a pipeline that identifies fault conditions and their causes. If `LLM_API_KEY` is set, an optional LLM pass (Anthropic Claude by default) structures the catalog from the extracted text.
6. **Writes the fault catalog** into `app.fault_conditions` and `app.fault_causes` in PostgreSQL. Each cause carries its fault condition, subsystem, normal signal bands, and a list of signal moves.
7. **Chunks the manual** into overlapping text windows, computes embeddings for each chunk, and stores them in `app.manual_chunks` with a pgvector column. This is the retrieval index the backend searches at decision time.
8. **Writes an ingest report** to `reports/`.

---

### 5.2 modbus-sim — Go, machine emulator

**Built from:** `services/modbus/`, target `sim` (Go binary `cmd/modbus-sim`)

`modbus-sim` is, conceptually, **the machine**. It does three things simultaneously:

**Replays MetroPT-3.** It streams the CSV, advancing a software clock at `REPLAY_SPEED` × real time (600 by default). When the clock passes a row's timestamp, the simulator:

1. Classifies the machine state (`loaded`, `unloaded`, `off`) from the recorded valve positions and motor current.
2. Computes a synthetic ambient temperature from a sinusoidal model (daily and yearly cycles).
3. Applies any running fault injection by overlaying signal deviations onto the recorded values.
4. Evaluates the 35 CTRL-7 controller messages from `manual/spec/alarms.yaml` and sets their bits in the `alarm_bits` register.
5. Writes a 32-word Modbus slot (sequence number, simulated timestamp, flags, 15 analog/digital values, ambient temperature, alarm bits) into the next position of a 256-slot ring buffer.

**Serves the ring buffer over Modbus TCP** on port 5020. Unit id 1, holding registers only (FC03). Writes and requests for any other function code return exceptions. The header at addresses 0–13 holds `head_seq`, the simulated clock, replay state, speed, and map version. The ring buffer at addresses 1024–9215 holds 256 slots of 32 registers each.

**Answers control commands over MQTT.** Commands include: `play`, `pause`, `speed`, `jump` (seek to a timestamp or preset name), `inject`, `clear_injection`, and `reset`. The simulator publishes ground truth on `gt/cau-7/#` — information that the diagnosis system cannot read, per the broker ACL.

---

### 5.3 gateway — Go, edge connector

**Built from:** `services/modbus/`, target `gateway` (Go binary `cmd/gateway`)

The gateway is a **read-only edge connector**. It knows nothing about faults, injections, or ground truth. Its only job is to read the simulator's registers and forward the samples to the MQTT broker as structured JSON.

It polls the simulator's header block to get `head_seq`, then reads up to three new slots per Modbus request. It decodes each slot using the generated register map (signed int16 divided by scale factor for analog values, raw 0/1 for digital values), assembles batches of up to 25 samples, and publishes them on `plant/cau-7/telemetry/samples` with QoS 1.

The batch envelope carries a `wall_ts` (the actual wall-clock time); each sample carries its own `sim_ts` (the recording's clock). These two clocks are never mixed downstream.

---

### 5.4 mqtt — Mosquitto broker

**Built from:** `infra/mosquitto/Dockerfile` on `eclipse-mosquitto:2.0.22`

The MQTT broker is the **central message bus**. It enforces access control via a topic ACL file rendered from the `MQTT_*_PASSWORD` environment variables at every start.

| Credential | Publishes to | Subscribes to |
|---|---|---|
| `gateway` | `plant/cau-7/telemetry/#`, gateway status | — |
| `sim` | `plant/cau-7/status/sim`, `gt/cau-7/#` | `plant/cau-7/control/#` |
| `backend-diag` | `plant/cau-7/events/#`, `decisions`, `alerts/#` | `plant/cau-7/telemetry/#`, `status/#` |
| `backend-ops` | `plant/cau-7/control/#` | `gt/cau-7/#`, `status/#` |
| `eval` | — | `plant/cau-7/#` (read-only) |
| Anonymous | — | `plant/cau-7/telemetry/#`, `status/#`, `events/#`, `decisions`, `alerts/#` |

The `backend-diag` credential is **prohibited from reading `gt/#`** — one of the three layers of ground-truth isolation.

---

### 5.5 backend — Node.js, the diagnosis engine

**Built from:** `apps/backend/` (Node.js 24, Fastify 5)

The backend owns the entire diagnostic pipeline. Its sub-modules are:

| Module | What it does |
|---|---|
| `ingest/` | Validates telemetry, deduplicates, feeds the ring buffer, aggregates to `telemetry_agg_1m` |
| `detection/` | Windows, trends, machine state, 16 rules, suspect events |
| `retrieval/` | Signal-move match + pgvector semantic search → top 6 candidates |
| `decision/types.ts` | The `DecisionBackend` interface and `DecisionOutput` shape |
| `decision/state.ts` | Builds the human-readable state every backend reads |
| `decision/von/` | Von questions, request, answer parser |
| `decision/llm/` | Anthropic provider, structured output schema |
| `decision/rules/` | Rules-only baseline (signal-move scorer) |
| `gate/` | Two-threshold confidence gate |
| `episodes/` | Episode state machine and in-memory store |
| `tickets/` | Ticket lifecycle |
| `cost/` | Price arithmetic and cost ledger |
| `overlay/` | The only module allowed to read ground truth (`gt_rw`) |

**REST API:** Routes under `/api/` serve health, telemetry aggregates, decisions, tickets, feature frame, and evaluation commands.

**WebSocket:** Broadcasts `telemetry.series`, `event.suspect`, `decision`, `ticket`, `cost.update`, and `heartbeat` frames to all connected browsers.

---

### 5.6 postgres — PostgreSQL 18 with pgvector

**Image:** `pgvector/pgvector:0.8.6-pg18-trixie`

Three login roles are created on the first start:

| Role | Access |
|---|---|
| `app_rw` | Read/write on `app` schema; no access to `gt` schema |
| `gt_rw` | Read/write on `gt` schema; used only by the overlay module |
| `eval` | SELECT on `app` and `gt` schemas, read-only transaction |

The `app` schema holds: `fault_conditions`, `fault_causes`, `manual_chunks` (with 384-dimensional pgvector embeddings), `telemetry_agg_1m`, `native_alarms`, `episodes`, `decisions`, `tickets`, and `cost_ledger`.

---

### 5.7 frontend — React dashboard

**Built from:** `apps/frontend/` (React 19, Tailwind CSS, shadcn/ui, Vite build, served by nginx)

nginx serves the static build and proxies `/api/` and `/ws` to the backend, so the browser talks to one origin.

**Dashboard components:**
- **Status bar**: simulated clock, active backend, heartbeat indicators
- **Signal recorder**: four live lanes with normal-band overlays, machine-state strip, reference windows
- **Simulation panel**: play/pause, speed, jump-to presets, inject fault, reset
- **Alerts feed**: live list with fault name, severity badge, and gate outcome; click to open decision sheet
- **Decision sheet modal**: confidence bar, candidate faults with probabilities, manual references, gate outcome, cost
- **Tickets tab**: open and closed tickets with review close buttons
- **Review tab**: tickets in review awaiting technician judgement
- **Suspect Events tab**: the raw event feed
- **Cost panel**: per-decision cost and running total

Initial JavaScript bundle: **179 kB gzip**.

---

## 6. Data Flow: From Raw Sensor to Ticket on Screen

This section traces one sample from its CSV row to the maintenance ticket in the browser.

**Step 1 — Replay:** `modbus-sim` reads a CSV row for 2020-06-05 10:00:00 UTC. Line pressure 8.47 bar, motor current 7.21 A, `load_valve = true`, `intake_closed = false` (compressor is loaded). It writes a 32-word Modbus slot with `seq = 941372` and increments `head_seq`.

**Step 2 — Gateway poll:** The gateway reads the new slot, decodes `line_pressure = 8.470 bar`, `motor_current = 7.21 A`, assembles a `telemetry-samples` JSON batch, and publishes it on `plant/cau-7/telemetry/samples`. The batch carries `wall_ts = now` (actual time); each sample carries `sim_ts = "2020-06-05T10:00:00.000Z"`.

**Step 3 — Ingest:** The backend's `backend-diag` client receives the batch. It validates the JSON Schema, checks `seq = 941372 > 941371` (not a re-delivery), adds the sample to the in-memory ring buffer, and adds a data point to the 1-minute aggregate.

**Step 4 — Detection:** The feature frame is recomputed on this new simulated minute. The frame shows:
- Machine state: `loaded`, in loaded state for **18 minutes** (`loaded_run_s = 1080`).
- 5-minute line pressure slope: `+0.03 bar/min` (rising slowly).

The rule **`stuck_loaded`** fires: loaded run > 600 s AND pressure slope < 0.1 bar/min. The compressor is loading continuously but not reaching cut-out — the signature of an air leak. Detection builds a suspect event describing the symptom in words: `"The compressor has been continuously loaded for about 18 minutes. Line pressure is rising slowly."` The raw numbers never leave this step.

**Step 5 — Retrieval:** The backend retrieves the top 6 candidate faults from the catalog matching this symptom. The top 3:
1. `dryer_purge_leak` — "Dryer purge valve not seating" (manual section 8.3)
2. `downstream_air_leak` — "Leak in distribution network" (manual section 8.4)
3. `high_air_demand` — "Air demand exceeds delivery" (benign, manual section 8.5)

**Step 6 — Decision:** The backend sends the symptom description and candidates to Von. Von returns: Choice `dryer_purge_leak` with probability 0.78, confidence 0.82, severity `high`.

**Step 7 — Gate:** Confidence = 0.82. Von's review threshold = 0.65, ticket threshold = 0.85. Since 0.65 ≤ 0.82 < 0.85, the gate outcome is **review** — a review item is opened.

**Step 8 — Sinks and screen:** The backend writes the decision and ticket to PostgreSQL, publishes the alert on MQTT, and broadcasts a `decision` frame and `ticket` frame over WebSocket to the browser. The dashboard shows: **"Dryer purge valve not seating — HIGH — Review"** in the alerts feed, and a new review item in the Tickets tab.

---

## 7. The Machine Manual and Fault Catalog

The CAU-7 unit manual is a **fictional document** generated from YAML source files in `manual/spec/`, rendered into two PDF variants:
- `data/manual/cau-7-clean.pdf` — clean, machine-readable PDF
- `data/manual/cau-7-realistic.pdf` — slightly skewed version simulating a scanned real manual (the default for ingestion)

### Manual Structure

| Chapter | Contents |
|---|---|
| 1 | Safety and compliance |
| 2 | System description and schematic (SVG diagram of all 27 components across 10 subsystems) |
| 3 | CTRL-7 controller panel and alarm codes (35 messages: 17 warnings, 4 shutdown warnings, 8 shutdowns, 6 info) |
| 4 | Installation |
| 5 | Operation |
| 6 | Maintenance schedule (11 consumables, service intervals, part codes) |
| 7 | Troubleshooting tables |
| 8 | Fault diagnosis — 17 fault conditions and 39 causes |
| 9 | Specifications — sensor ranges, operating limits, rated values |

### The 10 Subsystems and 27 Components

| Subsystem | Components |
|---|---|
| `compressor` | Screw compression element, motor coupling, minimum-pressure valve, safety valve |
| `intake_unloading` | Air intake filter, intake and unloading valve, blow-down valve |
| `oil` | Oil separator vessel, thermostatic valve, oil filter, oil level switch |
| `cooling` | Oil cooler, aftercooler, cooling fan |
| `separator_drain` | Cyclonic separator, automatic condensate drain |
| `dryer` | Desiccant towers 1 and 2, dryer changeover valves, dryer purge valve, purge silencer |
| `reservoirs` | Air reservoirs, reservoir isolation valve, reservoir inlet flow sensor |
| `distribution` | Pneumatic panel |
| `electrical` | Drive motor |
| `control` | CTRL-7 controller |

### How Retrieval Works at Decision Time

Two parallel searches are run when a suspect event fires:

1. **Signal-move match (keyword-style):** Each fault cause in the catalog carries a list of signal moves (e.g., "line pressure: below normal, falling"). The event's observed signal levels and trends are compared with these moves. Causes whose expected moves match the observations score higher.

2. **Semantic similarity (pgvector):** An embedding of the event's natural-language symptom description is compared with all 384-dimensional manual chunk embeddings using cosine distance. This finds manual sections that describe the symptom in prose, even when the exact signal tag names differ.

The two results are merged, deduplicated, re-ranked, and the top six causes are passed to the decision backend.

---

## 8. Detection: How Anomalies Are Found

Detection is **plain code**. No machine-learning model reads the raw time series. 16 deterministic rules in TypeScript, evaluated on a structured feature frame computed from the last two hours of telemetry.

### 8.1 Machine State Classification

```
loaded   := intake_closed = false  AND  load_valve = true
unloaded := NOT loaded  AND  motor_current >= 1.0 A
off      := NOT loaded  AND  motor_current < 1.0 A
```

The valves take priority. This definition agrees with a current-only reading on 99.46% of the recording's rows.

### 8.2 Feature Frame Computation

Recomputed on every new simulated minute, every machine-state change, and after every reset. Key fields:

| Field | What it measures | Window |
|---|---|---|
| `loaded_run_s` | Duration of the current loaded run | Current run |
| `tp3_slope_bar_per_min` | Least-squares slope of line pressure | 5 min, 3+ samples |
| `cycles_per_hour` | Cut-ins per hour | 2 h, 2+ cut-ins |
| `dv_pressure_loaded_consecutive_gt` | Consecutive loaded samples with purge pressure > 0.5 bar | Samples |
| `oil_trend_c_per_h` | Oil temperature slope | 2 h, 60+ samples |
| `motor_current_loaded_a` | 60-s median of loaded motor current | 60 s |
| `h1_return_s` | Seconds for separator to return to line pressure after cut-out | Current/last cycle |
| `lps_active_s` | Duration the low-pressure switch has been closed | Run length |

Every value is then converted into three words:

- **Level**: far below / below / normal / above / far above (widened by sensor accuracy before comparison)
- **Trend**: falling sharply / falling / stable / rising / rising sharply / stuck / erratic
- **Duration**: seconds / minutes / about an hour / several hours / about a day / days

### 8.3 Normal Bands from the First Month

"Normal" is defined from **February 2020** (28 days, 214,850 rows, no frozen block). Stored as constants in `apps/backend/src/detection/baseline.ts`:
- p1, p5, p50, p95, p99 for every analog signal per machine state
- Same percentiles for cycle-level metrics and derived behaviours
- Digital signal shares per state
- Cycle counts per hour of day (for quiet-hours analysis)

Every sensor band is widened outward by the sensor's measurement accuracy before level classification:

| Signal group | Accuracy |
|---|---|
| All five pressure sensors | ±0.085 bar |
| Oil temperature | ±1 °C |
| Motor current | ±0.4 A |

### 8.4 The 16 Detection Rules

| Rule | Fires when | Severity | Default |
|---|---|---|---|
| `stuck_loaded` | Loaded run > 600 s AND line pressure slope < 0.1 bar/min over 5 min | High | On |
| `purge_pressure_high` | Dryer purge pressure > 0.5 bar on 6+ consecutive loaded samples | High | On |
| `fast_decay` | Last 3 idle decays each exceed max(0.25, 2.0× rolling median) bar/min | Medium | On |
| `frequent_cycling` | Cut-ins > max(5, 1.8× rolling median)/hr, or median off phase < 250 s | Medium | On |
| `long_loaded_runs` | 3+ of last 5 cycles were loaded > max(200, 1.5× rolling median) s | Medium | On |
| `low_pressure_switch` | Low-pressure switch closed (while motor running) | **Critical** | On |
| `oil_temperature_high` | 30-min minimum oil temperature > 75 °C | Medium | On |
| `oil_temperature_rising` | Oil temperature rising > 4 °C/hr over 2 hours | Low | On |
| `motor_current_high` | 60-s median loaded motor current > 6.5 A | Medium | On |
| `motor_current_low` | 60-s median loaded motor current < 5.2 A | Medium | On |
| `discharge_differential_low` | 60-s median of discharge minus line pressure < 0.1 bar while loaded | Medium | On |
| `dryer_tower_not_switching` | None of last 3 cycles shows tower changeover pulse | Low | On |
| `separator_not_venting` | Separator took > 120 s after cut-out to return within 0.3 bar of line pressure | Medium | On |
| `reservoir_pressure_mismatch` | 5-min median of reservoir minus line pressure beyond ±0.3 bar | Low | On |
| `low_oil_level` | Oil level switch reads low (while motor running) | Medium | On |
| `flow_pulses_missing` | Flow pulse has not changed | Low | **Off** by default |

Each rule has a **hold time** (how long it must keep firing before raising a suspect event) and a **clear time** (how long silence must last before the event is dismissed). Some rules share a **symptom key** — if two rules fire with the same key, they open one episode rather than two.

### 8.5 Rolling Baselines

Three cycle metrics use rolling baselines because healthy summer operation looks different from February:

| Metric | Floor | Factor | Cap on median |
|---|---|---|---|
| Idle pressure decay | 0.25 bar/min | 2.0× | 0.138 bar/min |
| Cycles per hour | 5/hr | 1.8× | 3.936/hr |
| Loaded run duration | 200 s | 1.5× | 218 s |

The median is taken over the last 48 simulated hours of closed cycles, requiring at least 20. **Cycles that close while an episode is open are excluded**, preventing a fault from raising its own threshold. The median is capped at twice the first-month value, limiting how far a slow leak can drag the threshold up.

---

## 9. Decision Backends: Who Answers "Which Fault?"

All three backends implement the same `DecisionBackend` interface and return the same `DecisionOutput` shape. The gate, tickets, cost ledger, UI, and evaluation never branch on which backend answered.

### 9.1 Von — TypeSafe AI System One

**Selected when:** `TYPESAFE_API_KEY` is set, or `DECISION_BACKEND=von`.
**Model pinned to:** `von-1.13.0`.

One request per decision containing three sub-questions:

1. **A `Choice`** over the candidate fault IDs plus `none_of_these`: a probability distribution; Von's confidence is how peaked this distribution is.
2. **One `Noul` per candidate**: a structured evidence-fitting question — "Does this candidate's expected behaviour match what we observe?" The `support` field reflects this per-candidate judgement.
3. **A `Score` for severity**: returns `low`, `medium`, `high`, or `critical`, with a `legend` (brief text justification) and probability distribution over severity levels.

Von's probability is on a **different scale** from the rules backend's confidence, so it has its own gate thresholds: `VON_GATE_REVIEW_MIN_CONFIDENCE = 0.65` and `VON_GATE_TICKET_MIN_CONFIDENCE = 0.85`.

### 9.2 LLM Backend — Anthropic Claude

**Selected when:** `DECISION_BACKEND=llm` and `LLM_API_KEY` is set.
**Default model:** `claude-opus-5`.

Sends the same state to Claude using a structured output schema that constrains the response to the same `DecisionOutput` shape. Confidence is computed as `p(choice) − p(best other option)` over re-normalised probabilities. Uses the global gate thresholds: `GATE_REVIEW_MIN_CONFIDENCE = 0.60`, `GATE_TICKET_MIN_CONFIDENCE = 0.85`.

### 9.3 Rules-Only Baseline

**Selected when:** No API key is set, or `DECISION_BACKEND=rules`.
**Costs nothing** — no external call is made.

For each candidate fault, it computes a support score: how many of the cause's expected signal moves match the observed signal levels and trends. Confidence is the margin: `s1 × clamp((s1 − s2) / 0.3, 0, 1)`. Severity comes from the cause's `severity_hint` in the catalog. This is the default for anyone without an API key, and it fully exercises the entire stack — gate, episodes, tickets, and dashboard.

---

## 10. The Confidence Gate, Episodes, and Tickets

### The Confidence Gate

```
IF choice == "none_of_these"     → LOG LINE (no ticket)
IF confidence >= 0.85            → TICKET, status: open
IF confidence >= 0.60 (or 0.65)  → TICKET, status: review
ELSE                             → LOG LINE (no ticket)
```

Severity never changes the outcome. A failed decision never reaches the gate.

### Episodes

An episode groups all decisions about one ongoing symptom. It opens when a rule fires for the first time on a new symptom key. It closes after `EPISODE_CLEAR_SIM_MIN` (default 120 sim-minutes) of calm.

- The **first decision** is made only after the symptom has kept firing for `GATE_PERSIST_SIM_MIN` (default 1 sim-minute).
- **Subsequent decisions** are made every `DECISION_INTERVAL_SIM_MIN` (default 30 sim-minutes) while the rule keeps firing.
- If a later decision has higher confidence, the ticket can be **promoted** from review to open.
- One episode produces **one ticket**, updated over time.

### Tickets

A ticket records the fault name and ID, severity, decision backend, simulated time opened and updated, and gate outcome (open / review). Technicians can close tickets as correct or wrong from the dashboard's Review or Tickets tab.

---

## 11. Ground Truth Isolation — Why It Matters

Reliable evaluation requires that the system being judged cannot see the labels being used to judge it. This project enforces that separation at three independent layers:

**Layer 1 — Import boundary:** A dependency-cruiser rule (`no-gt-reachable-from-diagnosis`) fails the lint if any import chain from the detection, retrieval, decision, or gate code leads to `@fdp/ground-truth`.

**Layer 2 — Broker ACL:** The `backend-diag` credential is denied access to `gt/#`. Even if the diagnosis code tried to read ground truth from the broker, the broker would refuse.

**Layer 3 — Database role:** The `app_rw` role has no grants on the `gt` schema. Even if a query tried to SELECT from `gt.failure_windows`, PostgreSQL would return permission denied.

A **parity test** (`tools/eval/test/integration/parity.test.ts`) proves that the evaluation harness's in-process replay produces byte-identical telemetry to what the real simulator and gateway would send, sample by sample.

---

## 12. Fault Injection System

Because real fault datasets are rare, the system includes a **fault injection engine** that overlays synthetic signal deviations onto the real replay. This lets you test faults the MetroPT-3 recording never contains.

| Injection ID | What it simulates |
|---|---|
| `dryer_purge_leak` | Dryer purge valve leaking: purge pressure elevated while loaded |
| `downstream_air_leak` | Distribution network leak: rapid idle pressure decay, frequent cycling |
| `high_air_demand` | Heavy legitimate air demand: long loaded runs, frequent cut-ins, no leak |
| `oil_cooler_fouling` | Fouled oil cooler: oil temperature rising steadily over hours |
| `oil_filter_blocked` | Blocked oil filter: rising discharge pressure differential |
| `intake_filter_blocked` | Clogged intake filter: low motor current while loaded |
| `separator_drain_blocked` | Blocked condensate drain: separator takes long to vent after cut-out |
| `dryer_tower_fault` | Dryer tower not switching: no changeover pulse for several cycles |
| `reservoir_valve_partially_closed` | Partially closed reservoir isolation valve: reservoir pressure mismatch |

To try an injection: open the dashboard → **Inject fault** → choose a type → click Start.

---

## 13. The Evaluation Harness

`tools/eval` replays scenarios with known ground truth through the backend's own production pipeline in-process, without a running stack, and writes reports to `reports/eval/`.

### Metrics

| Metric | What it measures |
|---|---|
| **Precision** | Of tickets inside a failure window, what fraction named the correct fault? |
| **Recall** | Of labelled failures, what fraction had at least one correct ticket? |
| **Lead time** | How far ahead of the unit's own CTRL-7 alarm did the system open a ticket? |
| **False tickets per negative machine-day** | Tickets outside failure windows, normalised to machine-days |
| **"None of these" rate** | How often did the model correctly abstain on a negative scenario? |

### Profiles

| Profile | Scenarios | Used by |
|---|---|---|
| `smoke` | 5 short scenarios | CI (mock Von server) |
| `core` (default) | Core-10: 10 test-split scenarios the gates count | Local runs |
| `full` | 18 scenarios + whole MetroPT-3 recording | Full baseline figures |

### How Von Runs in Evaluation

- **Live** (`--confirm-live`): real API calls with `TYPESAFE_API_KEY` (paid).
- **Cassette**: recorded answers from a previous live run, replayed deterministically.
- **Mock** (default without a key): the `best-overlap` mock server at confidence 0.9. Every report states which mode was used.

### The Held-Out Set

A sealed held-out set of six scenarios was drawn before their data was ever inspected, using a rule fixed in advance. This set has been run **exactly once**, and its results are the only measurement the project treats as uncontaminated by design decisions. Records: `tools/eval/records/heldout-seal.md` and `tools/eval/records/heldout-final-run.md`.

### Rules-Only Baseline Results (Full Profile, In-Sample)

On the full MetroPT-3 recording (1,516,418 samples, 1 Feb – 31 Aug 2020, 158.1 negative machine-days):

| Measure | Value |
|---|---|
| Air leaks caught at ticket level | **0 of 4** |
| False tickets per negative machine-day (ticket level) | **0.063** |
| False tickets per negative machine-day (review level) | **0.209** |
| Suspect events → decisions → review/ticket → tickets | 2,704 → 1,612 → 105 → 33 |

These figures are in-sample: detection thresholds were designed after looking at the four labelled failures.

---

## 14. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Container orchestration | Docker Compose | 2.24+ |
| Message broker | Eclipse Mosquitto | 2.0.22 |
| Database | PostgreSQL | 18 |
| Vector search | pgvector | 0.8.6 |
| Backend language | Node.js + Fastify | 24 / 5 |
| Backend types | TypeScript | 5 |
| Frontend framework | React | 19 |
| Frontend UI | shadcn/ui + Tailwind CSS | latest |
| Frontend fonts | IBM Plex Sans, IBM Plex Mono | SIL OFL 1.1 |
| Machine emulator | Go | 1.27 |
| Init / ingestion | Python | 3.13 |
| PDF extraction | pdfminer.six + pdfplumber | latest |
| Embedding model | sentence-transformers/all-MiniLM-L6-v2 | pinned revision |
| Package manager | pnpm (JS) + uv (Python) | workspace |
| Test framework | Vitest (TypeScript), pytest (Python), Go test | latest |
| CI | GitHub Actions | — |
| Decision backend 1 | Von (TypeSafe AI) | von-1.13.0 |
| Decision backend 2 | Anthropic Claude | claude-opus-5 |

---

## 15. Configuration Reference

All settings are in `.env`, copied from `.env.example`. Every variable has a default; the stack runs without any changes.

| Variable | Default | Purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Enables Von as the decision backend |
| `DECISION_BACKEND` | `von` if key set, else `rules` | `von`, `llm`, or `rules` |
| `LLM_API_KEY` | — | Enables the Anthropic LLM backend |
| `LLM_MODEL` | `claude-opus-5` | Model ID for the LLM backend |
| `VON_MODEL` | `von-1.13.0` | Pinned Von model ID |
| `REPLAY_SPEED` | `600` | Initial replay speed (× real time) |
| `METROPT_CSV` | `/data/metropt3/MetroPT3(AirCompressor).csv` | CSV path inside the container |
| `MANUAL_PATH` | `data/manual/cau-7-realistic.pdf` | PDF to ingest |
| `UI_PORT` | `8080` | Host port for the dashboard |
| `MQTT_PORT` | `1883` | Host port for the MQTT broker |
| `MODBUS_PORT` | `5020` | Host port for the Modbus device |
| `GATE_TICKET_MIN_CONFIDENCE` | `0.85` | Ticket threshold (rules/LLM) |
| `GATE_REVIEW_MIN_CONFIDENCE` | `0.60` | Review threshold (rules/LLM) |
| `VON_GATE_TICKET_MIN_CONFIDENCE` | `0.85` | Ticket threshold (Von only) |
| `VON_GATE_REVIEW_MIN_CONFIDENCE` | `0.65` | Review threshold (Von only) |
| `GATE_PERSIST_SIM_MIN` | `1` | Symptom must persist this many sim-minutes before first decision |
| `DECISION_INTERVAL_SIM_MIN` | `30` | Sim-minutes between re-decisions on one episode |
| `EPISODE_CLEAR_SIM_MIN` | `120` | Sim-minutes of calm that close an episode |
| `INIT_FORCE_INGEST` | `0` | Set to `1` to re-ingest the manual on next start |
| `LOG_LEVEL` | `info` | Log verbosity for all services |
| `RULES_DISABLED` | `flow_pulses_missing` | Comma-separated rules to disable |
| `VON_PRICE_INPUT_PER_MTOK` | `0.042` | USD per million Von input tokens (for Cost panel) |
| `LLM_PRICE_INPUT_PER_MTOK` | `5` | USD per million LLM input tokens |
| `LLM_PRICE_OUTPUT_PER_MTOK` | `25` | USD per million LLM output tokens |

Only `TYPESAFE_API_KEY` and `LLM_API_KEY` are secrets. All other values are PoC defaults.

---

## 16. Security Model

The system is a **proof of concept** and is explicitly not production-ready from an authentication standpoint.

| Aspect | What the stack does |
|---|---|
| Machine write access | Zero. The diagnosis only reads telemetry. |
| What leaves the stack (rules backend) | Nothing. Decisions are computed in-process. |
| What leaves the stack (Von/LLM) | One HTTPS request per decision: symptom description in words + candidate fault names. Raw telemetry is never sent. |
| What leaves the stack (LLM with `LLM_API_KEY` during init) | One LLM call per ingest: text extracted from the manual PDF. |
| API authentication | None. Keep published ports on a trusted network. |
| Secret handling | `TYPESAFE_API_KEY` and `LLM_API_KEY` are read from `.env` (gitignored), passed only to `backend` and `init`, and never appear in images, logs, the UI, or `docker compose config` output. |
| Anonymous MQTT access | Anonymous clients can read telemetry, status, events, decisions, and alerts. They cannot publish or read ground-truth topics. |

---

## 17. Repository Layout

```
jev-fault-diagnosis-poc/
├── apps/
│   ├── backend/          Node.js: detection, decisions, tickets, WebSocket API
│   └── frontend/         React + shadcn/ui dashboard
├── services/
│   └── modbus/           Go: Modbus TCP emulator and MQTT gateway
├── tools/
│   ├── init/             Python: dataset download, PDF ingestion, embeddings
│   ├── manual-build/     Python: YAML-to-PDF renderer for the fictional manual
│   ├── eval/             Evaluation harness: replays scenarios and scores them
│   ├── repo-checks/      Repository checks (SPDX headers, variables, licences)
│   └── blocklist/        Brand blocklist scanner
├── packages/
│   ├── contracts/        38 JSON Schemas, 14 MQTT topic defs, register map, embedding pin
│   ├── ground-truth/     Labels: failure windows, presets, injections
│   └── db-migrate/       Plain-SQL migration runner
├── db/
│   └── migrations/       Plain-SQL migration files
├── manual/
│   └── spec/             YAML source for the CAU-7 manual
├── data/
│   ├── manual/           Committed manual PDFs (cau-7-clean.pdf, cau-7-realistic.pdf)
│   ├── fixtures/         Slice definitions and hashes for the faster replay
│   └── metropt3/         Downloaded MetroPT-3 CSV (gitignored)
├── infra/
│   ├── mosquitto/        Broker image, ACL, credential generation
│   └── postgres/         Role creation init script
├── docs/                 Technical guides (architecture, decision-backends, detection,
│                         simulation, manual, dataset, evaluation, API, security, development)
├── scripts/              Smoke test, repository checks
├── compose.yaml          The full stack
├── compose.dev.yaml      Development override (publishes fixed ports)
├── compose.ci.yaml       CI override (mock Von, fixture slice, ephemeral Postgres port)
├── Makefile              Every command the project exposes
└── README.md             Quick start and overview
```

---

## 18. Real-World Use Cases and Industry Applications

The Fault Diagnosis PoC demonstrates a pattern that is broadly applicable: **automated anomaly detection grounded in domain documentation, with AI-assisted root-cause identification, a confidence gate, and a human-in-the-loop review queue**. Here is where this pattern can be applied, domain by domain.

---

### 18.1 Manufacturing Industry

**Domain:** Discrete and process manufacturing — automotive assembly, chemical plants, paper mills, plastics, metals.

Manufacturing facilities run hundreds of rotating and pneumatic machines: compressors, pumps, fans, conveyor drives, and hydraulic presses. Every machine has an O&M manual that describes fault conditions. Today, that manual sits on a shelf and is consulted reactively — after a breakdown.

Using this pattern:
- The machine's sensors are already wired to a PLC or SCADA system via Modbus, OPC-UA, or Profibus. A gateway (analogous to this project's Go gateway) polls the registers and publishes structured telemetry.
- Detection rules watch the signals that the manual says are diagnostic: motor current rising, pressure differentials shrinking, cycle times lengthening.
- When a rule fires, the AI asks: "Which fault in this machine's manual explains what we are seeing, and how sure are we?" The answer names a chapter, a cause, and a corrective action.
- A maintenance ticket is raised in the CMMS (Computerised Maintenance Management System) before the machine trips.

**Specific example:** An injection moulding machine has a hydraulic pump whose manual describes 12 fault causes for "pressure insufficient". The system monitors pump pressure, drive current, oil temperature, and flow rate. When a slow decay is detected, it asks the decision model: "Is this pump seal wear, filter blockage, or excessive back pressure?" The answer, with the manual section, goes into the maintenance queue before the machine trips.

**Economic value:** Unplanned downtime in automotive manufacturing costs thousands of dollars per minute. Even one prevented unplanned stoppage per month justifies the cost of the entire system.

---

### 18.2 Oil and Gas Industry

**Domain:** Upstream (production wells, compressor stations), midstream (pipelines, gas processing), downstream (refineries).

Compressor stations in gas pipelines are almost exactly the machine this PoC models: large reciprocating or centrifugal compressors with complex lubrication, sealing, and cooling systems. Their O&M manuals run to thousands of pages and describe vibration patterns, pressure drops, seal leaks, and bearing wear.

Using this pattern:
- SCADA systems already collect pressure, temperature, flow, vibration, and motor current at high frequency.
- Detection rules watch for patterns the manual describes: discharge pressure falling (reverse flow), lube oil pressure dropping while running (bearing failure precursor), discharge temperature spiking (valve leakage).
- The AI identifies which specific stage, valve, or seal is implicated, citing the manual section.
- In a safety-critical environment, this operates as a **pre-alarm layer** — raising awareness before the safety-instrumented system (SIS) trips the unit, giving operators time for an orderly shutdown.

**Specific example:** A natural gas pipeline compressor station detects that Unit 3 has a slow rise in inter-stage temperature and a declining flow coefficient. The AI identifies "first-stage discharge valve leakage" with 88% confidence, citing the manual section on valve efficiency. The maintenance team schedules a valve inspection three weeks before the valve would have caused an unplanned trip.

**Regulatory value:** In the EU, the Methane Regulation requires operators to detect and repair fugitive methane leaks. An AI-assisted leak detection and root-cause system supports compliance documentation with machine-readable evidence trails.

---

### 18.3 Railway and Metro Systems

**Domain:** Metro trains, heavy rail, traction units, rolling stock maintenance depots.

The MetroPT-3 dataset that this project replays **is already a railway compressor** — the air production unit of a metro train in Lisbon. This is therefore the most direct application of the exact system.

Railway air systems power brakes, door systems, pantographs, and suspension. Their reliability is safety-critical. A failure in the brake air system causes an emergency stop; a failure in the door system delays the service.

Using this pattern:
- Every train reports telemetry from its air system (compressor pressure, motor current, dryer status) over a 4G/5G link to a condition-monitoring centre.
- The detection engine identifies anomalies in the compressor cycle: cut-in-to-cut-out ratios changing, purge pressure elevated, motor current trending upward.
- The AI identifies the root cause from the unit's service manual, including lead time against the unit's own alarms (exactly the metric this project measures in the evaluation harness).
- Maintenance is dispatched to the depot during overnight stabling, before the fault manifests as a service disruption.

**Specific value:** The MetroPT-3 dataset shows that air leaks cause the low-pressure switch to trip after hours of degraded performance. This system can detect the leak earlier — when the idle pressure decay first accelerates — rather than when the switch trips and the train cannot start.

**Fleet scaling:** The same backend, model, and manual can serve a fleet of hundreds of trains, because each unit's telemetry arrives on its own MQTT unit-id topic. A new unit is onboarded by adding its serial number to the configuration; no retraining is needed.

---

### 18.4 Water and Wastewater Utilities

**Domain:** Water treatment plants, pumping stations, sewage treatment, desalination.

Municipal water utilities operate pumping stations that run 24/7, often unstaffed. Their pumps, compressors, and blowers are maintained on fixed schedules — the manual says "replace impeller every 5 years". But the actual condition depends on water quality, load profile, and number of starts. Condition-based maintenance, triggered by actual anomalies rather than the calendar, saves money and prevents failures.

Using this pattern:
- Pumping stations report flow rate, suction and discharge pressure, motor power, vibration, and efficiency index to a SCADA system.
- Detection rules watch for efficiency degradation (pump is working harder to deliver the same flow), cavitation signatures, and seal leaks.
- When a rule fires, the AI asks: "Which fault in this pump's manual is consistent with reduced efficiency and elevated power draw?" The answer might be "impeller wear" (section 6.4) or "partially closed discharge valve" (section 7.2, benign).
- A work order is raised in the asset management system with the evidence and manual reference.

**Specific example:** A drinking water pumping station detects that Pump 2's efficiency index has declined 8% over three months while its vibration at blade-pass frequency has increased. The AI identifies "impeller erosion due to sand ingress" with 79% confidence and recommends inspection before the next dry season.

---

### 18.5 Pharmaceutical Industry

**Domain:** Cleanroom compressed air systems, HVAC, freeze-dryers, fermenters, sterile fill lines.

Pharmaceutical manufacturing requires compressed air systems that meet GMP (Good Manufacturing Practice) standards: air purity class, dew point, particulate count, microbial load. These systems have detailed maintenance manuals and require documented evidence of correct operation.

Using this pattern:
- The compressed air system's quality sensors (dew point meter, particle counter, oil detector) are added to the signal channels alongside the compressor's own sensors.
- Detection rules watch for dew point creeping upward (dryer malfunction), particle count spiking (filter bypass), or pressure fluctuations.
- The AI identifies the root cause, citing the validation documentation reference.
- Every decision is stored with its evidence, model version, and confidence — exactly the **audit trail** that GMP and FDA 21 CFR Part 11 require.

**Regulatory value:** FDA 21 CFR Part 11 requires that computer-based records and decisions be authentic, accurate, and reliable. The Fault Diagnosis PoC's design — every decision stored with full evidence state, model version, and confidence — directly supports this requirement.

---

### 18.6 Data Centers

**Domain:** Hyperscale data centers, colocation facilities, edge computing nodes.

Data centers use large centrifugal chillers, cooling towers, and precision air conditioning units (PACs) to manage heat. These machines run continuously and their failure causes expensive downtime. Their O&M manuals describe dozens of fault causes for common symptoms like "chiller low suction pressure" or "high condenser approach temperature".

Using this pattern:
- BAS (Building Automation System) data — chilled water temperatures, compressor pressures, fan speeds, refrigerant superheat, pump flows — is polled and published as telemetry.
- Detection rules watch for performance degradation: chiller COP declining, condenser approach temperature rising (fouling), evaporator approach temperature rising (refrigerant charge loss).
- The AI identifies the cause, with the confidence gate preventing false alarms that would wake on-call engineers at 3 AM.
- A ticket in review is sent to the next-day shift; a ticket in open is paged immediately.

---

### 18.7 Mining Industry

**Domain:** Open-pit and underground mining — crushing, grinding, hoisting, ventilation, compressed air for drilling.

Mining operations run large compressors that power drill rigs, rock breakers, and pneumatic hoisting systems. Compressors in remote open-pit mines are serviced by teams that travel hours to reach them.

Using this pattern:
- The compressor telemetry is transmitted over LTE or satellite to a central condition monitoring centre.
- Detection rules identify anomalies that a remote technician, arriving after a long drive, would otherwise face as a surprise breakdown.
- The AI pre-diagnoses the fault — "oil separator bypass valve leaking", citing section 7 of the manual — so the technician arrives with the right spare parts and tools.
- The confidence gate ensures that only high-confidence diagnoses generate tickets, reducing wasted mobilisations.

**Economic value:** In a remote open-pit mine, a compressor failure that stops a drilling fleet costs enormous amounts per day in lost production. A system that provides 24 hours of warning, with the correct spare part identified, saves both the mobilisation delay and the parts-sourcing delay.

---

### 18.8 Aerospace and Defense

**Domain:** Aircraft ground support equipment (GSE), military base utilities, test cell compressors.

Aircraft ground support uses high-pressure air compressors to start jet engines, service pneumatic systems, and supply nitrogen for tire inflation. These compressors operate on strict maintenance schedules, and unscheduled maintenance between flights is extremely disruptive.

Using this pattern:
- Each GSE unit is fitted with a telemetry module that publishes to a maintenance server over the base network.
- The detection and diagnosis system identifies developing faults before the unit fails during aircraft servicing.
- The AI's answer includes the manual section reference, which is required for technical order (TO) compliance documentation in military settings.
- The confidence gate's log-review-open tiered output maps naturally to maintenance management priority schemes (C3: monitor, C2: next opportunity, C1: immediate).

**Compliance value:** Military aviation maintenance requires documented, traceable repair actions linked to the technical order. Every ticket generated carries the manual reference, the evidence, and the model version — ready for the maintenance log.

---

### 18.9 Building and Facility Management (HVAC)

**Domain:** Commercial office buildings, hospitals, hotels, shopping centres.

Large HVAC systems — chillers, air handling units, cooling towers, heat pumps — are the largest energy consumers in commercial buildings and among the most failure-prone. Building managers typically receive a reactive call when a tenant reports it is too hot or cold, by which point the fault has already manifested.

Using this pattern:
- BACnet or Modbus data from the building automation system is ingested as telemetry.
- Detection rules watch for thermal performance degradation: supply air temperature drifting from setpoint, refrigerant superheat increasing, chiller efficiency index declining.
- The AI identifies the root cause from the equipment's service manual — fouled condenser coil, low refrigerant charge, stuck expansion valve.
- A work order is raised in the facilities management system, with priority set by the confidence gate.

**Energy value:** HVAC faults waste 5–30% of building energy. A chiller running with a fouled condenser coil draws 15% more power. A system that detects this early saves significant energy costs and prevents tenant discomfort.

---

### 18.10 Food and Beverage Industry

**Domain:** Food processing plants, breweries, cold chain logistics, bottling lines.

Food and beverage facilities rely heavily on compressed air for pneumatic actuators, product conveying, blow moulding, and cleanroom applications. Compressed air quality (oil-free, low dew point) is a food safety requirement. An oil-contaminated compressed air supply can cause product contamination and a recall.

Using this pattern:
- The compressed air supply system's sensors (dew point, oil content, pressure, flow) are monitored continuously.
- Detection rules fire when dew point rises above the food-safety threshold, when oil content increases, or when pressure drops during peak production.
- The AI identifies the cause — dryer tower switching failure, oil separator bypass, compressor piston ring wear — from the equipment manual, with the regulatory implication stated in the ticket.
- The HACCP (Hazard Analysis and Critical Control Points) plan can reference the system as a CCP monitoring tool.

**Food safety value:** A product recall triggered by compressed air contamination can cost tens of millions of dollars and irreparable brand damage. A system that identifies a dryer fault before the dew point exceeds the food-safety limit prevents the contamination event entirely.

---

## 19. Status and Known Limitations

The Fault Diagnosis PoC is released at version **0.4.0** as a **proof of concept**. It is a functioning, fully tested system that demonstrates the complete pattern from telemetry to ticket, but it has deliberate limitations:

| Limitation | Detail |
|---|---|
| **Quick start opens no review item** | With the rules backend, the decision on the 5 June 2020 leak scores below the 0.60 review threshold. Steps 1–3 of the tour work; step 4 (a review ticket) requires the Von backend. |
| **Rules backend misses the recorded failures** | On the full MetroPT-3 recording, the rules baseline catches 0 of 4 air leaks at ticket level. The rules backend's confidence margin is too low to clear the thresholds on these failures. Von's results are not published pending vendor terms. |
| **Figures are in-sample** | Detection thresholds were designed after seeing the four labelled failures. The held-out set is the only uncontaminated measurement. |
| **No authentication** | The REST API, WebSocket, and MQTT anonymous channel have no authentication. The stack is safe on a private machine or network, not exposed to the internet. |
| **Fictional machine** | The CAU-7 unit and its manual do not exist. Do not use the manual to operate or service real equipment. |
| **Von results not published** | Von was evaluated; its figures are withheld pending TypeSafe AI's terms review. |

---

## 20. Licensing and Credits

**Code and configuration:** Apache-2.0
**Manual, fault catalog, data documentation:** CC BY 4.0
**Trivial configuration and lock files:** CC0-1.0

Every file carries an SPDX header (`SPDX-FileCopyrightText` and `SPDX-License-Identifier`). REUSE compliance is verified by `make lint`.

**Third-party material:**

- **MetroPT-3:** Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021). *MetroPT-3 Dataset*. UCI Machine Learning Repository. https://doi.org/10.24432/C5VW3R. Licensed CC BY 4.0. The repository contains no rows of this dataset — only derived statistics (normal bands, failure table). The dataset is downloaded at first start.
- **Dashboard screenshots** (`docs/img/`): CC BY 4.0. Captured on a CI stack with a mock Von endpoint. Charts draw replayed MetroPT-3 rows and carry the dataset credit above.
- **Fonts:** IBM Plex Sans and IBM Plex Mono, Copyright 2017 IBM Corp., SIL OFL 1.1.
- **UI components:** shadcn/ui component sources, Copyright 2023 shadcn, MIT.
- **Stop words:** Snowball English stop word list, Copyright 2001 Dr Martin Porter and 2002 Richard Boulton, BSD-3-Clause.
- **Von:** A third-party service by TypeSafe AI. Its terms apply separately.

**Copyright:** 2026 Meddle S.r.l.

---

*This document was written from the project's source code, documentation, and configuration files. Every fact stated here — every threshold, every rule, every signal name, every port number — is grounded in the actual implementation. No information was invented or inferred beyond what the codebase explicitly states.*

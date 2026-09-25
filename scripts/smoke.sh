#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The Compose smoke test: build every image, start the stack, and walk the
# README tour through the API — health, telemetry, broker isolation, the F3
# jump, a decision and its ticket, the oil-cooler injection — asserting each
# step. Three modes:
#
#   ci          compose.yaml + compose.ci.yaml (fixture slice, mock TypeSafe
#               server with MOCK_ANSWER_POLICY=best-overlap), a unique project
#               and ephemeral ports; the backend is jev against the mock.
#               `make smoke`.
#   quickstart  the README path with the rules backend (no key). In CI it runs
#               the README commands in the current clone; anywhere else it
#               works on a copy of .env.example, a random project and
#               ephemeral ports, and never touches .env or a running demo.
#               `make smoke-quickstart`.
#   live        compose.yaml with the ONE authoritative .env named by ENV_FILE:
#               a jev phase, then an llm phase. `make smoke-live`.
#
# Only docker and python3 are needed on the host. Every HTTP call and every
# look inside a JSON body is done by the Python program embedded below
# (`python3 -c`), and mosquitto_sub runs in a helper container on the
# project's network. The script never prints an environment value, never runs
# a Compose command that renders the configuration, and never reads a key: in
# live mode it checks that the two keys are present with `grep -q` and lets
# Compose read the file itself.
#
# Every assertion prints `ok <step>` or `FAIL <step>: <detail>`. The report
# directory receives summary.json (no environment values, no headers), ui-url
# and project, plus logs.txt on failure or with --keep; --keep also writes
# reports/smoke/{ui-url,project,db-url-eval} for `make e2e` and
# `make eval-stack`.
#
# Exit codes: 0 pass; 1 assertion failed; 2 the stack did not come up (or a
# precondition failed); 3 a decision was made but no ticket opened where one
# is a MUST; 4 usage error; 5 live mode without its keys.

set -euo pipefail

EXIT_ASSERTION=1
EXIT_STACK=2
EXIT_NO_TICKET=3
EXIT_USAGE=4
EXIT_KEYS=5

INVOKED_FROM="$(pwd)"
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

# The broker image the helper subscriber runs in: the pinned base of the
# broker itself.
HELPER_IMAGE=eclipse-mosquitto:2.0.22
TELEMETRY_TOPIC=plant/cau-7/telemetry/samples
FIXTURE_CSV=/data/fixtures/metropt3/ci-slice.csv
FIXTURE_HOST_PATH=data/fixtures/metropt3/ci-slice.csv
FAULTS_YAML=manual/spec/faults.yaml

# The README tour. The F3 preset lands at 06:00 on 5 June;
# the leak starts at 09:48 and keeps the unit loaded until 13:54, so a replay
# paused at 10:45 has shown about an hour of the symptom and still holds its
# ticket open: nothing after the pause can resolve it.
F3_PRESET=f3_air_leak_jun05
F3_DAY=2020-06-05
F3_PAUSE_AT=2020-06-05T10:45:00.000Z
F3_TOP_FAULT=dryer_purge_leak
# Sim seconds from the preset's landing point (06:00) to the pause point.
F3_SIM_SPAN_S=17100
BASELINE_PRESET=baseline_feb
INJECTION_ID=oil_cooler_fouling
INJECTION_FAULT=oil_cooler_fouled
# Full magnitude of the definition's range: the half-hour oil minimum clears
# the rule's limit about two sim hours in, inside the February segment of the
# fixture slice. At the default magnitude it would not before the segment ends.
INJECTION_MAGNITUDE=2
# The injection runs at the README's replay speed: 30 sim minutes (one
# re-decision) are three seconds, so the decision is seen well before the
# six-hour February segment runs out.
INJECTION_SPEED=600

JEV_MODEL_DEFAULT=jev-1.13.0
LLM_MODEL_DEFAULT=claude-opus-5
RULES_MODEL=rules-v1

# Wall-clock bounds in seconds, before FDP_TIMING_SLACK.
UP_TIMEOUT_S=900
WAIT_HELPER_TIMEOUT_S=120
HEALTH_TIMEOUT_S=120
TELEMETRY_TIMEOUT_S=60
DENIED_WINDOW_S=3
ANONYMOUS_WINDOW_S=2
SUSPECT_TIMEOUT_S=180
TICKET_TIMEOUT_S=120
OVERLAY_TIMEOUT_S=5
MIN_FREE_DISK_GB=5
MIN_COMPOSE_MINOR=24

# Options.
MODE=ci
PROJECT=""
KEEP=0
BUILD=1
DRY_RUN=0
DECISION_TIMEOUT_S=300
SPEED=3600
REPORT_DIR=""
ENV_FILE_OPTION=""

# State shared by the steps and the exit handler.
WORK=""
COMPOSE_ARGS=()
TEMP_ENV=""
UI=""
CURRENT_STEP=""
CHECK_DETAIL=""
STEP_STARTED_MS=0
STARTED_WALL_TS=""
STARTED_S=0
STACK_STARTED=0
UP_S=null
FIRST_DECISION_S=null
IN_CI=0

read -r -d '' SMOKE_PY <<'PY' || true
"""The JSON side of scripts/smoke.sh: every HTTP call and every look inside a body.

Each subcommand prints one line of detail and exits 0, or prints why it failed and exits
with the smoke script's code for that failure (1 assertion, 3 decision without ticket).
"""

import datetime
import json
import posixpath
import re
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

EXIT_ASSERTION = 1
EXIT_NO_TICKET = 3

HEX64 = re.compile(r"[0-9a-f]{64}")
# Ground-truth literals that must never travel on the telemetry wire.
FORBIDDEN_ON_WIRE = ("inject", "fault_id", "instance_id", "preset")
# Signature A: loaded without a break for half an hour, purge pressure above a bar.
LOADED_RUN_MIN_S = 1800
PURGE_HIGH_BAR = 1.0
SAMPLE_GAP_MAX_S = 60
COST_TOLERANCE_USD = 1e-9
MIN_CANDIDATES = 3
MIN_CATALOG_CAUSES = 38
PAGE_LIMIT = 200
MAX_PAGES = 100
POLL_S = 0.5
TICKET_STATUSES = ("open", "review")
# Why the quickstart's ticket MUST fails today: on the manual's catalog the rules twin
# cannot lift signature A above `log`. The MUST stays; the failure only names its known
# cause.
RULES_NO_TICKET_REASON = (
    "known failure: on the manual's catalog the rules backend cannot reach review on "
    "signature A"
)
# The CI mock's bearer token and the shape of a real language-model key. A hit is
# reported by its label: the token must not appear in any log or report, nor in this
# source, so it is spelled in two parts.
KEY_PATTERNS = (
    ("the CI mock token", re.compile(re.escape(b"fdp-ci-mock" + b"-key"))),
    ("a key-shaped value", re.compile(rb"sk-ant-[A-Za-z0-9_-]{20,}")),
)
SCAN_CHUNK = 1 << 20
SCAN_OVERLAP = 64
TAR_BLOCK = 512
GZIP_MAGIC = b"\x1f\x8b"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
LISTS = {
    "decisions": ("/api/decisions", "decision_id"),
    "events": ("/api/events/suspect", "event_id"),
}
# Loopback only: a proxy from the environment must not see these calls.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class CheckError(Exception):
    """An assertion that did not hold; `code` is the smoke script's exit code."""

    def __init__(self, detail, code=EXIT_ASSERTION):
        super().__init__(detail)
        self.code = code


class FatalCheckError(CheckError):
    """A failure that no amount of polling can turn around."""


def request(url, body=None, timeout=15):
    """(status, JSON or text) of one call, or (None, reason) when nothing answered."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method="GET" if body is None else "POST",
        headers={"accept": "application/json", "content-type": "application/json"},
    )
    try:
        with OPENER.open(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except (urllib.error.URLError, OSError) as err:
        return None, str(err)
    text = raw.decode("utf-8", "replace")
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def get_json(ui, path):
    status, body = request(ui + path)
    if status != 200 or not isinstance(body, dict):
        raise CheckError(f"GET {path} answered {status}: {str(body)[:160]}")
    return body


def all_items(ui, path):
    """Every item of a paged list, following `next_cursor`."""
    items, cursor = [], None
    separator = "&" if "?" in path else "?"
    for _ in range(MAX_PAGES):
        query = f"{path}{separator}limit={PAGE_LIMIT}"
        if cursor:
            query += "&before=" + urllib.parse.quote(cursor, safe="")
        page = get_json(ui, query)
        items.extend(page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            return items
    raise CheckError(f"GET {path} has more than {MAX_PAGES} pages")


def poll(timeout_s, probe, what, interval=POLL_S):
    """Call `probe` until it returns a value; it returns (value or None, reason)."""
    deadline = time.monotonic() + float(timeout_s)
    reason = "nothing yet"
    while True:
        try:
            value, reason = probe()
        except FatalCheckError:
            raise
        except CheckError as error:
            value, reason = None, str(error)
        except (KeyError, TypeError, ValueError) as error:
            value, reason = None, f"unexpected body ({type(error).__name__}: {error})"
        if value is not None:
            return value
        if time.monotonic() >= deadline:
            raise CheckError(f"no {what} within {float(timeout_s):g}s ({reason})")
        time.sleep(interval)


def load(path):
    with Path(path).open(encoding="utf-8") as handle:
        return json.load(handle)


def save(path, value):
    with Path(path).open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def seconds(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def cmd_field(path, dotted):
    value = json.load(sys.stdin) if path == "-" else load(path)
    for key in dotted.split("."):
        value = value[key]
    print(value if isinstance(value, str) else json.dumps(value))


def cmd_step(out, name, ok, ms, detail):
    record = {"name": name, "ok": ok == "true", "ms": int(ms), "detail": detail}
    with Path(out).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def cmd_health(ui, backend, model, timeout_s):
    def probe():
        status, text = request(ui + "/healthz")
        if status != 200 or str(text).strip() != "ok":
            return None, f"/healthz answered {status}"
        status, health = request(ui + "/api/health")
        if status != 200 or not isinstance(health, dict):
            return None, f"/api/health answered {status}"
        if health.get("status") not in ("ok", "degraded"):
            return None, f"/api/health status {health.get('status')}"
        name, got = health["backend"]["name"], health["backend"]["model"]
        if name != backend or (model and got != model):
            return None, f"backend {name}/{got}, expected {backend}/{model or 'any model'}"
        status, snapshot = request(ui + "/api/status")
        parts = ("sim", "gateway", "backend")
        if (
            status != 200
            or not isinstance(snapshot, dict)
            or not all(isinstance(snapshot.get(k), dict) for k in parts)
        ):
            return None, "/api/status lacks the sim, gateway or backend object"
        return f"{health['status']}, backend {name}/{got}, sim {snapshot['sim']['state']}", ""

    print(poll(timeout_s, probe, f"healthy stack with the {backend} backend"))


def fault_ids_of(path):
    """The fault ids of the `causes` section of faults.yaml, read without a YAML parser."""
    ids, inside = [], False
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            if re.match(r"[A-Za-z_]", line):
                inside = line.startswith("causes:")
                continue
            match = re.match(r"  - fault_id:\s*([a-z0-9_]+)\s*$", line)
            if inside and match:
                ids.append(match.group(1))
    if not ids:
        raise CheckError(f"{path} lists no causes")
    return ids


def cmd_init_report(faults_yaml):
    expected = fault_ids_of(faults_yaml)
    report = None
    for line in sys.stdin:
        if '"ingest.report"' not in line:
            continue
        try:
            candidate = json.loads(json.loads(line[line.index("{") :])["report"])
        except (ValueError, KeyError, TypeError):
            continue
        if not candidate.get("skipped"):
            report = candidate
    if report is None:
        raise CheckError("init logged no report of an ingest (a skipped run means reused volumes)")
    catalog = report.get("catalog") or {}
    causes = catalog.get("causes", 0)
    missing = sorted(set(expected) - set(catalog.get("fault_ids", [])))
    if causes < MIN_CATALOG_CAUSES:
        raise CheckError(f"the catalog has {causes} causes, expected at least {MIN_CATALOG_CAUSES}")
    if missing:
        raise CheckError(
            f"the catalog lacks {len(missing)} fault ids of faults.yaml: {', '.join(missing)}"
        )
    manual = posixpath.basename(report["manual"]["path"])
    source = catalog.get("source")
    print(
        f"{causes} causes, all {len(expected)} fault ids of faults.yaml, from {manual} ({source})"
    )


def wire_messages(path):
    """The JSON payloads of a `mosquitto_sub -v` capture."""
    payloads = []
    with Path(path).open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            _topic, _, payload = line.rstrip("\n").partition(" ")
            if payload.startswith("{"):
                payloads.append(payload)
    return payloads


def cmd_telemetry(path, minimum):
    payloads = wire_messages(path)
    with_seq = [p for p in payloads if '"seq"' in p]
    leaks = sorted({word for p in payloads for word in FORBIDDEN_ON_WIRE if word in p})
    if len(with_seq) < int(minimum):
        raise CheckError(f'{len(with_seq)} telemetry messages carry "seq", expected {minimum}')
    if leaks:
        raise CheckError(f"telemetry carries ground-truth literals: {', '.join(leaks)}")
    samples = sum(len(json.loads(p).get("samples", [])) for p in with_seq)
    print(f"{len(with_seq)} messages, {samples} samples, none with {'/'.join(FORBIDDEN_ON_WIRE)}")


def cmd_symptom(path, day):
    samples = []
    for payload in wire_messages(path):
        try:
            batch = json.loads(payload)
        except ValueError:
            continue
        samples.extend(
            s for s in batch.get("samples", []) if str(s.get("sim_ts", "")).startswith(day)
        )
    samples.sort(key=lambda s: s["sim_ts"])
    best_s, best_from, best_purge = 0.0, "", 0.0
    run_from = previous = None
    purge, started = 0.0, ""
    for sample in samples:
        at = seconds(sample["sim_ts"])
        values = sample.get("values") or {}
        loaded = values.get("intake_closed") is False and values.get("load_valve") is True
        broken = previous is not None and at - previous > SAMPLE_GAP_MAX_S
        if not loaded or broken:
            run_from = None
        if loaded:
            if run_from is None:
                run_from, purge, started = at, 0.0, sample["sim_ts"]
            purge = max(purge, float(values.get("dryer_purge_pressure") or 0.0))
            if at - run_from > best_s:
                best_s, best_from, best_purge = at - run_from, started, purge
        previous = at
    detail = (
        f"{len(samples)} samples of {day}: loaded for {best_s / 60:.0f} sim min from "
        f"{best_from[11:19] or '-'}, dryer purge pressure up to {best_purge:.2f} bar"
    )
    if best_s < LOADED_RUN_MIN_S or best_purge <= PURGE_HIGH_BAR:
        raise CheckError(f"no signature-A symptom: {detail}")
    print(detail)


def cmd_ids(ui, kind, out):
    path, key = LISTS[kind]
    ids = [item[key] for item in all_items(ui, path)]
    save(out, ids)
    print(f"{len(ids)} {kind} before the step")


def cmd_command(ui, route, args, out):
    status, body = request(f"{ui}/api/sim/{route}", {"args": json.loads(args)})
    if status != 202 or not isinstance(body, dict):
        raise CheckError(f"POST /api/sim/{route} answered {status}: {str(body)[:160]}")
    ack = body.get("ack")
    if not body.get("accepted") or not isinstance(ack, dict):
        raise CheckError(f"POST /api/sim/{route}: the simulator did not acknowledge")
    if not ack.get("ok"):
        raise CheckError(f"POST /api/sim/{route}: refused with {json.dumps(ack.get('error'))}")
    save(out, body)
    sim = ack.get("status") or {}
    print(
        f"{route} acknowledged, sim {sim.get('state')} at {sim.get('sim_ts')} x{sim.get('speed')}"
    )


def sim_status(ui):
    return get_json(ui, "/api/health").get("sim") or {}


def cmd_sim_state(ui):
    print(sim_status(ui).get("state") or "unknown")


def cmd_sim_at(ui, target, timeout_s):
    day = target[:10]

    def probe():
        at = sim_status(ui).get("sim_ts") or ""
        if at[:10] != day:
            raise FatalCheckError(f"the replay left {day} before {target[11:19]} (at {at})")
        return (at, "") if at >= target else (None, f"sim at {at}")

    at = poll(timeout_s, probe, f"replay position {target}", interval=0.1)
    print(at)


def cmd_wait_event(ui, baseline, after, timeout_s):
    known = set(load(baseline))

    def probe():
        fresh = [
            e
            for e in all_items(ui, "/api/events/suspect")
            if e["event_id"] not in known and e["sim_ts"] >= after
        ]
        if not fresh:
            return None, "no new suspect event"
        first = min(fresh, key=lambda e: e["sim_ts"])
        return f"{len(fresh)} new, the first {first['symptom_key']} at {first['sim_ts']}", ""

    print(poll(timeout_s, probe, "suspect event"))


def decision_problems(decision, model, need_output):
    problems = []
    usage, cost = decision.get("usage") or {}, decision.get("cost") or {}
    if decision.get("status") != "ok" or decision.get("error") is not None:
        problems.append(
            f"status {decision.get('status')}, error {json.dumps(decision.get('error'))}"
        )
    if decision.get("model") != model:
        problems.append(f"model {decision.get('model')}, expected {model}")
    if not HEX64.fullmatch(str(decision.get("state_digest", ""))):
        problems.append("state_digest is not 64 hex digits")
    tokens_in, tokens_out = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
    expected = (
        tokens_in * cost.get("price_input_per_mtok", 0)
        + tokens_out * cost.get("price_output_per_mtok", 0)
    ) / 1e6
    if abs(cost.get("usd", -1) - expected) > COST_TOLERANCE_USD:
        problems.append(
            f"cost {cost.get('usd')} differs from the tokens at the stated prices ({expected:.10f})"
        )
    if need_output and tokens_out <= 0:
        problems.append("no output tokens")
    cited = [
        c for c in decision.get("candidates", []) if (c.get("manual_ref") or {}).get("section")
    ]
    if len(cited) < MIN_CANDIDATES:
        problems.append(
            f"{len(cited)} candidates carry a manual section, expected at least {MIN_CANDIDATES}"
        )
    return problems


def describe(decision):
    usage, gate = decision["usage"], decision["gate"]
    return (
        f"{decision['decision_id'][:8]} {decision['backend']}/{decision['model']} "
        f"at {decision['sim_ts']}: "
        f"{decision['choice']} {decision['confidence']:.2f}, gate {gate['outcome']}, "
        f"{usage['input_tokens']}/{usage['output_tokens']} tokens, ${decision['cost']['usd']:.9f}, "
        f"{len(decision['candidates'])} candidates"
    )


def cmd_wait_decision(ui, baseline, after, before, backend, model, timeout_s, out, need_output):
    known = set(load(baseline))

    def probe():
        fresh = [
            d
            for d in all_items(ui, "/api/decisions")
            if d["decision_id"] not in known
            and d["sim_ts"] >= after
            and (not before or d["sim_ts"] < before)
        ]
        mine = [d for d in fresh if d["backend"] == backend]
        if mine:
            return min(mine, key=lambda d: (d["sim_ts"], d["wall_ts"])), ""
        others = sorted({d["backend"] for d in fresh})
        return None, f"new decisions from {', '.join(others)} only" if others else "no new decision"

    decision = poll(timeout_s, probe, f"{backend} decision")
    save(out, decision)
    problems = decision_problems(decision, model, need_output == "1")
    if problems:
        raise CheckError(f"decision {decision['decision_id']}: {'; '.join(problems)}")
    print(describe(decision))


def cmd_top(path, expected):
    decision = load(path)
    ranked = sorted(
        (decision.get("probabilities") or {}).items(), key=lambda item: (-item[1], item[0])
    )
    listing = ", ".join(f"{fault} {p:.2f}" for fault, p in ranked[:4])
    if decision.get("choice") != expected or not ranked or ranked[0][0] != expected:
        raise CheckError(f"top candidate {decision.get('choice')}, expected {expected} ({listing})")
    print(f"top candidate {expected} ({listing})")


def cmd_candidate(path, expected):
    decision = load(path)
    faults = [c["fault_id"] for c in decision.get("candidates", [])]
    if expected not in faults:
        raise CheckError(f"{expected} is not among the candidates {', '.join(faults)}")
    print(f"{expected} is among {len(faults)} candidates")


def cmd_latency(decision_path, ack_path):
    started = seconds(load(ack_path)["ack"]["wall_ts"])
    print(f"{max(0.0, seconds(load(decision_path)['wall_ts']) - started):.1f}")


def cmd_cost(ui, path):
    decision = load(path)
    summary = get_json(ui, "/api/cost")
    totals, per_backend = summary["totals"], list(summary["by_backend"].values())
    problems = []
    if abs(totals["usd"] - sum(b["usd"] for b in per_backend)) > COST_TOLERANCE_USD:
        problems.append("totals.usd differs from the sum of by_backend")
    for key in ("calls", "input_tokens", "output_tokens"):
        if totals[key] != sum(b[key] for b in per_backend):
            problems.append(f"totals.{key} differs from the sum of by_backend")
    recent = summary["recent"]
    if (
        totals["calls"] == len(recent)
        and abs(totals["usd"] - sum(r["cost_usd"] for r in recent)) > COST_TOLERANCE_USD
    ):
        problems.append("totals.usd differs from the sum of recent")
    ledger = get_json(ui, "/api/cost/ledger?limit=1000")["items"]
    row = next((r for r in ledger if r["decision_id"] == decision["decision_id"]), None)
    if row is None:
        problems.append("the decision has no ledger row")
    elif abs(row["cost_usd"] - decision["cost"]["usd"]) > COST_TOLERANCE_USD:
        problems.append(
            f"the ledger bills {row['cost_usd']}, the decision says {decision['cost']['usd']}"
        )
    if problems:
        raise CheckError("; ".join(problems))
    print(
        f"${totals['usd']:.9f} over {totals['calls']} calls, consistent; "
        "the decision's ledger row matches"
    )


def cmd_wait_ticket(ui, path, timeout_s):
    decision = load(path)
    episode = decision["episode_id"]

    def probe():
        tickets = [
            t for t in all_items(ui, "/api/tickets?status=all") if t["episode_id"] == episode
        ]
        good = [t for t in tickets if t["status"] in TICKET_STATUSES and t.get("fault_id")]
        if good:
            return good[0], ""
        return None, "episode tickets: " + (", ".join(t["status"] for t in tickets) or "none")

    try:
        ticket = poll(timeout_s, probe, "open or review ticket for the decision's episode")
    except CheckError as error:
        detail = (
            f"{error}; decision {decision['decision_id']} gate {decision['gate']['outcome']}, "
            f"confidence {decision['confidence']}, probabilities "
            f"{json.dumps(decision.get('probabilities'), sort_keys=True)}"
        )
        if decision.get("backend") == "rules":
            detail += f"; {RULES_NO_TICKET_REASON}"
        raise CheckError(detail, EXIT_NO_TICKET) from error
    ticket_id, outcome = ticket["ticket_id"][:8], decision["gate"]["outcome"]
    print(f"ticket {ticket_id} {ticket['status']} for {ticket['fault_id']} (gate {outcome})")


def active_injections(ui):
    status, body = request(ui + "/api/overlay/active")
    if status != 200 or not isinstance(body, dict):
        raise CheckError(f"GET /api/overlay/active answered {status}")
    return body.get("active", [])


def cmd_wait_active(ui, injection_id, timeout_s, out):
    def probe():
        active = active_injections(ui)
        entry = next((a for a in active if a.get("injection_id") == injection_id), None)
        return entry, f"active: {', '.join(a.get('injection_id', '?') for a in active) or 'none'}"

    entry = poll(timeout_s, probe, f"active {injection_id}", interval=0.2)
    save(out, entry)
    print(f"{injection_id} active from {entry['started_sim_ts']} to {entry['ends_sim_ts']}")


def cmd_wait_clear(ui, timeout_s):
    def probe():
        active = active_injections(ui)
        return (True, "") if not active else (None, f"{len(active)} still active")

    poll(timeout_s, probe, "empty active list", interval=0.2)
    print("no injection active")


def cmd_images(project, out):
    prefix = project + "-"
    images = {}
    for entry in json.load(sys.stdin):
        repository = entry.get("Repository", "")
        if repository.startswith(prefix) and repository not in images:
            images[repository] = {
                "service": repository[len(prefix) :],
                "image": f"{repository}:{entry.get('Tag') or 'latest'}",
                "size_bytes": entry.get("Size"),
            }
    listed = sorted(images.values(), key=lambda image: image["service"])
    if not listed:
        raise CheckError(f"no image built for project {project}")
    save(out, listed)
    for image in listed:
        print(image["image"])


class Prefixed:
    """A stream with the bytes already read put back in front."""

    def __init__(self, head, rest):
        self.head, self.rest = head, rest

    def read(self, size=-1):
        if not self.head:
            return self.rest.read(size)
        if size is None or size < 0:
            data, self.head = self.head + self.rest.read(), b""
            return data
        data, self.head = self.head[:size], self.head[size:]
        if len(data) < size:
            data += self.rest.read(size - len(data))
        return data


def is_env_file(name):
    base = posixpath.basename(name.rstrip("/"))
    return base == ".env" or (base.startswith(".env.") and base != ".env.example")


def scan_bytes(stream, where, hits):
    tail = b""
    while True:
        block = stream.read(SCAN_CHUNK)
        if not block:
            return
        data = tail + block
        for label, pattern in KEY_PATTERNS:
            if pattern.search(data):
                hits.add(f"{where}: {label}")
        tail = data[-SCAN_OVERLAP:]


def is_archive(head):
    """A tar header (POSIX or GNU magic at offset 257) or a gzip stream."""
    return (len(head) == TAR_BLOCK and head[257:262] == b"ustar") or head[:2] == GZIP_MAGIC


def scan_layer(stream, where, env_files, hits):
    with tarfile.open(fileobj=stream, mode="r|*") as layer:
        for entry in layer:
            if is_env_file(entry.name):
                env_files.append(f"{where}: {entry.name}")
            if entry.isfile():
                scan_bytes(layer.extractfile(entry), f"{where}: {entry.name}", hits)


def cmd_scan_image(image):
    """Walk a `docker save` stream: every layer's file names and every byte."""
    env_files, hits, layers = [], set(), 0
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as saved:
        for member in saved:
            if is_env_file(member.name):
                env_files.append(member.name)
            if not member.isfile():
                continue
            blob = saved.extractfile(member)
            head = blob.read(TAR_BLOCK)
            if head[:4] == ZSTD_MAGIC:
                raise CheckError(f"{image}: {member.name} is zstd-compressed and cannot be scanned")
            if is_archive(head):
                layers += 1
                scan_layer(Prefixed(head, blob), member.name, env_files, hits)
            else:
                scan_bytes(Prefixed(head, blob), member.name, hits)
    if env_files or hits:
        found = env_files[:5] + sorted(hits)[:5]
        raise CheckError(f"{image} carries an environment file or a key: {'; '.join(found)}")
    print(f"{image}: {layers} layers, no environment file, no key pattern")


def summary_of(path):
    try:
        decision = load(path)
    except (OSError, ValueError):
        return None
    return {
        "decision_id": decision.get("decision_id"),
        "backend": decision.get("backend"),
        "model": decision.get("model"),
        "sim_ts": decision.get("sim_ts"),
        "choice": decision.get("choice"),
        "confidence": decision.get("confidence"),
        "gate": (decision.get("gate") or {}).get("outcome"),
        "input_tokens": (decision.get("usage") or {}).get("input_tokens"),
        "output_tokens": (decision.get("usage") or {}).get("output_tokens"),
        "cost_usd": (decision.get("cost") or {}).get("usd"),
        "latency_ms": decision.get("latency_ms"),
    }


def cmd_summary(report, mode, project, started, finished, exit_code, timings):
    steps = []
    try:
        with Path(report, "steps.jsonl").open(encoding="utf-8") as handle:
            steps = [json.loads(line) for line in handle if line.strip()]
    except OSError:
        pass
    try:
        images = load(f"{report}/images.json")
    except (OSError, ValueError):
        images = []
    document = {
        "mode": mode,
        "project": project,
        "started_wall_ts": started,
        "finished_wall_ts": finished,
        "result": "pass" if exit_code == "0" else "fail",
        "exit_code": int(exit_code),
        "timings": json.loads(timings),
        "steps": steps,
        "decision": summary_of(f"{report}/decision.json"),
        "injection_decision": summary_of(f"{report}/injection-decision.json"),
        "images": images,
    }
    llm = summary_of(f"{report}/llm-decision.json")
    if llm is not None:
        document["llm_decision"] = llm
    save(f"{report}/summary.json", document)
    print(f"{report}/summary.json")


COMMANDS = {
    "field": cmd_field,
    "step": cmd_step,
    "health": cmd_health,
    "init-report": cmd_init_report,
    "telemetry": cmd_telemetry,
    "symptom": cmd_symptom,
    "ids": cmd_ids,
    "command": cmd_command,
    "sim-state": cmd_sim_state,
    "sim-at": cmd_sim_at,
    "wait-event": cmd_wait_event,
    "wait-decision": cmd_wait_decision,
    "top": cmd_top,
    "candidate": cmd_candidate,
    "latency": cmd_latency,
    "cost": cmd_cost,
    "wait-ticket": cmd_wait_ticket,
    "wait-active": cmd_wait_active,
    "wait-clear": cmd_wait_clear,
    "images": cmd_images,
    "scan-image": cmd_scan_image,
    "summary": cmd_summary,
}

if __name__ == "__main__":
    try:
        COMMANDS[sys.argv[1]](*sys.argv[2:])
    except CheckError as error:
        print(error)
        sys.exit(error.code)
    except (KeyError, TypeError, ValueError) as error:
        print(f"unexpected input ({type(error).__name__}: {error})")
        sys.exit(EXIT_ASSERTION)
PY

# --- output -------------------------------------------------------------------

say() {
	printf '%s\n' "smoke: $*"
}

usage() {
	cat <<'USAGE'
Usage: scripts/smoke.sh [--mode ci|quickstart|live] [--project NAME] [--keep]
                        [--no-build] [--decision-timeout S] [--speed N]
                        [--report DIR] [--env-file PATH] [--dry-run] [--help]

Builds the stack, starts it and walks the README tour through the API.

  --mode MODE            ci (default): compose.yaml + compose.ci.yaml, mock
                         decision service, jev backend, ephemeral ports.
                         quickstart: the README path, rules backend.
                         live: compose.yaml with the keys of ENV_FILE, a jev
                         phase and an llm phase.
  --project NAME         Compose project name (default: <mode>-<random>)
  --keep                 leave the stack running and write
                         reports/smoke/{ui-url,project,db-url-eval}
  --no-build             do not rebuild the images (ci and live)
  --decision-timeout S   how long to wait for a decision (300)
  --speed N              replay speed of the F3 tour (3600)
  --report DIR           report directory (reports/smoke-<timestamp>)
  --env-file PATH        the .env live mode reads (default: $ENV_FILE, else ./.env)
  --dry-run              check the preconditions, contact nothing, exit
  --help                 print this text and exit 0

Environment: ENV_FILE (live mode's .env), FDP_TIMING_SLACK (multiplies every
wall-clock bound, default 1), CI (quickstart runs the README commands in place
when it is "true").

Exit codes: 0 pass, 1 assertion failed, 2 stack did not come up, 3 decision
without the ticket that was a MUST, 4 usage error, 5 live keys missing.
USAGE
}

usage_error() {
	say "$*" >&2
	usage >&2
	exit "$EXIT_USAGE"
}

now_ms() {
	python3 -c 'import time; print(int(time.time() * 1000))'
}

utc_now() {
	date -u +%Y-%m-%dT%H:%M:%SZ
}

pyc() {
	python3 -c "$SMOKE_PY" "$@"
}

# A wall-clock bound in whole seconds, scaled by FDP_TIMING_SLACK.
bound() {
	awk -v base="$1" -v slack="${FDP_TIMING_SLACK:-1}" \
		'BEGIN { value = base * slack; if (value < 1) value = 1; printf "%d\n", value }'
}

# --- steps --------------------------------------------------------------------

step_begin() {
	CURRENT_STEP="$1"
	STEP_STARTED_MS=$(now_ms)
}

record_step() {
	local ok="$1" detail="$2" elapsed
	elapsed=$(($(now_ms) - STEP_STARTED_MS))
	if [ -n "$REPORT_DIR" ] && [ -d "$REPORT_DIR" ]; then
		pyc step "$REPORT_DIR/steps.jsonl" "$CURRENT_STEP" "$ok" "$elapsed" "$detail" || true
	fi
}

step_ok() {
	local detail="${1:-}"
	record_step true "$detail"
	if [ -n "$detail" ]; then
		printf 'ok %s (%s)\n' "$CURRENT_STEP" "$detail"
	else
		printf 'ok %s\n' "$CURRENT_STEP"
	fi
	CURRENT_STEP=""
}

step_fail() {
	local code="$1" detail="$2"
	record_step false "$detail"
	printf 'FAIL %s: %s\n' "$CURRENT_STEP" "$detail"
	CURRENT_STEP=""
	exit "$code"
}

# A finding the mode does not treat as a MUST: printed and kept in the report.
note() {
	printf 'note %s\n' "$*"
	if [ -n "$REPORT_DIR" ] && [ -d "$REPORT_DIR" ]; then
		printf '%s\n' "$*" >>"$REPORT_DIR/notes.txt"
	fi
}

# Run one embedded check; its detail line becomes the step's detail and its
# exit code the script's.
check() {
	local detail rc=0
	detail=$(pyc "$@") || rc=$?
	if [ "$rc" -ne 0 ]; then
		step_fail "$rc" "${detail:-the check failed without a message}"
	fi
	CHECK_DETAIL="$detail"
}

# --- compose ------------------------------------------------------------------

compose() {
	docker compose "${COMPOSE_ARGS[@]}" "$@"
}

# A published port as host:port on the loopback, or nothing when unpublished
# (`docker compose port` then prints ":0" and exits 0).
published() {
	local mapping port
	mapping=$(compose port "$1" "$2" 2>/dev/null | head -n 1) || return 0
	port="${mapping##*:}"
	case "$port" in
	'' | 0 | *[!0-9]*) return 0 ;;
	esac
	printf '127.0.0.1:%s\n' "$port"
}

# mosquitto_sub or mosquitto_pub in a throwaway container on the project network.
mqtt_client() {
	docker run --rm --network "${PROJECT}_default" "$HELPER_IMAGE" "$@"
}

# --- modes --------------------------------------------------------------------

expected_backend() {
	case "$MODE" in
	quickstart) echo rules ;;
	*) echo jev ;;
	esac
}

expected_model() {
	case "$MODE" in
	quickstart) echo "$RULES_MODEL" ;;
	live) env_file_value JEV_MODEL "$JEV_MODEL_DEFAULT" ;;
	*) echo "$JEV_MODEL_DEFAULT" ;;
	esac
}

# The value of a NON-SECRET setting in ENV_FILE (a model name), or the default.
# Keys are never read: this refuses any name that could hold one.
env_file_value() {
	local name="$1" fallback="$2" line value
	case "$name" in
	*_KEY | *_PASSWORD | *_TOKEN | *SECRET*)
		say "refusing to read $name from the env file" >&2
		exit "$EXIT_USAGE"
		;;
	esac
	line=$(grep -E "^${name}=" "$ENV_FILE" 2>/dev/null | tail -n 1) || true
	value="${line#*=}"
	value="${value%%#*}"
	value=$(printf '%s' "$value" | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
	printf '%s\n' "${value:-$fallback}"
}

# The names of the two keys that ENV_FILE lacks, checked with grep -q only.
missing_keys() {
	local key missing=""
	for key in TYPESAFE_API_KEY LLM_API_KEY; do
		if [ ! -f "$ENV_FILE" ] || ! grep -qE "^${key}=.+" "$ENV_FILE"; then
			missing="$missing $key"
		fi
	done
	printf '%s\n' "${missing# }"
}

# --- 1. preflight ---------------------------------------------------------------

require_tool() {
	command -v "$1" >/dev/null 2>&1 || step_fail "$EXIT_STACK" "$1 is not installed"
}

preflight() {
	step_begin preflight
	require_tool docker
	require_tool python3
	if [ "$MODE" = quickstart ]; then
		require_tool make
	fi
	if [ "$MODE" = live ]; then
		local missing
		missing=$(missing_keys)
		if [ -n "$missing" ]; then
			step_fail "$EXIT_KEYS" "keys missing in $ENV_FILE: $missing"
		fi
	elif [ ! -f "$FIXTURE_HOST_PATH" ]; then
		step_fail "$EXIT_STACK" "$FIXTURE_HOST_PATH is missing; run 'make fixtures' first"
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		step_ok "dry run: mode $MODE, project $PROJECT, ${COMPOSE_ARGS[*]}"
		return 0
	fi

	docker info >/dev/null 2>&1 || step_fail "$EXIT_STACK" "the Docker daemon is not reachable"
	local version major minor free_kb
	version=$(docker compose version --short 2>/dev/null) || step_fail "$EXIT_STACK" "docker compose is not available"
	major=$(printf '%s' "$version" | cut -d. -f1)
	minor=$(printf '%s' "$version" | cut -d. -f2)
	if [ "${major:-0}" -lt 2 ] || { [ "$major" -eq 2 ] && [ "${minor:-0}" -lt "$MIN_COMPOSE_MINOR" ]; }; then
		step_fail "$EXIT_STACK" "Compose $version is older than v2.$MIN_COMPOSE_MINOR"
	fi
	free_kb=$(df -Pk "$ROOT" | awk 'NR == 2 { print $4 }')
	if [ "$free_kb" -lt $((MIN_FREE_DISK_GB * 1024 * 1024)) ]; then
		step_fail "$EXIT_STACK" "only $((free_kb / 1024 / 1024)) GB free, need $MIN_FREE_DISK_GB"
	fi
	if ! docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1; then
		docker pull -q "$HELPER_IMAGE" >/dev/null || step_fail "$EXIT_STACK" "cannot pull $HELPER_IMAGE"
	fi
	step_ok "mode $MODE, Compose $version, $((free_kb / 1024 / 1024)) GB free"
}

# --- 2. up ------------------------------------------------------------------------

# The README commands (quickstart): in CI verbatim in this clone; elsewhere on
# a copy of .env.example under a random project with ephemeral ports.
quickstart_up() {
	local line="METROPT_CSV=$FIXTURE_CSV"
	if [ "$IN_CI" -eq 1 ]; then
		if [ -f .env ] && grep -qE '^[A-Z_]*_API_KEY=.+' .env; then
			step_fail "$EXIT_STACK" "refusing to overwrite a .env that holds a key; quickstart in CI expects a clean clone"
		fi
		cp .env.example .env || return
		printf '%s\n' "$line" >>.env || return
		make up
	else
		cp .env.example "$TEMP_ENV" || return
		printf '%s\n' "$line" >>"$TEMP_ENV" || return
		COMPOSE_PROJECT_NAME="$PROJECT" UI_PORT=0 MQTT_PORT=0 MODBUS_PORT=0 \
			make up COMPOSE="docker compose --env-file $TEMP_ENV"
	fi
}

compose_up() {
	local build_flag=""
	[ "$BUILD" -eq 1 ] && build_flag="--build"
	# shellcheck disable=SC2086 # the build flag is one word or none
	UI_PORT=0 MQTT_PORT=0 MODBUS_PORT=0 \
		compose up $build_flag -d --wait --wait-timeout "$(bound "$UP_TIMEOUT_S")"
}

stack_up() {
	step_begin up
	local started rc=0
	started=$(date +%s)
	STACK_STARTED=1
	if [ "$MODE" = quickstart ]; then
		quickstart_up || rc=$?
	else
		compose_up || rc=$?
	fi
	UP_S=$(($(date +%s) - started))
	[ "$rc" -eq 0 ] || step_fail "$EXIT_STACK" "the stack did not come up (exit $rc) after ${UP_S}s"
	step_ok "${UP_S}s"

	step_begin wait
	rc=0
	"$ROOT/scripts/ops/wait-for-stack.sh" --timeout "$WAIT_HELPER_TIMEOUT_S" "$PROJECT" >"$WORK/wait.log" 2>&1 || rc=$?
	[ "$rc" -eq 0 ] || step_fail "$EXIT_STACK" "$(tail -n 1 "$WORK/wait.log")"
	step_ok "$(tail -n 1 "$WORK/wait.log" | sed 's/^wait-for-stack: //')"
}

# --- 3. ports -----------------------------------------------------------------------

discover_ports() {
	step_begin ports
	local ui_port mqtt_port
	ui_port=$(published frontend 8080)
	mqtt_port=$(published mqtt 1883)
	[ -n "$ui_port" ] || step_fail "$EXIT_STACK" "the frontend publishes no port"
	UI="http://$ui_port"
	printf '%s\n' "$UI" >"$REPORT_DIR/ui-url"
	printf '%s\n' "$PROJECT" >"$REPORT_DIR/project"
	step_ok "ui $UI, mqtt ${mqtt_port:-unpublished}"
}

# --- 4. init report and health -------------------------------------------------------

init_report() {
	step_begin init-report
	compose logs --no-color --no-log-prefix init >"$WORK/init.log" 2>&1 ||
		step_fail "$EXIT_ASSERTION" "cannot read the init logs"
	check init-report "$FAULTS_YAML" <"$WORK/init.log"
	step_ok "$CHECK_DETAIL"
}

health() {
	step_begin health
	check health "$UI" "$(expected_backend)" "$(expected_model)" "$(bound "$HEALTH_TIMEOUT_S")"
	step_ok "$CHECK_DETAIL"
}

# --- 5. telemetry ----------------------------------------------------------------------

# Three telemetry messages off the wire, free of ground-truth literals.
sample_telemetry() {
	local out="$1" rc=0
	mqtt_client mosquitto_sub -h mqtt -t "$TELEMETRY_TOPIC" -C 3 -W "$(bound "$TELEMETRY_TIMEOUT_S")" -v \
		>"$out" 2>&1 || rc=$?
	[ "$rc" -eq 0 ] || step_fail "$EXIT_ASSERTION" "mosquitto_sub exited $rc: $(tail -n 1 "$out")"
	check telemetry "$out" 3
}

telemetry() {
	step_begin telemetry
	local state was_playing=1
	state=$(pyc sim-state "$UI") || step_fail "$EXIT_ASSERTION" "$state"
	if [ "$state" != playing ]; then
		# The README: the replay is paused at boot until someone presses Play.
		was_playing=0
		check command "$UI" play '{}' "$WORK/play-boot.json"
	fi
	sample_telemetry "$WORK/telemetry.txt"
	local detail="$CHECK_DETAIL"
	if [ "$was_playing" -eq 0 ]; then
		check command "$UI" pause '{}' "$WORK/pause-boot.json"
	fi
	step_ok "$detail"
}

# --- 6. broker isolation (ci and quickstart: default passwords only) -------------------

isolation() {
	step_begin isolation
	local out="$WORK/isolation.txt" denied anonymous rc
	denied=$(bound "$DENIED_WINDOW_S")
	anonymous=$(bound "$ANONYMOUS_WINDOW_S")

	# A denied subscription is granted and never delivers:
	# mosquitto_sub times out with exit 27 and prints nothing.
	rc=0
	mqtt_client mosquitto_sub -h mqtt -u backend-diag -P backend-diag -t 'gt/#' -C 1 -W "$denied" -v >"$out" 2>&1 || rc=$?
	if [ "$rc" -ne 27 ] || grep -q '^gt/' "$out"; then
		step_fail "$EXIT_ASSERTION" "backend-diag read gt/# (mosquitto_sub exit $rc, expected 27)"
	fi
	rc=0
	mqtt_client mosquitto_sub -h mqtt -t 'gt/#' -C 1 -W "$anonymous" -v >"$out" 2>&1 || rc=$?
	if [ "$rc" -ne 27 ] || grep -q '^gt/' "$out"; then
		step_fail "$EXIT_ASSERTION" "an anonymous client read gt/# (mosquitto_sub exit $rc, expected 27)"
	fi

	# The positive controls: the retained catalog reaches the two credentials
	# that may read ground truth.
	local user
	for user in backend-ops eval; do
		rc=0
		mqtt_client mosquitto_sub -h mqtt -u "$user" -P "$user" -t 'gt/#' -C 1 -W "$denied" -v >"$out" 2>&1 || rc=$?
		if [ "$rc" -ne 0 ] || ! grep -q '^gt/cau-7/catalog ' "$out"; then
			step_fail "$EXIT_ASSERTION" "$user did not receive the retained gt/cau-7/catalog (exit $rc)"
		fi
	done

	# A denied publish is refused with PUBACK reason 135 on MQTT 5.
	rc=0
	mqtt_client mosquitto_pub -h mqtt -u gateway -P gateway -t gt/cau-7/marker -m smoke -V 5 -q 1 -d >"$out" 2>&1 || rc=$?
	grep -q 'PUBACK.*RC:135' "$out" || step_fail "$EXIT_ASSERTION" "gateway's publish to gt/cau-7/marker was not refused with PUBACK 135"
	rc=0
	mqtt_client mosquitto_pub -h mqtt -t gt/cau-7/marker -m smoke -V 5 -q 1 -d >"$out" 2>&1 || rc=$?
	grep -q 'PUBACK.*RC:135' "$out" || step_fail "$EXIT_ASSERTION" "an anonymous publish to gt/cau-7/marker was not refused with PUBACK 135"

	step_ok "backend-diag and anonymous read nothing on gt/#, backend-ops and eval get the catalog, gateway and anonymous publishes get PUBACK 135"
}

# --- 7-10. the F3 tour ------------------------------------------------------------------

# mosquitto_sub says nothing when it has connected, so the capture gets a
# second before the replay moves. The samples it could still miss are the
# first minutes after 06:00, hours before the leak starts at 09:48.
start_capture() {
	local name="$1" out="$2" seconds="$3"
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker run --rm --name "$name" --network "${PROJECT}_default" "$HELPER_IMAGE" \
		mosquitto_sub -h mqtt -t "$TELEMETRY_TOPIC" -W "$seconds" -v >"$out" 2>/dev/null &
	sleep 1
}

stop_capture() {
	docker stop -t 1 "$1" >/dev/null 2>&1 || true
	wait 2>/dev/null || true
}

tour() {
	local backend model after pause_budget
	backend=$(expected_backend)
	model=$(expected_model)

	step_begin tour
	check ids "$UI" decisions "$WORK/decisions-before.json"
	check ids "$UI" events "$WORK/events-before.json"
	check command "$UI" pause '{}' "$WORK/pause-tour.json"
	check command "$UI" speed "{\"speed\":$SPEED}" "$WORK/speed.json"
	check command "$UI" jump "{\"preset_id\":\"$F3_PRESET\"}" "$WORK/jump.json"
	after=$(pyc field "$WORK/jump.json" ack.status.sim_ts)
	pause_budget=$(bound $((F3_SIM_SPAN_S * 2 / SPEED + 60)))
	start_capture "$PROJECT-smoke-symptom" "$WORK/symptom.txt" "$((pause_budget + 30))"
	check command "$UI" play '{}' "$WORK/play.json"
	local play_detail="$CHECK_DETAIL"
	check sim-at "$UI" "$F3_PAUSE_AT" "$pause_budget"
	local paused_at="$CHECK_DETAIL"
	check command "$UI" pause '{}' "$WORK/pause-f3.json"
	sleep 2
	stop_capture "$PROJECT-smoke-symptom"
	step_ok "jumped to $F3_PRESET at $after, x$SPEED, paused at $paused_at; $play_detail"

	step_begin symptom
	check symptom "$WORK/symptom.txt" "$F3_DAY"
	step_ok "$CHECK_DETAIL"

	step_begin suspect
	check wait-event "$UI" "$WORK/events-before.json" "$after" "$(bound "$SUSPECT_TIMEOUT_S")"
	step_ok "$CHECK_DETAIL"

	step_begin decision
	check wait-decision "$UI" "$WORK/decisions-before.json" "$after" "" "$backend" "$model" \
		"$(bound "$DECISION_TIMEOUT_S")" "$REPORT_DIR/decision.json" 0
	local decision_detail="$CHECK_DETAIL"
	FIRST_DECISION_S=$(pyc latency "$REPORT_DIR/decision.json" "$WORK/play.json")
	step_ok "$decision_detail; ${FIRST_DECISION_S}s after play"

	step_begin top-candidate
	top_candidate "$REPORT_DIR/decision.json" "$F3_TOP_FAULT"

	step_begin cost
	check cost "$UI" "$REPORT_DIR/decision.json"
	step_ok "$CHECK_DETAIL"

	# MUST in every mode: jev via the mock always clears the ticket gate, and
	# the rules backend must reach at least review on signature A.
	step_begin ticket
	check wait-ticket "$UI" "$REPORT_DIR/decision.json" "$(bound "$TICKET_TIMEOUT_S")"
	step_ok "$CHECK_DETAIL"
}

# The top candidate is a MUST in ci mode, where the mock's best-overlap policy
# makes it a pure function of the request; with rules or a real model it
# is a finding, reported and kept.
top_candidate() {
	local file="$1" fault="$2" detail rc=0
	detail=$(pyc top "$file" "$fault") || rc=$?
	if [ "$rc" -eq 0 ]; then
		step_ok "$detail"
	elif [ "$MODE" = ci ]; then
		step_fail "$EXIT_ASSERTION" "$detail"
	else
		note "$CURRENT_STEP: $detail"
		step_ok "reported, not asserted in $MODE mode"
	fi
}

# --- 10. injection ------------------------------------------------------------------------

injection() {
	local backend model started
	backend=$(expected_backend)
	model=$(expected_model)

	step_begin injection
	check ids "$UI" decisions "$WORK/decisions-before-injection.json"
	check command "$UI" speed "{\"speed\":$INJECTION_SPEED}" "$WORK/speed-injection.json"
	check command "$UI" jump "{\"preset_id\":\"$BASELINE_PRESET\"}" "$WORK/jump-baseline.json"
	check command "$UI" play '{}' "$WORK/play-injection.json"
	check command "$UI" inject "{\"injection_id\":\"$INJECTION_ID\",\"params\":{\"magnitude\":$INJECTION_MAGNITUDE}}" \
		"$WORK/inject.json"
	check wait-active "$UI" "$INJECTION_ID" "$(bound "$OVERLAY_TIMEOUT_S")" "$WORK/active.json"
	local active_detail="$CHECK_DETAIL"
	started=$(pyc field "$WORK/active.json" started_sim_ts)
	sample_telemetry "$WORK/telemetry-injection.txt"
	step_ok "$active_detail; telemetry meanwhile: $CHECK_DETAIL"

	# A live run stops here: every further decision would be a paid call.
	if [ "$MODE" != live ]; then
		step_begin injection-decision
		check wait-decision "$UI" "$WORK/decisions-before-injection.json" "$started" "" "$backend" "$model" \
			"$(bound "$DECISION_TIMEOUT_S")" "$REPORT_DIR/injection-decision.json" 0
		local decision_detail="$CHECK_DETAIL"
		check candidate "$REPORT_DIR/injection-decision.json" "$INJECTION_FAULT"
		step_ok "$decision_detail; $CHECK_DETAIL"

		step_begin injection-top-candidate
		injection_top_candidate
	fi

	step_begin clear
	check command "$UI" clear '{}' "$WORK/clear.json"
	check wait-clear "$UI" "$(bound "$OVERLAY_TIMEOUT_S")"
	local clear_detail="$CHECK_DETAIL"
	check command "$UI" pause '{}' "$WORK/pause-injection.json"
	step_ok "$clear_detail"
}

# Reported, not asserted, in every mode: with this catalog the mock's
# best-overlap policy scores cooling_fan_failure and oil_cooler_fouled equally
# on an oil-temperature event (their expected moves differ only in onset and
# phase words, which no observation carries), and the tie goes to the smaller
# id.
injection_top_candidate() {
	local detail rc=0
	detail=$(pyc top "$REPORT_DIR/injection-decision.json" "$INJECTION_FAULT") || rc=$?
	if [ "$rc" -eq 0 ]; then
		step_ok "$detail"
	else
		note "$CURRENT_STEP: $detail"
		step_ok "reported, not asserted"
	fi
}

# --- 11. live: the llm phase ------------------------------------------------------------

llm_phase() {
	local llm_model after rc=0
	llm_model=$(env_file_value LLM_MODEL "$LLM_MODEL_DEFAULT")

	step_begin llm-backend
	# Only the backend is re-created, with the key Compose reads from ENV_FILE
	# (the phase before blanked it so init would not structure the catalog
	# with a paid model).
	env -u LLM_API_KEY DECISION_BACKEND=llm \
		docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --wait --wait-timeout "$(bound "$HEALTH_TIMEOUT_S")" backend \
		>"$WORK/llm-up.log" 2>&1 || rc=$?
	[ "$rc" -eq 0 ] || step_fail "$EXIT_STACK" "the backend did not come back with DECISION_BACKEND=llm (exit $rc)"
	# nginx resolved the backend's address when it started; a reload makes it
	# look again, since the re-created container may have another one. A
	# restart would also do, but could move the ephemeral UI port.
	compose exec -T frontend nginx -s reload >/dev/null 2>&1 ||
		step_fail "$EXIT_STACK" "cannot reload the frontend's nginx after the backend was re-created"
	check health "$UI" llm "$llm_model" "$(bound "$HEALTH_TIMEOUT_S")"
	step_ok "$CHECK_DETAIL"

	step_begin llm-tour
	check ids "$UI" decisions "$WORK/decisions-before-llm.json"
	check ids "$UI" events "$WORK/events-before-llm.json"
	check command "$UI" reset '{}' "$WORK/reset.json"
	check command "$UI" speed "{\"speed\":$SPEED}" "$WORK/speed-llm.json"
	check command "$UI" jump "{\"preset_id\":\"$F3_PRESET\"}" "$WORK/jump-llm.json"
	after=$(pyc field "$WORK/jump-llm.json" ack.status.sim_ts)
	check command "$UI" play '{}' "$WORK/play-llm.json"
	check wait-event "$UI" "$WORK/events-before-llm.json" "$after" "$(bound "$SUSPECT_TIMEOUT_S")"
	# Pausing at the first suspect event keeps the paid calls to the one or two
	# decisions it triggers.
	check command "$UI" pause '{}' "$WORK/pause-llm.json"
	step_ok "$CHECK_DETAIL"

	step_begin llm-decision
	check wait-decision "$UI" "$WORK/decisions-before-llm.json" "$after" "" llm "$llm_model" \
		"$(bound "$DECISION_TIMEOUT_S")" "$REPORT_DIR/llm-decision.json" 1
	step_ok "$CHECK_DETAIL"
}

# --- 12. images ---------------------------------------------------------------------

scan_images() {
	step_begin images
	compose images --format json >"$WORK/images.json" 2>/dev/null ||
		step_fail "$EXIT_ASSERTION" "cannot list the project's images"
	check images "$PROJECT" "$REPORT_DIR/images.json" <"$WORK/images.json"
	local image count=0 rc
	while IFS= read -r image; do
		[ -n "$image" ] || continue
		rc=0
		docker save "$image" | pyc scan-image "$image" >"$WORK/scan.txt" 2>&1 || rc=$?
		[ "$rc" -eq 0 ] || step_fail "$EXIT_ASSERTION" "$(tail -n 1 "$WORK/scan.txt")"
		count=$((count + 1))
	done <<EOF
$CHECK_DETAIL
EOF
	step_ok "$count images: no environment file, neither the CI mock token nor a key-shaped value"
}

# --- keep, report, teardown -----------------------------------------------------------------

write_keep_files() {
	local dir="$ROOT/reports/smoke" db
	mkdir -p "$dir"
	printf '%s\n' "$UI" >"$dir/ui-url"
	printf '%s\n' "$PROJECT" >"$dir/project"
	db=$(published postgres 5432)
	if [ -n "$db" ]; then
		# The eval role's PoC default password, not a secret.
		printf 'postgres://eval:eval@%s/fdp\n' "$db" >"$dir/db-url-eval"
	else
		rm -f "$dir/db-url-eval"
	fi
	say "kept project $PROJECT at $UI; reports/smoke holds ui-url, project${db:+ and db-url-eval}"
}

dump_logs() {
	{
		compose ps -a
		compose logs --no-color --timestamps
	} >"$REPORT_DIR/logs.txt" 2>&1 || true
}

teardown() {
	if [ "$MODE" = quickstart ]; then
		if [ "$IN_CI" -eq 1 ]; then
			make down || true
			make reset || true
		else
			COMPOSE_PROJECT_NAME="$PROJECT" make down COMPOSE="docker compose --env-file $TEMP_ENV" || true
			compose down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
		fi
	else
		compose down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
	fi
}

finish() {
	local status=$?
	set +e
	trap - EXIT
	if [ -n "$CURRENT_STEP" ]; then
		record_step false "the step stopped with status $status"
		printf 'FAIL %s: stopped with status %s\n' "$CURRENT_STEP" "$status"
		CURRENT_STEP=""
	fi
	case "$status" in
	0 | "$EXIT_ASSERTION" | "$EXIT_STACK" | "$EXIT_NO_TICKET" | "$EXIT_USAGE" | "$EXIT_KEYS") ;;
	*) status=$EXIT_ASSERTION ;;
	esac
	if [ "$STACK_STARTED" -eq 1 ]; then
		docker rm -f "$PROJECT-smoke-symptom" >/dev/null 2>&1
		if [ "$status" -ne 0 ] || [ "$KEEP" -eq 1 ]; then
			dump_logs
		fi
		if [ "$KEEP" -eq 1 ] && [ -n "$UI" ]; then
			write_keep_files
		else
			teardown
		fi
	fi
	if [ -n "$REPORT_DIR" ] && [ -d "$REPORT_DIR" ] && [ "$DRY_RUN" -eq 0 ]; then
		local timings
		timings=$(printf '{"up_s": %s, "first_decision_s": %s, "total_s": %s}' \
			"$UP_S" "$FIRST_DECISION_S" "$(($(date +%s) - STARTED_S))")
		pyc summary "$REPORT_DIR" "$MODE" "$PROJECT" "$STARTED_WALL_TS" "$(utc_now)" "$status" "$timings" >/dev/null
		say "report: $REPORT_DIR/summary.json"
	fi
	[ -z "$TEMP_ENV" ] || rm -f "$TEMP_ENV"
	[ -z "$WORK" ] || rm -rf "$WORK"
	if [ "$status" -eq 0 ] && [ "$DRY_RUN" -eq 1 ]; then
		say "dry run: the preconditions hold; nothing was started"
	elif [ "$status" -eq 0 ]; then
		say "passed in $(($(date +%s) - STARTED_S))s (up ${UP_S}s, first decision ${FIRST_DECISION_S}s after play)"
	else
		say "failed with exit code $status"
	fi
	exit "$status"
}

# --- arguments --------------------------------------------------------------------------------

is_count() {
	case "$1" in
	'' | *[!0-9]*) return 1 ;;
	*) [ "$1" -gt 0 ] ;;
	esac
}

absolute() {
	case "$1" in
	/*) printf '%s\n' "$1" ;;
	*) printf '%s/%s\n' "$INVOKED_FROM" "$1" ;;
	esac
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--help | -h)
			usage
			exit 0
			;;
		--mode)
			[ $# -ge 2 ] || usage_error "--mode needs a value"
			MODE="$2"
			shift 2
			;;
		--project)
			[ $# -ge 2 ] || usage_error "--project needs a value"
			PROJECT="$2"
			shift 2
			;;
		--keep)
			KEEP=1
			shift
			;;
		--no-build)
			BUILD=0
			shift
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		--decision-timeout)
			if [ $# -lt 2 ] || ! is_count "$2"; then usage_error "--decision-timeout needs a positive number of seconds"; fi
			DECISION_TIMEOUT_S="$2"
			shift 2
			;;
		--speed)
			if [ $# -lt 2 ] || ! is_count "$2" || [ "$2" -gt 3600 ]; then usage_error "--speed needs a whole number from 1 to 3600"; fi
			SPEED="$2"
			shift 2
			;;
		--report)
			[ $# -ge 2 ] || usage_error "--report needs a directory"
			REPORT_DIR=$(absolute "$2")
			shift 2
			;;
		--env-file)
			[ $# -ge 2 ] || usage_error "--env-file needs a path"
			ENV_FILE_OPTION="$2"
			shift 2
			;;
		*) usage_error "unknown argument: $1" ;;
		esac
	done

	case "$MODE" in
	ci | quickstart | live) ;;
	*) usage_error "unknown mode '$MODE' (ci, quickstart or live)" ;;
	esac
	case "${FDP_TIMING_SLACK:-1}" in
	'' | . | *[!0-9.]* | *.*.*) usage_error "FDP_TIMING_SLACK must be a positive number" ;;
	esac
	[ "${CI:-}" = true ] && IN_CI=1
	if [ -n "$PROJECT" ]; then
		printf '%s' "$PROJECT" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' ||
			usage_error "--project must be lower-case letters, digits, '-' and '_'"
		if [ "$MODE" = quickstart ] && [ "$IN_CI" -eq 1 ]; then
			usage_error "--project does not apply to quickstart in CI, which runs the README's default project"
		fi
	fi
	ENV_FILE=$(absolute "${ENV_FILE_OPTION:-${ENV_FILE:-.env}}")
}

# The Compose command line of the mode, and the environment it runs in. ci and
# quickstart never see a key from the shell; live reads ENV_FILE and nothing
# else, with the llm key held back until its phase.
configure() {
	case "$MODE" in
	ci)
		unset TYPESAFE_API_KEY LLM_API_KEY DECISION_BACKEND
		PROJECT="${PROJECT:-smoke-$RANDOM$RANDOM}"
		COMPOSE_ARGS=(-p "$PROJECT" --env-file /dev/null -f compose.yaml -f compose.ci.yaml)
		;;
	quickstart)
		unset TYPESAFE_API_KEY LLM_API_KEY DECISION_BACKEND
		if [ "$IN_CI" -eq 1 ]; then
			PROJECT="fault-diagnosis-poc"
			COMPOSE_ARGS=(-p "$PROJECT" -f compose.yaml)
		else
			PROJECT="${PROJECT:-quickstart-$RANDOM$RANDOM}"
			TEMP_ENV=$(mktemp "${TMPDIR:-/tmp}/fdp-quickstart-env.XXXXXX")
			COMPOSE_ARGS=(-p "$PROJECT" --env-file "$TEMP_ENV" -f compose.yaml)
		fi
		;;
	live)
		PROJECT="${PROJECT:-live-$RANDOM$RANDOM}"
		COMPOSE_ARGS=(-p "$PROJECT" --env-file "$ENV_FILE" -f compose.yaml)
		export DECISION_BACKEND=jev
		export LLM_API_KEY=""
		;;
	esac
}

main() {
	parse_args "$@"
	cd "$ROOT"
	configure
	STARTED_WALL_TS=$(utc_now)
	STARTED_S=$(date +%s)
	trap finish EXIT
	trap 'exit 130' INT TERM

	if [ "$DRY_RUN" -eq 0 ]; then
		REPORT_DIR="${REPORT_DIR:-$ROOT/reports/smoke-$(date -u +%Y%m%dT%H%M%SZ)}"
		mkdir -p "$REPORT_DIR"
		rm -f "$REPORT_DIR/steps.jsonl" "$REPORT_DIR/notes.txt"
		WORK=$(mktemp -d "${TMPDIR:-/tmp}/fdp-smoke.XXXXXX")
	fi
	if [ "$MODE" = ci ] && [ "$DRY_RUN" -eq 0 ]; then
		# compose.ci.yaml binds the host model cache; created here so Docker
		# does not create it root-owned.
		mkdir -p .cache/models
	fi

	preflight
	[ "$DRY_RUN" -eq 0 ] || exit 0

	stack_up
	discover_ports
	init_report
	health
	telemetry
	if [ "$MODE" != live ]; then
		isolation
	fi
	tour
	injection
	if [ "$MODE" = live ]; then
		llm_phase
	fi
	scan_images
}

main "$@"

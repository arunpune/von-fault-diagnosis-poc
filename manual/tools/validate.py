#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Spec-level validation of the CAU-7 manual source of truth.

Implements the source rules (docs/manual.md lists them all) that need no Jinja
rendering: S1, S2, R1-R5, P1-P6, M1, M2, B1, B2, A1-A5, N2 and L1. The
text-level rules (N1, N3, C1-C6) live in manual/tools/content_checks.py.

Usage::

    uv run --no-project --with-requirements manual/tools/requirements.txt \\
        python manual/tools/validate.py --spec manual --strict --report

Every failure prints one line ``RULE file:pointer message`` and the process
exits 1. Rules whose input files are absent print ``SKIP <rule> needs <file>``.
Every function here is importable; content_checks.py and tools/manual-build
reuse them.
"""

# Rule functions are named rule_<ID> after the published rule ids, which are
# upper case; that is the published contract, so pep8-naming is off here.
# ruff: noqa: N802
from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

if __package__ in (None, ""):  # running as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from load import (
    SPEC_FILES,
    YAML_FILE_KEYS,
    Spec,
    SpecError,
    alarm_by_code,
    condition_by_id,
    load_spec,
    resolve_duration,
    resolve_threshold,
    setting_by_id,
    signal_by_id,
)

# --- fixed expectations ---------------------------------------------------

#: the fifteen MetroPT-3 CSV header columns
METROPT_COLUMNS: frozenset[str] = frozenset(
    {
        "TP2",
        "TP3",
        "H1",
        "DV_pressure",
        "Reservoirs",
        "Oil_temperature",
        "Motor_current",
        "COMP",
        "DV_eletric",
        "Towers",
        "MPG",
        "LPS",
        "Pressure_switch",
        "Oil_level",
        "Caudal_impulses",
    }
)

#: signal file order and per-group size
GROUP_ORDER: tuple[str, ...] = ("analog", "digital", "extra")
GROUP_COUNTS: dict[str, int] = {"analog": 7, "digital": 8, "extra": 1}

#: Modbus scale expected per signal kind (rule M2)
SCALE_BY_KIND: dict[str, float] = {"pressure": 1000, "temperature": 100, "current": 100}

#: provenance constants of the committed band derivation
BANDS_SOURCE_SHA256 = "db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24"
BANDS_RANGE: list[str] = ["2020-02-01T00:00:00", "2020-03-01T00:00:00"]
BANDS_ROWS_TOTAL = 1516948
BANDS_MIN_ROWS_USED = 200000

#: message type ordering inside a family (rule P1)
TYPE_RANK: dict[str, int] = {"warning": 1, "shutdown_warning": 2, "shutdown": 3}

BAND_STATES: tuple[str, ...] = ("loaded", "unloaded", "off")
#: which band states an alarm state guard covers (rule P4)
STATES_BY_GUARD: dict[str, tuple[str, ...]] = {
    "any": BAND_STATES,
    "running": ("loaded", "unloaded"),
    "loaded": ("loaded",),
    "unloaded": ("unloaded",),
    "off": ("off",),
}

ANALOG_DIRECTIONS = frozenset(
    {"rises", "falls", "high", "low", "unchanged", "fluctuates", "near_zero", "not_venting"}
)
DIGITAL_DIRECTIONS = frozenset({"on", "off", "stays_on", "stays_off", "toggles", "no_pulse"})
BEHAVIOUR_DIRECTIONS = frozenset(
    {"higher", "lower", "longer", "shorter", "faster", "slower", "not_reached", "unchanged"}
)

#: files rule L1 checks for an SPDX header comment
SPDX_HEADER_SUFFIXES = (".yaml", ".yml", ".md", ".svg", ".py")
SPDX_HEADER_LINES = 5

_DIGIT = re.compile(r"\d")


# --- findings -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Finding:
    """One rule violation, addressed by file and JSON pointer."""

    rule: str
    file: str
    pointer: str
    message: str

    def __str__(self) -> str:
        return f"{self.rule} {self.file}:{self.pointer} {self.message}"


@dataclass(frozen=True, slots=True)
class Minimums:
    """Catalog size floors (rule A1); the defaults are the ones spec section 6 asks for."""

    conditions: int = 12
    causes: int = 30
    sharing: int = 5
    benign: int = 2

    @classmethod
    def parse(cls, text: str) -> Minimums:
        """Parse the ``--minimums conditions,causes,sharing,benign`` argument."""
        parts = [part.strip() for part in text.split(",")]
        if len(parts) != 4:
            raise ValueError("expected four comma-separated integers")
        values = [int(part) for part in parts]
        if any(value < 0 for value in values):
            raise ValueError("minimums must not be negative")
        return cls(*values)


RuleFn = Callable[[Spec, Minimums], list[Finding]]


@dataclass(frozen=True, slots=True)
class Rule:
    """A validation rule plus the spec files it needs to run."""

    func: RuleFn
    needs: tuple[str, ...]
    summary: str


def _finding(rule: str, spec: Spec, key: str, pointer: str, message: str) -> Finding:
    return Finding(rule, SPEC_FILES[key][0] if key in SPEC_FILES else key, pointer, message)


# --- small shared accessors ----------------------------------------------


def _leaves(condition: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the comparison leaves of a trigger condition (leaf, all or any)."""
    for key in ("all", "any"):
        if key in condition:
            return list(condition[key])
    return [condition]


def _is_compound(condition: dict[str, Any]) -> bool:
    return "all" in condition or "any" in condition


def _signal_conditions(spec: Spec) -> Iterator[tuple[int, dict[str, Any], dict[str, Any]]]:
    """Yield ``(index, message, condition)`` for every signal-triggered message."""
    for index, message in enumerate(spec.alarm_list):
        trigger = message.get("trigger", {})
        if trigger.get("kind") != "signal":
            continue
        condition = trigger.get("condition")
        if isinstance(condition, dict):
            yield index, message, condition


def _derived_by_id(spec: Spec) -> dict[str, dict[str, Any]]:
    return {item["id"]: item for item in (spec.signals or {}).get("derived", [])}


def _signal_subsystems(spec: Spec) -> list[str]:
    """Return the sorted subsystems that carry at least one signal."""
    return sorted({str(signal["subsystem"]) for signal in spec.signal_list})


def _behaviour_ids(spec: Spec) -> set[str]:
    return {item["id"] for item in (spec.signals or {}).get("behaviours", [])}


def _machine_path(spec: Spec, dotted: str) -> float | None:
    """Resolve ``machine.ratings.max_working_pressure`` style paths to a number."""
    if not dotted.startswith("machine."):
        return None
    node: Any = spec.machine
    for part in dotted.split(".")[1:]:
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    if isinstance(node, dict) and "value" in node:
        node = node["value"]
    return float(node) if isinstance(node, (int, float)) else None


def _spdx_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file() and not any(part.startswith(".") for part in path.parts):
            yield path


# --- rules: schemas and identifiers --------------------------------------


def rule_S1(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Every loaded YAML declares ``schema_version: 1``.

    The other half of S1 — each document validating against its schema — is
    enforced by ``load_spec``; the CLI reports those parse and schema errors
    under S1 as well.
    """
    del minimums
    findings: list[Finding] = []
    for key in YAML_FILE_KEYS:
        document = spec.document(key)
        if document is None:
            continue
        version = document.get("schema_version")
        if version != 1:
            findings.append(
                _finding("S1", spec, key, "/schema_version", f"expected 1, found {version!r}")
            )
    return findings


def _collect_ids(spec: Spec) -> dict[str, list[tuple[str, str]]]:
    """Map every declared identifier to the ``(file, pointer)`` places it is declared."""
    seen: dict[str, list[tuple[str, str]]] = defaultdict(list)

    def add(key: str, pointer: str, value: Any) -> None:
        if isinstance(value, str):
            seen[value].append((SPEC_FILES[key][0], pointer))

    for index, item in enumerate(spec.signal_list):
        add("signals", f"/signals/{index}/id", item.get("id"))
    for index, item in enumerate((spec.signals or {}).get("derived", [])):
        add("signals", f"/derived/{index}/id", item.get("id"))
    for index, item in enumerate((spec.signals or {}).get("behaviours", [])):
        add("signals", f"/behaviours/{index}/id", item.get("id"))
    for index, item in enumerate(spec.setting_list):
        add("settings", f"/settings/{index}/id", item.get("id"))
    for index, item in enumerate(spec.condition_list):
        add("faults", f"/conditions/{index}/id", item.get("id"))
    for index, item in enumerate(spec.cause_list):
        add("faults", f"/causes/{index}/fault_id", item.get("fault_id"))
    for index, item in enumerate(spec.task_list):
        add("maintenance", f"/tasks/{index}/id", item.get("id"))
    for index, item in enumerate((spec.machine or {}).get("components", [])):
        add("machine", f"/components/{index}/id", item.get("id"))
    return seen


def rule_S2(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Identifiers, alarm codes, bits, parameter numbers, panel labels and
    MetroPT columns are unique within a file and across the spec.

    ``machine.parts[].id`` is deliberately outside the shared identifier space:
    a consumable is routinely named after the component it belongs to (the
    registry has ``oil_level_switch`` as both), and parts and components are
    resolved through different fields, so the names cannot be confused.
    """
    del minimums
    findings: list[Finding] = []

    for identifier, places in sorted(_collect_ids(spec).items()):
        if len(places) > 1:
            where = ", ".join(f"{file}:{pointer}" for file, pointer in places[1:])
            file, pointer = places[0]
            findings.append(
                Finding(
                    "S2", file, pointer, f"identifier {identifier!r} is also declared at {where}"
                )
            )

    part_ids: dict[str, int] = {}
    for index, part in enumerate((spec.machine or {}).get("parts", [])):
        part_id = part.get("id")
        if part_id in part_ids:
            findings.append(
                _finding(
                    "S2",
                    spec,
                    "machine",
                    f"/parts/{index}/id",
                    f"part id {part_id!r} is already used at /parts/{part_ids[part_id]}/id",
                )
            )
        elif isinstance(part_id, str):
            part_ids[part_id] = index

    def unique(key: str, pointer_of: Callable[[int], str], values: list[Any], label: str) -> None:
        first: dict[Any, int] = {}
        for index, value in enumerate(values):
            if value is None:
                continue
            if value in first:
                findings.append(
                    _finding(
                        "S2",
                        spec,
                        key,
                        pointer_of(index),
                        f"{label} {value!r} is already used at {pointer_of(first[value])}",
                    )
                )
            else:
                first[value] = index

    alarms = spec.alarm_list
    unique("alarms", lambda i: f"/alarms/{i}/code", [a.get("code") for a in alarms], "alarm code")
    unique("alarms", lambda i: f"/alarms/{i}/bit", [a.get("bit") for a in alarms], "alarm bit")
    settings = spec.setting_list
    unique(
        "settings",
        lambda i: f"/settings/{i}/param_no",
        [s.get("param_no") for s in settings],
        "parameter number",
    )
    signals = spec.signal_list
    unique(
        "signals",
        lambda i: f"/signals/{i}/panel_label",
        [s.get("panel_label") for s in signals],
        "panel label",
    )
    unique(
        "signals",
        lambda i: f"/signals/{i}/metropt_column",
        [s.get("metropt_column") for s in signals],
        "MetroPT column",
    )
    return findings


# --- rules: referential integrity ----------------------------------------


@dataclass(frozen=True, slots=True)
class _Pools:
    """The identifier pools every reference in the spec has to resolve against."""

    signals: set[str]
    derived: set[str]
    behaviours: set[str]
    settings: set[str]
    alarms: set[str]
    conditions: set[str]
    causes: set[str]
    tasks: set[str]
    parts: set[str]
    components: set[str]
    subsystems: set[str]

    @classmethod
    def of(cls, spec: Spec) -> _Pools:
        machine = spec.machine or {}
        return cls(
            signals={item["id"] for item in spec.signal_list},
            derived=set(_derived_by_id(spec)),
            behaviours=_behaviour_ids(spec),
            settings={item["id"] for item in spec.setting_list},
            alarms={item["code"] for item in spec.alarm_list},
            conditions={item["id"] for item in spec.condition_list},
            causes={item["fault_id"] for item in spec.cause_list},
            tasks={item["id"] for item in spec.task_list},
            parts={item["id"] for item in machine.get("parts", [])},
            components={item["id"] for item in machine.get("components", [])},
            subsystems=set(machine.get("subsystems", [])),
        )


class _Needs:
    """Collects R1 findings for references that do not resolve."""

    def __init__(self, spec: Spec) -> None:
        self.spec = spec
        self.findings: list[Finding] = []

    def need(self, key: str, pointer: str, value: Any, pool: set[str], label: str) -> None:
        if value is not None and value not in pool:
            self.findings.append(
                _finding("R1", self.spec, key, pointer, f"unknown {label} {value!r}")
            )


def _r1_machine_and_signals(spec: Spec, pools: _Pools, needs: _Needs) -> None:
    machine = spec.machine or {}
    for index, sensor in enumerate(machine.get("sensors", [])):
        needs.need(
            "machine", f"/sensors/{index}/signal", sensor.get("signal"), pools.signals, "signal"
        )
    for name, switch in machine.get("hardware_switches", {}).items():
        needs.need(
            "machine",
            f"/hardware_switches/{name}/signal",
            switch.get("signal"),
            pools.signals,
            "signal",
        )
    for index, component in enumerate(machine.get("components", [])):
        needs.need(
            "machine",
            f"/components/{index}/subsystem",
            component.get("subsystem"),
            pools.subsystems,
            "subsystem",
        )
    for index, signal in enumerate(spec.signal_list):
        needs.need(
            "signals",
            f"/signals/{index}/subsystem",
            signal.get("subsystem"),
            pools.subsystems,
            "subsystem",
        )
    for index, item in enumerate((spec.signals or {}).get("derived", [])):
        for slot, value in enumerate(item.get("inputs", [])):
            needs.need("signals", f"/derived/{index}/inputs/{slot}", value, pools.signals, "signal")
        if "input" in item:
            needs.need("signals", f"/derived/{index}/input", item["input"], pools.signals, "signal")


def _r1_settings(spec: Spec, pools: _Pools, needs: _Needs) -> None:
    for index, setting in enumerate(spec.setting_list):
        if "signal" in setting:
            needs.need(
                "settings", f"/settings/{index}/signal", setting["signal"], pools.signals, "signal"
            )
        for slot, constraint in enumerate(setting.get("constraints", [])):
            other = constraint.get("other", "")
            pointer = f"/settings/{index}/constraints/{slot}/other"
            if other.startswith("machine."):
                if _machine_path(spec, other) is None:
                    needs.findings.append(
                        _finding("R1", spec, "settings", pointer, f"unknown machine path {other!r}")
                    )
            else:
                needs.need("settings", pointer, other, pools.settings, "setting")


def _r1_alarms(spec: Spec, pools: _Pools, needs: _Needs) -> None:
    measurable = pools.signals | pools.derived
    for index, message in enumerate(spec.alarm_list):
        trigger = message.get("trigger", {})
        condition = trigger.get("condition")
        if isinstance(condition, dict):
            group = "all" if "all" in condition else "any" if "any" in condition else None
            for slot, leaf in enumerate(_leaves(condition)):
                base = (
                    f"/alarms/{index}/trigger/condition/{group}/{slot}"
                    if group
                    else f"/alarms/{index}/trigger/condition"
                )
                needs.need("alarms", f"{base}/signal", leaf.get("signal"), measurable, "signal")
                threshold = leaf.get("threshold", {})
                if "setting" in threshold:
                    needs.need(
                        "alarms",
                        f"{base}/threshold/setting",
                        threshold["setting"],
                        pools.settings,
                        "setting",
                    )
        for name in ("for_s", "exclude_start_s"):
            value = trigger.get(name)
            if isinstance(value, dict):
                needs.need(
                    "alarms",
                    f"/alarms/{index}/trigger/{name}/setting",
                    value.get("setting"),
                    pools.settings,
                    "setting",
                )
        counter = trigger.get("counter")
        if isinstance(counter, dict):
            needs.need(
                "alarms",
                f"/alarms/{index}/trigger/counter/derived",
                counter.get("derived"),
                pools.derived,
                "derived signal",
            )
            if "task" in counter:
                needs.need(
                    "alarms",
                    f"/alarms/{index}/trigger/counter/task",
                    counter["task"],
                    pools.tasks,
                    "maintenance task",
                )
            for slot, value in enumerate(counter.get("tasks", [])):
                needs.need(
                    "alarms",
                    f"/alarms/{index}/trigger/counter/tasks/{slot}",
                    value,
                    pools.tasks,
                    "maintenance task",
                )
        for slot, value in enumerate(message.get("related_conditions", [])):
            needs.need(
                "alarms",
                f"/alarms/{index}/related_conditions/{slot}",
                value,
                pools.conditions,
                "condition",
            )


def _r1_faults(spec: Spec, pools: _Pools, needs: _Needs) -> None:
    for index, condition in enumerate(spec.condition_list):
        for slot, code in enumerate(condition.get("alarms", [])):
            needs.need(
                "faults", f"/conditions/{index}/alarms/{slot}", code, pools.alarms, "alarm code"
            )
        for slot, value in enumerate(condition.get("signals", [])):
            needs.need(
                "faults", f"/conditions/{index}/signals/{slot}", value, pools.signals, "signal"
            )
        for slot, entry in enumerate(condition.get("causes", [])):
            needs.need(
                "faults",
                f"/conditions/{index}/causes/{slot}/fault_id",
                entry.get("fault_id"),
                pools.causes,
                "cause",
            )
    for index, cause in enumerate(spec.cause_list):
        for slot, move in enumerate(cause.get("signal_moves", [])):
            pointer = f"/causes/{index}/signal_moves/{slot}"
            if "signal" in move:
                needs.need("faults", f"{pointer}/signal", move["signal"], pools.signals, "signal")
            if "behaviour" in move:
                needs.need(
                    "faults",
                    f"{pointer}/behaviour",
                    move["behaviour"],
                    pools.behaviours,
                    "behaviour",
                )
        for name, pool, label in (
            ("parts", pools.parts, "part"),
            ("maintenance", pools.tasks, "maintenance task"),
            ("components", pools.components, "component"),
        ):
            for slot, value in enumerate(cause.get(name, [])):
                needs.need("faults", f"/causes/{index}/{name}/{slot}", value, pool, label)


def _r1_maintenance(spec: Spec, pools: _Pools, needs: _Needs) -> None:
    for index, task in enumerate(spec.task_list):
        code = task.get("service_message")
        if code is not None:
            needs.need(
                "maintenance", f"/tasks/{index}/service_message", code, pools.alarms, "alarm code"
            )
        for slot, consumable in enumerate(task.get("consumables", [])):
            needs.need(
                "maintenance",
                f"/tasks/{index}/consumables/{slot}/part",
                consumable.get("part"),
                pools.parts,
                "part",
            )
        for name, pool, label in (
            ("related_causes", pools.causes, "cause"),
            ("components", pools.components, "component"),
        ):
            for slot, value in enumerate(task.get(name, [])):
                needs.need("maintenance", f"/tasks/{index}/{name}/{slot}", value, pool, label)


def rule_R1(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Every referenced signal, setting, alarm, condition, cause, task, part,
    component and subsystem exists."""
    del minimums
    pools = _Pools.of(spec)
    needs = _Needs(spec)
    _r1_machine_and_signals(spec, pools, needs)
    _r1_settings(spec, pools, needs)
    _r1_alarms(spec, pools, needs)
    _r1_faults(spec, pools, needs)
    _r1_maintenance(spec, pools, needs)
    return needs.findings


def rule_R2(spec: Spec, minimums: Minimums) -> list[Finding]:
    """The condition/cause graph is complete in both directions."""
    del minimums
    findings: list[Finding] = []
    listed: set[str] = set()
    for index, condition in enumerate(spec.condition_list):
        entries = condition.get("causes", [])
        if not entries:
            findings.append(
                _finding(
                    "R2", spec, "faults", f"/conditions/{index}/causes", "condition lists no cause"
                )
            )
        listed.update(entry.get("fault_id") for entry in entries)
    for index, cause in enumerate(spec.cause_list):
        fault_id = cause.get("fault_id")
        if fault_id not in listed:
            findings.append(
                _finding(
                    "R2",
                    spec,
                    "faults",
                    f"/causes/{index}/fault_id",
                    f"cause {fault_id!r} is listed by no condition",
                )
            )
    return findings


def rule_R3(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Every simulator-evaluable message is referenced by at least one condition."""
    del minimums
    findings: list[Finding] = []
    referenced: set[str] = set()
    for condition in spec.condition_list:
        referenced.update(condition.get("alarms", []))
    for index, message in enumerate(spec.alarm_list):
        if message.get("evaluation") != "sim":
            continue
        code = message.get("code")
        if code not in referenced:
            findings.append(
                _finding(
                    "R3",
                    spec,
                    "alarms",
                    f"/alarms/{index}/code",
                    f"evaluable message {code!r} is referenced by no condition",
                )
            )
    return findings


def _settings_used_by_alarms(spec: Spec) -> set[str]:
    used: set[str] = set()
    for message in spec.alarm_list:
        trigger = message.get("trigger", {})
        condition = trigger.get("condition")
        if isinstance(condition, dict):
            for leaf in _leaves(condition):
                threshold = leaf.get("threshold", {})
                if "setting" in threshold:
                    used.add(threshold["setting"])
        for field in ("for_s", "exclude_start_s"):
            value = trigger.get(field)
            if isinstance(value, dict) and "setting" in value:
                used.add(value["setting"])
    return used


def rule_R4(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Every setting feeds a message threshold or delay, or declares ``used_by``."""
    del minimums
    used = _settings_used_by_alarms(spec)
    findings: list[Finding] = []
    for index, setting in enumerate(spec.setting_list):
        if setting.get("id") in used or setting.get("used_by"):
            continue
        findings.append(
            _finding(
                "R4",
                spec,
                "settings",
                f"/settings/{index}/id",
                f"setting {setting.get('id')!r} is used by no message and declares no used_by",
            )
        )
    return findings


def _r5_messages(spec: Spec, tasks_by_message: dict[str, list[str]]) -> list[Finding]:
    """Check each message against the maintenance tasks that name it."""
    findings: list[Finding] = []
    for index, message in enumerate(spec.alarm_list):
        code = message.get("code")
        if message.get("type") != "service":
            if code in tasks_by_message:
                findings.append(
                    _finding(
                        "R5",
                        spec,
                        "alarms",
                        f"/alarms/{index}/type",
                        f"message {code!r} is a maintenance service_message but has type"
                        f" {message.get('type')!r}",
                    )
                )
            continue
        if code not in tasks_by_message:
            findings.append(
                _finding(
                    "R5",
                    spec,
                    "alarms",
                    f"/alarms/{index}/code",
                    f"service message {code!r} is named by no maintenance task",
                )
            )
            continue
        counter = message.get("trigger", {}).get("counter", {})
        named = [counter[key] for key in ("task",) if key in counter]
        named += list(counter.get("tasks", []))
        for task_id in named:
            if task_id not in tasks_by_message[code]:
                findings.append(
                    _finding(
                        "R5",
                        spec,
                        "alarms",
                        f"/alarms/{index}/trigger/counter",
                        f"task {task_id!r} does not name {code!r} as its service_message",
                    )
                )
    return findings


def _r5_tasks(spec: Spec) -> list[Finding]:
    """Check each maintenance task against the message it names."""
    findings: list[Finding] = []
    for index, task in enumerate(spec.task_list):
        code = task.get("service_message")
        if code is None:
            continue
        message = alarm_by_code(spec, code)
        if message is None:
            continue  # rule R1 reports the dangling code
        counter = message.get("trigger", {}).get("counter", {})
        named = set(counter.get("tasks", []))
        if "task" in counter:
            named.add(counter["task"])
        if named and task["id"] not in named:
            findings.append(
                _finding(
                    "R5",
                    spec,
                    "maintenance",
                    f"/tasks/{index}/service_message",
                    f"message {code!r} does not count this task",
                )
            )
    return findings


def rule_R5(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Service messages and maintenance ``service_message`` agree both ways."""
    del minimums
    tasks_by_message: dict[str, list[str]] = defaultdict(list)
    for task in spec.task_list:
        code = task.get("service_message")
        if code is not None:
            tasks_by_message[code].append(task["id"])
    return _r5_messages(spec, tasks_by_message) + _r5_tasks(spec)


# --- rules: physical plausibility ----------------------------------------


def rule_P1(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Message families rise strictly in rank, in severity and in threshold."""
    del minimums
    findings: list[Finding] = []
    families: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for index, message in enumerate(spec.alarm_list):
        family = message.get("family")
        if family:
            families[family].append((index, message))

    for family, members in sorted(families.items()):
        ordered = sorted(members, key=lambda pair: pair[1].get("rank", 0))
        ranks = [message.get("rank") for _, message in ordered]
        if len(set(ranks)) != len(ranks):
            index, _ = ordered[0]
            findings.append(
                _finding(
                    "P1",
                    spec,
                    "alarms",
                    f"/alarms/{index}/rank",
                    f"family {family!r} reuses a rank",
                )
            )
        previous_type = 0
        previous_value: float | None = None
        previous_code = ""
        for index, message in ordered:
            severity = TYPE_RANK.get(message.get("type", ""), 0)
            if severity <= previous_type:
                findings.append(
                    _finding(
                        "P1",
                        spec,
                        "alarms",
                        f"/alarms/{index}/type",
                        f"family {family!r}: {message.get('code')} is not more severe"
                        f" than {previous_code}",
                    )
                )
            previous_type = max(previous_type, severity)
            condition = message.get("trigger", {}).get("condition")
            if not isinstance(condition, dict) or _is_compound(condition):
                continue
            resolved = resolve_threshold(spec, condition.get("threshold", {}), None)
            if resolved is None:
                continue
            value = resolved[0]
            rising = condition.get("op") in ("gt", "gte")
            if previous_value is not None:
                ordered_ok = value > previous_value if rising else value < previous_value
                if not ordered_ok:
                    findings.append(
                        _finding(
                            "P1",
                            spec,
                            "alarms",
                            f"/alarms/{index}/trigger/condition/threshold",
                            f"family {family!r}: {message.get('code')} threshold {value} does not"
                            f" follow {previous_code} ({previous_value})",
                        )
                    )
            previous_value = value
            previous_code = str(message.get("code"))
    return findings


def rule_P2(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Thresholds sit inside the signal range and carry the signal's unit;
    signal ranges equal the sensor ranges of machine.yaml."""
    del minimums
    findings: list[Finding] = []
    sensors = {sensor["signal"]: sensor for sensor in (spec.machine or {}).get("sensors", [])}
    for index, signal in enumerate(spec.signal_list):
        signal_range = signal.get("range")
        if signal_range is None:
            continue
        sensor = sensors.get(signal["id"])
        if sensor is None:
            findings.append(
                _finding(
                    "P2",
                    spec,
                    "signals",
                    f"/signals/{index}/range",
                    f"signal {signal['id']!r} has a range but machine.yaml declares no sensor",
                )
            )
            continue
        sensor_range = sensor.get("range", {})
        if (signal_range.get("min"), signal_range.get("max")) != (
            sensor_range.get("min"),
            sensor_range.get("max"),
        ):
            findings.append(
                _finding(
                    "P2",
                    spec,
                    "signals",
                    f"/signals/{index}/range",
                    f"range differs from machine.yaml sensor range {sensor_range}",
                )
            )
        if sensor_range.get("unit") != signal.get("unit"):
            findings.append(
                _finding(
                    "P2",
                    spec,
                    "signals",
                    f"/signals/{index}/unit",
                    f"unit {signal.get('unit')!r} differs from the sensor unit"
                    f" {sensor_range.get('unit')!r}",
                )
            )

    derived = _derived_by_id(spec)
    for index, _message, condition in _signal_conditions(spec):
        group = "all" if "all" in condition else "any" if "any" in condition else None
        for slot, leaf in enumerate(_leaves(condition)):
            base = (
                f"/alarms/{index}/trigger/condition/{group}/{slot}"
                if group
                else f"/alarms/{index}/trigger/condition"
            )
            target_id = str(leaf.get("signal", ""))
            leaf_signal = signal_by_id(spec, target_id) if target_id else None
            target: dict[str, Any] | None = leaf_signal or derived.get(target_id)
            if target is None:
                continue  # rule R1 reports the dangling signal
            resolved = resolve_threshold(spec, leaf.get("threshold", {}), leaf_signal)
            if resolved is None:
                continue
            value, unit = resolved
            if unit != target.get("unit"):
                findings.append(
                    _finding(
                        "P2",
                        spec,
                        "alarms",
                        f"{base}/threshold",
                        f"unit {unit!r} differs from the unit of {target_id!r}"
                        f" ({target.get('unit')!r})",
                    )
                )
            leaf_range = (leaf_signal or {}).get("range")
            if leaf_range and not (leaf_range["min"] <= value <= leaf_range["max"]):
                findings.append(
                    _finding(
                        "P2",
                        spec,
                        "alarms",
                        f"{base}/threshold",
                        f"resolved threshold {value} is outside the range of {target_id!r}"
                        f" ({leaf_range['min']}..{leaf_range['max']})",
                    )
                )
    return findings


def rule_P3(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Settings are internally consistent and stay inside the machine ratings."""
    del minimums
    findings: list[Finding] = []
    relations: dict[str, Callable[[float, float], bool]] = {
        "gte": lambda a, b: a >= b,
        "lte": lambda a, b: a <= b,
        "gt": lambda a, b: a > b,
        "lt": lambda a, b: a < b,
        "eq": lambda a, b: a == b,
    }
    for index, setting in enumerate(spec.setting_list):
        low, default, high = setting["min"], setting["default"], setting["max"]
        if not low <= default <= high:
            findings.append(
                _finding(
                    "P3",
                    spec,
                    "settings",
                    f"/settings/{index}/default",
                    f"default {default} is outside min {low} .. max {high}",
                )
            )
        if setting["step"] <= 0:
            findings.append(
                _finding("P3", spec, "settings", f"/settings/{index}/step", "step must be positive")
            )
        for slot, constraint in enumerate(setting.get("constraints", [])):
            other = constraint["other"]
            if other.startswith("machine."):
                other_value = _machine_path(spec, other)
            else:
                target = setting_by_id(spec, other)
                other_value = None if target is None else float(target["default"])
            if other_value is None:
                continue  # rule R1 reports the dangling reference
            bound = other_value + float(constraint.get("margin", 0))
            if not relations[constraint["relation"]](float(default), bound):
                findings.append(
                    _finding(
                        "P3",
                        spec,
                        "settings",
                        f"/settings/{index}/constraints/{slot}",
                        f"default {default} is not {constraint['relation']} {bound} (from {other})",
                    )
                )

    ratings = (spec.machine or {}).get("ratings", {})

    def rating(name: str) -> float | None:
        entry = ratings.get(name)
        return None if entry is None else float(entry["value"])

    def default_of(setting_id: str) -> float | None:
        setting = setting_by_id(spec, setting_id)
        return None if setting is None else float(setting["default"])

    chain: list[tuple[str, float | None, str, float | None]] = [
        (
            "settings:cut_out_pressure",
            default_of("cut_out_pressure"),
            "machine.ratings.max_working_pressure",
            rating("max_working_pressure"),
        ),
        (
            "settings:discharge_pressure_shutdown",
            default_of("discharge_pressure_shutdown"),
            "machine.ratings.safety_valve_setting",
            rating("safety_valve_setting"),
        ),
        (
            "machine.ratings.safety_valve_setting",
            rating("safety_valve_setting"),
            "machine.ratings.reservoir_design_pressure",
            rating("reservoir_design_pressure"),
        ),
    ]
    for lower_name, lower, upper_name, upper in chain:
        if lower is None or upper is None:
            continue
        if lower > upper:
            key = "settings" if lower_name.startswith("settings:") else "machine"
            pointer = (
                f"/settings/{lower_name.split(':')[1]}"
                if key == "settings"
                else "/" + lower_name.removeprefix("machine.").replace(".", "/")
            )
            findings.append(
                _finding("P3", spec, key, pointer, f"{lower} exceeds {upper_name} ({upper})")
            )
    return findings


def _p4_bands(spec: Spec) -> list[Finding]:
    """Each band is ordered and stays inside the signal range."""
    findings: list[Finding] = []
    for index, signal in enumerate(spec.signal_list):
        signal_range = signal.get("range")
        for state, band in signal.get("normal_bands", {}).items():
            pointer = f"/signals/{index}/normal_bands/{state}"
            if "expected" in band:
                continue
            low, typical, high = band["low"], band["typical"], band["high"]
            if not low <= typical <= high:
                findings.append(
                    _finding(
                        "P4",
                        spec,
                        "signals",
                        pointer,
                        f"band {low} / {typical} / {high} is not ordered",
                    )
                )
            if signal_range and not (signal_range["min"] <= low and high <= signal_range["max"]):
                findings.append(
                    _finding(
                        "P4",
                        spec,
                        "signals",
                        pointer,
                        f"band {low}..{high} leaves the signal range"
                        f" {signal_range['min']}..{signal_range['max']}",
                    )
                )
    return findings


def _p4_thresholds(spec: Spec) -> list[Finding]:
    """Each guarding threshold sits outside the bands of the states it watches."""
    findings: list[Finding] = []
    for index, message, condition in _signal_conditions(spec):
        if _is_compound(condition):
            continue
        op = condition.get("op")
        if op not in ("gt", "gte", "lt", "lte"):
            continue
        signal = signal_by_id(spec, condition.get("signal", ""))
        if signal is None:
            continue
        resolved = resolve_threshold(spec, condition.get("threshold", {}), signal)
        if resolved is None:
            continue
        value = resolved[0]
        guard = message.get("trigger", {}).get("state", "any")
        for state in STATES_BY_GUARD.get(guard, BAND_STATES):
            band = signal.get("normal_bands", {}).get(state)
            if not band or "expected" in band:
                continue
            if op in ("gt", "gte") and value < band["high"]:
                findings.append(
                    _finding(
                        "P4",
                        spec,
                        "alarms",
                        f"/alarms/{index}/trigger/condition/threshold",
                        f"threshold {value} is below the {state} band high {band['high']}"
                        f" of {signal['id']!r}",
                    )
                )
            if op in ("lt", "lte") and value > band["low"]:
                findings.append(
                    _finding(
                        "P4",
                        spec,
                        "alarms",
                        f"/alarms/{index}/trigger/condition/threshold",
                        f"threshold {value} is above the {state} band low {band['low']}"
                        f" of {signal['id']!r}",
                    )
                )
    return findings


def rule_P4(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Normal bands are ordered, sit inside the signal range, and leave room
    below (or above) the message thresholds that guard them.

    The threshold comparison only applies to single-leaf conditions and only to
    the states the message's state guard admits: a leaf inside ``all``/``any``
    is qualified by its siblings, and a message guarded by ``loaded`` says
    nothing about the off-state band.
    """
    del minimums
    return _p4_bands(spec) + _p4_thresholds(spec)


def rule_P5(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Dwell times, start masks and hysteresis units are sane."""
    del minimums
    findings: list[Finding] = []
    for index, message in enumerate(spec.alarm_list):
        trigger = message.get("trigger", {})
        if "for_s" in trigger:
            seconds = resolve_duration(spec, trigger["for_s"])
            if seconds is not None and seconds < 0:
                findings.append(
                    _finding(
                        "P5",
                        spec,
                        "alarms",
                        f"/alarms/{index}/trigger/for_s",
                        f"dwell time {seconds} is negative",
                    )
                )
        if "exclude_start_s" in trigger:
            seconds = resolve_duration(spec, trigger["exclude_start_s"])
            if seconds is not None and seconds < 0:
                findings.append(
                    _finding(
                        "P5",
                        spec,
                        "alarms",
                        f"/alarms/{index}/trigger/exclude_start_s",
                        f"start mask {seconds} is negative",
                    )
                )
            if trigger.get("state") not in ("loaded", "unloaded", "running"):
                findings.append(
                    _finding(
                        "P5",
                        spec,
                        "alarms",
                        f"/alarms/{index}/trigger/exclude_start_s",
                        f"a start mask needs a running state guard, found {trigger.get('state')!r}",
                    )
                )
        hysteresis = message.get("reset", {}).get("hysteresis")
        if hysteresis is None:
            continue
        condition = trigger.get("condition")
        if not isinstance(condition, dict) or _is_compound(condition):
            continue
        signal = signal_by_id(spec, condition.get("signal", ""))
        target = signal or _derived_by_id(spec).get(condition.get("signal", ""))
        if target is not None and hysteresis.get("unit") != target.get("unit"):
            findings.append(
                _finding(
                    "P5",
                    spec,
                    "alarms",
                    f"/alarms/{index}/reset/hysteresis/unit",
                    f"hysteresis unit {hysteresis.get('unit')!r} differs from the signal unit"
                    f" {target.get('unit')!r}",
                )
            )
    return findings


def rule_P6(spec: Spec, minimums: Minimums) -> list[Finding]:
    """The ambient limits match the ambient warnings and the document blocks agree."""
    del minimums
    findings: list[Finding] = []
    ambient = (spec.machine or {}).get("limits", {}).get("ambient_operating")
    if ambient is not None:
        for bound, setting_id in (
            ("max", "ambient_temperature_high_warning"),
            ("min", "ambient_temperature_low_warning"),
        ):
            setting = setting_by_id(spec, setting_id)
            if setting is None:
                continue
            if float(ambient[bound]) != float(setting["default"]):
                findings.append(
                    _finding(
                        "P6",
                        spec,
                        "machine",
                        f"/limits/ambient_operating/{bound}",
                        f"{ambient[bound]} differs from the default of {setting_id!r}"
                        f" ({setting['default']})",
                    )
                )

    machine_document = (spec.machine or {}).get("document")
    build_document = (spec.build or {}).get("document")
    if machine_document and build_document:
        for field in ("number", "revision", "revision_date"):
            if machine_document.get(field) != build_document.get(field):
                findings.append(
                    _finding(
                        "P6",
                        spec,
                        "machine",
                        f"/document/{field}",
                        f"{machine_document.get(field)!r} differs from build.yaml"
                        f" ({build_document.get(field)!r})",
                    )
                )
    return findings


# --- rules: MetroPT-3 mapping and derived bands ---------------------------


def rule_M1(spec: Spec, minimums: Minimums) -> list[Finding]:
    """The mapped tags are exactly the fifteen MetroPT-3 columns; extras are authored."""
    del minimums
    findings: list[Finding] = []
    mapped: dict[str, int] = {}
    for index, signal in enumerate(spec.signal_list):
        column = signal.get("metropt_column")
        if column is None:
            if signal.get("band", {}).get("source") != "authored":
                findings.append(
                    _finding(
                        "M1",
                        spec,
                        "signals",
                        f"/signals/{index}/band/source",
                        "a signal without a MetroPT column needs band.source authored",
                    )
                )
            continue
        mapped[column] = index
    for column in sorted(set(mapped) - METROPT_COLUMNS):
        findings.append(
            _finding(
                "M1",
                spec,
                "signals",
                f"/signals/{mapped[column]}/metropt_column",
                f"{column!r} is not a MetroPT-3 header column",
            )
        )
    for column in sorted(METROPT_COLUMNS - set(mapped)):
        findings.append(
            _finding(
                "M1",
                spec,
                "signals",
                "/signals",
                f"MetroPT-3 column {column!r} is mapped by no tag",
            )
        )
    return findings


def rule_M2(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Signals are grouped in register order and scaled per kind."""
    del minimums
    findings: list[Finding] = []
    groups = [signal.get("group") for signal in spec.signal_list]
    position = 0
    for index, group in enumerate(groups):
        if group not in GROUP_ORDER:
            continue
        rank = GROUP_ORDER.index(group)
        if rank < position:
            findings.append(
                _finding(
                    "M2",
                    spec,
                    "signals",
                    f"/signals/{index}/group",
                    f"group {group!r} appears after {GROUP_ORDER[position]!r}; file order must be"
                    f" {' then '.join(GROUP_ORDER)}",
                )
            )
        position = max(position, rank)
    for group, expected in GROUP_COUNTS.items():
        actual = groups.count(group)
        if actual != expected:
            findings.append(
                _finding(
                    "M2",
                    spec,
                    "signals",
                    "/signals",
                    f"expected {expected} {group} tags, found {actual}",
                )
            )
    for index, signal in enumerate(spec.signal_list):
        expected_scale = SCALE_BY_KIND.get(signal.get("kind", ""))
        if expected_scale is None:
            continue
        actual_scale = signal.get("modbus", {}).get("scale")
        if actual_scale != expected_scale:
            findings.append(
                _finding(
                    "M2",
                    spec,
                    "signals",
                    f"/signals/{index}/modbus/scale",
                    f"kind {signal['kind']!r} expects scale {expected_scale}, found {actual_scale}",
                )
            )
    return findings


def _b1_signal_bands(spec: Spec) -> list[Finding]:
    """Every derived signal's bands equal the committed derivation."""
    findings: list[Finding] = []
    bands = (spec.bands or {}).get("signals", {})
    for index, signal in enumerate(spec.signal_list):
        if signal.get("band", {}).get("source") != "derived":
            continue
        derived_states = bands.get(signal["id"])
        if derived_states is None:
            findings.append(
                _finding(
                    "B1",
                    spec,
                    "signals",
                    f"/signals/{index}/normal_bands",
                    f"{signal['id']!r} has no entry in the derived bands",
                )
            )
            continue
        for state, band in signal.get("normal_bands", {}).items():
            pointer = f"/signals/{index}/normal_bands/{state}"
            derived_band = derived_states.get(state)
            if derived_band is None:
                findings.append(
                    _finding(
                        "B1", spec, "signals", pointer, f"the derived bands have no {state} entry"
                    )
                )
                continue
            for field in ("low", "typical", "high", "expected"):
                if field not in band:
                    continue
                if band[field] != derived_band.get(field):
                    findings.append(
                        _finding(
                            "B1",
                            spec,
                            "signals",
                            f"{pointer}/{field}",
                            f"{band[field]!r} differs from the derived value"
                            f" {derived_band.get(field)!r}",
                        )
                    )
    return findings


def _b1_reference_operation(spec: Spec) -> list[Finding]:
    """machine.yaml reference_operation equals the derived cycle block."""
    findings: list[Finding] = []
    cycle = (spec.bands or {}).get("cycle", {})
    for field, quantity in ((spec.machine or {}).get("reference_operation", {})).items():
        if field not in cycle:
            findings.append(
                _finding(
                    "B1",
                    spec,
                    "machine",
                    f"/reference_operation/{field}",
                    "the derived cycle block has no such figure",
                )
            )
            continue
        expected = cycle[field]
        if isinstance(expected, dict):
            actual = {"min": quantity.get("min"), "max": quantity.get("max")}
            if actual != {"min": expected.get("min"), "max": expected.get("max")}:
                findings.append(
                    _finding(
                        "B1",
                        spec,
                        "machine",
                        f"/reference_operation/{field}",
                        f"{actual} differs from the derived band {expected}",
                    )
                )
        elif quantity.get("value") != expected:
            findings.append(
                _finding(
                    "B1",
                    spec,
                    "machine",
                    f"/reference_operation/{field}/value",
                    f"{quantity.get('value')!r} differs from the derived value {expected!r}",
                )
            )
    return findings


def rule_B1(spec: Spec, minimums: Minimums) -> list[Finding]:
    """signals.yaml bands and machine.yaml reference operation copy the derived JSON."""
    del minimums
    return _b1_signal_bands(spec) + _b1_reference_operation(spec)


def rule_B2(spec: Spec, minimums: Minimums) -> list[Finding]:
    """The derived bands come from the first MetroPT-3 month of the pinned CSV."""
    del minimums
    findings: list[Finding] = []
    provenance = (spec.bands or {}).get("provenance", {})

    def fail(pointer: str, message: str) -> None:
        findings.append(_finding("B2", spec, "bands", pointer, message))

    if provenance.get("source_sha256") != BANDS_SOURCE_SHA256:
        fail("/provenance/source_sha256", f"expected {BANDS_SOURCE_SHA256}")
    if provenance.get("range") != BANDS_RANGE:
        fail("/provenance/range", f"expected {BANDS_RANGE}")
    if provenance.get("rows_total") != BANDS_ROWS_TOTAL:
        fail("/provenance/rows_total", f"expected {BANDS_ROWS_TOTAL}")
    rows_used = provenance.get("rows_used", 0)
    if not isinstance(rows_used, int) or rows_used <= BANDS_MIN_ROWS_USED:
        fail(
            "/provenance/rows_used", f"expected more than {BANDS_MIN_ROWS_USED}, found {rows_used}"
        )
    if provenance.get("range_override") is not False:
        fail("/provenance/range_override", "a band file derived with --range must not be committed")
    return findings


# --- rules: ambiguity of the fault catalog --------------------------------


def _sharing(spec: Spec) -> dict[str, set[str]]:
    """Map each condition id to the condition ids it shares a cause with."""
    conditions = spec.condition_list
    causes_of = {
        condition["id"]: {entry["fault_id"] for entry in condition.get("causes", [])}
        for condition in conditions
    }
    shared: dict[str, set[str]] = {condition["id"]: set() for condition in conditions}
    ids = list(causes_of)
    for left_index, left in enumerate(ids):
        for right in ids[left_index + 1 :]:
            if causes_of[left] & causes_of[right]:
                shared[left].add(right)
                shared[right].add(left)
    return shared


def rule_A1(spec: Spec, minimums: Minimums) -> list[Finding]:
    """The catalog is large enough and ambiguous enough to be worth diagnosing."""
    findings: list[Finding] = []
    conditions = len(spec.condition_list)
    causes = len(spec.cause_list)
    sharing = sum(1 for partners in _sharing(spec).values() if partners)
    for actual, wanted, pointer, label in (
        (conditions, minimums.conditions, "/conditions", "conditions"),
        (causes, minimums.causes, "/causes", "causes"),
        (sharing, minimums.sharing, "/conditions", "conditions sharing a cause"),
    ):
        if actual < wanted:
            findings.append(
                _finding(
                    "A1", spec, "faults", pointer, f"{actual} {label}, expected at least {wanted}"
                )
            )
    return findings


def rule_A2(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Every subsystem that carries a signal also carries at least one cause."""
    del minimums
    covered = {str(cause.get("subsystem")) for cause in spec.cause_list}
    findings: list[Finding] = []
    for subsystem in _signal_subsystems(spec):
        if subsystem not in covered:
            findings.append(
                _finding(
                    "A2",
                    spec,
                    "faults",
                    "/causes",
                    f"subsystem {subsystem!r} has a signal but no cause",
                )
            )
    return findings


def rule_A3(spec: Spec, minimums: Minimums) -> list[Finding]:
    """The catalog holds benign causes with alarming symptoms."""
    benign = sum(1 for cause in spec.cause_list if cause.get("benign"))
    if benign >= minimums.benign:
        return []
    return [
        _finding(
            "A3",
            spec,
            "faults",
            "/causes",
            f"{benign} benign causes, expected at least {minimums.benign}",
        )
    ]


def rule_A4(spec: Spec, minimums: Minimums) -> list[Finding]:
    """The distribution leak is listed under both conditions the data shows it in."""
    del minimums
    findings: list[Finding] = []
    for condition_id in ("low_line_pressure", "frequent_cycling"):
        condition = condition_by_id(spec, condition_id)
        if condition is None:
            findings.append(
                _finding(
                    "A4", spec, "faults", "/conditions", f"condition {condition_id!r} is missing"
                )
            )
            continue
        listed = {entry["fault_id"] for entry in condition.get("causes", [])}
        if "downstream_air_leak" not in listed:
            findings.append(
                _finding(
                    "A4",
                    spec,
                    "faults",
                    f"/conditions/{spec.condition_list.index(condition)}/causes",
                    f"condition {condition_id!r} does not list 'downstream_air_leak'",
                )
            )
    return findings


def rule_A5(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Every cause carries usable evidence: moves, checks and a remedy."""
    del minimums
    findings: list[Finding] = []
    behaviours = _behaviour_ids(spec)
    for index, cause in enumerate(spec.cause_list):
        if not cause.get("signal_moves"):
            findings.append(
                _finding(
                    "A5", spec, "faults", f"/causes/{index}/signal_moves", "no signal move listed"
                )
            )
        if not cause.get("checks"):
            findings.append(
                _finding("A5", spec, "faults", f"/causes/{index}/checks", "no check listed")
            )
        if not (cause.get("remedy") or "").strip():
            findings.append(
                _finding("A5", spec, "faults", f"/causes/{index}/remedy", "no remedy given")
            )
        for slot, move in enumerate(cause.get("signal_moves", [])):
            pointer = f"/causes/{index}/signal_moves/{slot}/direction"
            direction = move.get("direction")
            if "behaviour" in move:
                if move["behaviour"] in behaviours and direction not in BEHAVIOUR_DIRECTIONS:
                    findings.append(
                        _finding(
                            "A5",
                            spec,
                            "faults",
                            pointer,
                            f"{direction!r} is not a behaviour direction",
                        )
                    )
                continue
            signal = signal_by_id(spec, move.get("signal", ""))
            if signal is None:
                continue  # rule R1 reports the dangling target
            allowed = DIGITAL_DIRECTIONS if signal["group"] == "digital" else ANALOG_DIRECTIONS
            if direction not in allowed:
                findings.append(
                    _finding(
                        "A5",
                        spec,
                        "faults",
                        pointer,
                        f"{direction!r} is not a {signal['group']} signal direction",
                    )
                )
    return findings


def rule_N2(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Cause summaries and move notes are written in words, never in digits."""
    del minimums
    findings: list[Finding] = []
    for index, cause in enumerate(spec.cause_list):
        if _DIGIT.search(cause.get("summary", "")):
            findings.append(
                _finding(
                    "N2", spec, "faults", f"/causes/{index}/summary", "summary contains a digit"
                )
            )
        for slot, move in enumerate(cause.get("signal_moves", [])):
            if _DIGIT.search(move.get("note", "")):
                findings.append(
                    _finding(
                        "N2",
                        spec,
                        "faults",
                        f"/causes/{index}/signal_moves/{slot}/note",
                        "note contains a digit",
                    )
                )
    return findings


def rule_L1(spec: Spec, minimums: Minimums) -> list[Finding]:
    """Every file under the spec root carries an SPDX header or a .license sidecar."""
    del minimums
    findings: list[Finding] = []
    root = spec.root
    if not root.is_dir():
        return findings
    for path in _spdx_files(root):
        relative = path.relative_to(root).as_posix()
        if path.suffix == ".json":
            if not path.with_name(path.name + ".license").is_file():
                findings.append(Finding("L1", relative, "/", "missing .license sidecar"))
            continue
        if path.suffix not in SPDX_HEADER_SUFFIXES:
            continue
        head = "\n".join(path.read_text(encoding="utf-8").splitlines()[:SPDX_HEADER_LINES])
        if "SPDX-FileCopyrightText" not in head or "SPDX-License-Identifier" not in head:
            findings.append(
                Finding(
                    "L1", relative, "/", f"no SPDX header in the first {SPDX_HEADER_LINES} lines"
                )
            )
    return findings


# --- rule registry --------------------------------------------------------

RULES: dict[str, Rule] = {
    "S1": Rule(rule_S1, (), "schema validity and schema_version"),
    "S2": Rule(rule_S2, (), "identifier, code, bit, parameter and label uniqueness"),
    "R1": Rule(
        rule_R1,
        ("machine", "signals", "settings", "alarms", "faults", "maintenance"),
        "every reference resolves",
    ),
    "R2": Rule(rule_R2, ("faults",), "condition and cause graph completeness"),
    "R3": Rule(rule_R3, ("alarms", "faults"), "evaluable messages are reachable from a condition"),
    "R4": Rule(rule_R4, ("settings", "alarms"), "every setting is used"),
    "R5": Rule(rule_R5, ("alarms", "maintenance"), "service messages match maintenance tasks"),
    "P1": Rule(rule_P1, ("alarms", "settings"), "message families rise in severity"),
    "P2": Rule(
        rule_P2, ("alarms", "settings", "signals", "machine"), "thresholds and ranges agree"
    ),
    "P3": Rule(rule_P3, ("settings", "machine"), "setting bounds and constraints hold"),
    "P4": Rule(
        rule_P4, ("signals", "alarms", "settings"), "normal bands leave room below thresholds"
    ),
    "P5": Rule(rule_P5, ("alarms", "settings", "signals"), "dwell, start mask and hysteresis"),
    "P6": Rule(rule_P6, ("machine", "settings", "build"), "ambient limits and document metadata"),
    "M1": Rule(rule_M1, ("signals",), "the fifteen MetroPT-3 columns are mapped"),
    "M2": Rule(rule_M2, ("signals",), "register order and Modbus scales"),
    "B1": Rule(rule_B1, ("signals", "machine", "bands"), "bands copy the derived JSON"),
    "B2": Rule(rule_B2, ("bands",), "band provenance"),
    "A1": Rule(rule_A1, ("faults",), "catalog size and sharing"),
    "A2": Rule(rule_A2, ("faults", "signals"), "subsystem coverage"),
    "A3": Rule(rule_A3, ("faults",), "benign causes"),
    "A4": Rule(rule_A4, ("faults",), "the distribution leak is listed twice"),
    "A5": Rule(rule_A5, ("faults", "signals"), "cause evidence and move vocabulary"),
    "N2": Rule(rule_N2, ("faults",), "no digits in summaries and move notes"),
    "L1": Rule(rule_L1, (), "SPDX headers and .license sidecars"),
}


def run_rules(
    spec: Spec, minimums: Minimums, rule_ids: Iterable[str] | None = None
) -> tuple[list[Finding], list[str]]:
    """Run the rules whose files are present.

    Returns the findings and one ``SKIP <rule> needs <file>`` line per rule that
    could not run.
    """
    findings: list[Finding] = []
    skipped: list[str] = []
    for rule_id in RULES if rule_ids is None else rule_ids:
        rule = RULES[rule_id]
        missing = [key for key in rule.needs if key not in spec.files_present]
        if missing:
            skipped.append(
                f"SKIP {rule_id} needs {', '.join(SPEC_FILES[key][0] for key in missing)}"
            )
            continue
        findings.extend(rule.func(spec, minimums))
    return findings, skipped


# --- report ---------------------------------------------------------------


def build_report(spec: Spec, minimums: Minimums) -> list[str]:
    """Return the metric lines of ``--report``."""
    del minimums
    lines: list[str] = ["REPORT"]
    lines.append(f"  files present: {', '.join(sorted(spec.files_present)) or '(none)'}")
    lines.append(f"  signals: {len(spec.signal_list)}")
    if spec.signals:
        by_group: dict[str, int] = defaultdict(int)
        for signal in spec.signal_list:
            by_group[signal.get("group", "?")] += 1
        lines.append(
            "    by group: " + ", ".join(f"{group}={by_group[group]}" for group in sorted(by_group))
        )
        mapped = sum(1 for signal in spec.signal_list if signal.get("metropt_column"))
        lines.append(f"    mapped to MetroPT-3: {mapped}")
        lines.append(f"  derived signals: {len((spec.signals or {}).get('derived', []))}")
        lines.append(f"  behaviours: {len(_behaviour_ids(spec))}")
    if spec.settings:
        lines.append(f"  settings: {len(spec.setting_list)}")
    if spec.alarms:
        by_type: dict[str, int] = defaultdict(int)
        for message in spec.alarm_list:
            by_type[message.get("type", "?")] += 1
        lines.append(f"  messages: {len(spec.alarm_list)}")
        lines.append(
            "    by type: " + ", ".join(f"{name}={by_type[name]}" for name in sorted(by_type))
        )
        bits = sorted(
            message["bit"] for message in spec.alarm_list if isinstance(message.get("bit"), int)
        )
        lines.append(
            f"    evaluable bits: {len(bits)}" + (f" ({bits[0]}..{bits[-1]})" if bits else "")
        )
    if spec.maintenance:
        lines.append(f"  maintenance tasks: {len(spec.task_list)}")
    if spec.faults:
        lines.append(f"  conditions: {len(spec.condition_list)}")
        lines.append(f"  causes: {len(spec.cause_list)}")
        benign = [cause["fault_id"] for cause in spec.cause_list if cause.get("benign")]
        lines.append(f"  benign causes ({len(benign)}): {', '.join(sorted(benign)) or '(none)'}")
        shared = _sharing(spec)
        lines.append(
            f"  conditions sharing a cause: {sum(1 for value in shared.values() if value)}"
        )
        lines.append("  sharing matrix:")
        for condition_id in sorted(shared):
            partners = ", ".join(sorted(shared[condition_id])) or "(none)"
            lines.append(f"    {condition_id} -> {partners}")
        if spec.signals:
            covered: dict[str, list[str]] = defaultdict(list)
            for cause in spec.cause_list:
                covered[cause.get("subsystem", "?")].append(cause["fault_id"])
            lines.append("  subsystem coverage:")
            for subsystem in _signal_subsystems(spec):
                lines.append(f"    {subsystem}: {len(covered.get(subsystem, []))} cause(s)")
    return lines


# --- CLI ------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="validate.py",
        description="Validate the CAU-7 manual source of truth.",
    )
    parser.add_argument("--spec", default="manual", help="spec root holding build.yaml and spec/")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="fail when a source YAML or the derived bands file is missing",
    )
    parser.add_argument(
        "--only",
        default=None,
        help="comma-separated file keys to load: " + ", ".join(SPEC_FILES),
    )
    parser.add_argument(
        "--minimums",
        default=None,
        metavar="CONDITIONS,CAUSES,SHARING,BENIGN",
        help="catalog floors for rule A1 (default 12,30,5,2)",
    )
    parser.add_argument("--report", action="store_true", help="print the catalog metrics")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the validator; return the process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path(args.spec)

    try:
        minimums = Minimums() if args.minimums is None else Minimums.parse(args.minimums)
    except ValueError as exc:
        parser.error(f"--minimums: {exc}")

    only: set[str] | None = None
    if args.only:
        only = {part.strip() for part in args.only.split(",") if part.strip()}
        unknown = sorted(only - set(SPEC_FILES))
        if unknown:
            parser.error(f"--only: unknown file key(s) {', '.join(unknown)}")

    failed = False
    if args.strict:
        for key in (*YAML_FILE_KEYS, "bands"):
            if not (root / SPEC_FILES[key][0]).is_file():
                print(f"S1 {SPEC_FILES[key][0]}:/ missing (--strict)")
                failed = True

    try:
        spec = load_spec(root, only)
    except SpecError as exc:
        for message in exc.messages:
            print(f"S1 {message}")
        return 1

    findings, skipped = run_rules(spec, minimums)
    for line in skipped:
        print(line)
    for finding in findings:
        print(finding)
    if args.report:
        for line in build_report(spec, minimums):
            print(line)
    return 1 if findings or failed else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``manual/spec/*.yaml`` → :class:`~fdp_manual_build.model.Manual`.

Parsing and JSON Schema validation are the manual's job: this module wraps
``manual/tools/load.py::load_spec``, which reads the documents
with a YAML 1.2 safe loader and validates each against
``manual/spec/schemas/<name>.schema.json``. Every schema violation is turned
into a :class:`~fdp_manual_build.errors.LoadError`, and all of them are
reported together.

On top of that this module maps the manual's mappings onto the frozen dataclasses of
:mod:`fdp_manual_build.model` and runs the uniqueness checks the build relies
on. Cross-document reference checks stay with ``manual/tools/validate.py``.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Final

from fdp_manual_build.errors import BuildError, LoadError
from fdp_manual_build.manual_tools import spec_loader
from fdp_manual_build.model import (
    Alarm,
    AlarmCondition,
    AlarmLeaf,
    AlarmReset,
    AlarmTrigger,
    AnalogBand,
    Behaviour,
    Cause,
    Component,
    Condition,
    ConditionCause,
    Constraint,
    Consumable,
    DerivedSignal,
    DigitalBand,
    DocumentInfo,
    Duration,
    Identity,
    Interval,
    LowPressureSwitch,
    Machine,
    MachineStates,
    MaintenanceTask,
    Manual,
    Modbus,
    NormalBand,
    Parameter,
    Part,
    Quantity,
    Sensor,
    SettingRef,
    Signal,
    SignalMove,
    Span,
    Threshold,
    ValueRange,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.config import BuildConfig
    from fdp_manual_build.manual_tools import Spec

__all__ = ["SPEC_KEYS", "load_manual"]

#: The documents the PDF build reads, in the manual's ``SPEC_FILES`` spelling.
SPEC_KEYS: Final = ("machine", "signals", "settings", "alarms", "faults", "maintenance", "bands")
#: ``bands`` is derived and optional; the six others must be there.
_REQUIRED_KEYS: Final = SPEC_KEYS[:-1]


def load_manual(repo_root: Path, cfg: BuildConfig) -> Manual:
    """Read and map every manual source document under ``cfg.manual_root``.

    Args:
        repo_root: the checkout that provides ``manual/tools/load.py`` and the
            schemas under ``manual/spec/schemas``.
        cfg: the parsed ``build.yaml``; ``cfg.manual_root`` is the tree to read.

    Raises:
        BuildError: when a document is missing, fails its schema or breaks one
            of the uniqueness rules. Every problem is reported at once, each
            with its file and JSON pointer.
    """
    loader = spec_loader(repo_root)
    try:
        spec = loader.load_spec(root=cfg.manual_root, only=set(SPEC_KEYS))
    except loader.SpecError as error:
        messages: Sequence[str] = getattr(error, "messages", [str(error)])
        raise BuildError(
            f"{cfg.manual_root}: the manual spec does not validate",
            [LoadError.parse(message) for message in messages],
        ) from error

    errors: list[LoadError] = [
        LoadError(loader.SPEC_FILES[key][0], "", "missing")
        for key in _REQUIRED_KEYS
        if key not in spec.files_present
    ]
    if errors:
        raise BuildError(f"{cfg.manual_root}: the manual spec is incomplete", errors)

    signals_doc = _document(spec, "signals")
    faults_doc = _document(spec, "faults")
    manual = Manual(
        machine=_machine(_document(spec, "machine")),
        signals=tuple(_signal(item) for item in signals_doc["signals"]),
        alarms=tuple(_alarm(item) for item in _document(spec, "alarms")["alarms"]),
        conditions=tuple(_condition(item) for item in faults_doc["conditions"]),
        causes=MappingProxyType(
            {str(item["fault_id"]): _cause(item) for item in faults_doc["causes"]}
        ),
        maintenance=tuple(_task(item) for item in _document(spec, "maintenance")["tasks"]),
        parameters=tuple(_parameter(item) for item in _document(spec, "settings")["settings"]),
        machine_states=_machine_states(signals_doc["machine_states"]),
        derived_signals=tuple(_derived(item) for item in signals_doc["derived"]),
        behaviours=tuple(_behaviour(item) for item in signals_doc["behaviours"]),
        bands=_bands(spec),
        source_hashes=_source_hashes(spec, loader.SPEC_FILES, cfg),
    )
    _check_uniqueness(manual, faults_doc, errors)
    if errors:
        raise BuildError(f"{cfg.manual_root}: the manual spec has duplicate ids", errors)
    return manual


# --- uniqueness -----------------------------------------------------------


def _check_uniqueness(
    manual: Manual,
    faults_doc: Mapping[str, Any],
    errors: list[LoadError],
) -> None:
    signals = "spec/signals.yaml"
    _unique(errors, signals, "/signals/{}/id", [item.id for item in manual.signals], "signal id")
    _unique(
        errors,
        signals,
        "/signals/{}/metropt_column",
        [item.metropt_column for item in manual.signals],
        "MetroPT-3 column",
    )
    alarms = "spec/alarms.yaml"
    _unique(errors, alarms, "/alarms/{}/code", [item.code for item in manual.alarms], "alarm code")
    _unique(errors, alarms, "/alarms/{}/bit", [item.bit for item in manual.alarms], "alarm bit")
    faults = "spec/faults.yaml"
    _unique(
        errors,
        faults,
        "/conditions/{}/id",
        [item["id"] for item in faults_doc["conditions"]],
        "condition id",
    )
    _unique(
        errors,
        faults,
        "/causes/{}/fault_id",
        [item["fault_id"] for item in faults_doc["causes"]],
        "fault id",
    )
    _unique(
        errors,
        "spec/maintenance.yaml",
        "/tasks/{}/id",
        [item.id for item in manual.maintenance],
        "task id",
    )
    _unique(
        errors,
        "spec/settings.yaml",
        "/settings/{}/id",
        [item.id for item in manual.parameters],
        "parameter id",
    )


def _unique(
    errors: list[LoadError],
    relative: str,
    pointer: str,
    values: Sequence[object],
    label: str,
) -> None:
    """Record a :class:`LoadError` for every repeated, non-``None`` value."""
    first_seen: dict[object, int] = {}
    for index, value in enumerate(values):
        if value is None:
            continue
        first = first_seen.setdefault(value, index)
        if first != index:
            errors.append(
                LoadError(
                    relative,
                    pointer.format(index),
                    f"duplicate {label} {value!r}, first used at index {first}",
                )
            )


# --- scalars --------------------------------------------------------------


def _document(spec: Spec, key: str) -> Mapping[str, Any]:
    document = spec.document(key)
    if document is None:  # pragma: no cover - presence checked by the caller
        raise BuildError(f"{spec.root}: {key} was not loaded")
    return document


def _quantity(raw: Mapping[str, Any]) -> Quantity:
    return Quantity(value=float(raw["value"]), unit=str(raw["unit"]))


def _span(raw: Mapping[str, Any]) -> Span:
    return Span(min=float(raw["min"]), max=float(raw["max"]), unit=str(raw["unit"]))


def _quantity_or_span(raw: Mapping[str, Any]) -> Quantity | Span:
    return _span(raw) if "min" in raw else _quantity(raw)


def _optional_quantity(raw: Mapping[str, Any] | None) -> Quantity | None:
    return None if raw is None else _quantity(raw)


def _threshold(raw: Mapping[str, Any]) -> Threshold:
    if "value" in raw:
        return _quantity(raw)
    return SettingRef(setting=str(raw["setting"]), offset=float(raw.get("offset", 0.0)))


def _duration(raw: int | Mapping[str, Any] | None) -> Duration | None:
    if raw is None:
        return None
    if isinstance(raw, Mapping):
        return SettingRef(setting=str(raw["setting"]), offset=float(raw.get("offset", 0.0)))
    return int(raw)


def _text(raw: Mapping[str, Any], key: str) -> str | None:
    value = raw.get(key)
    return None if value is None else str(value)


def _strings(raw: Mapping[str, Any], key: str) -> tuple[str, ...]:
    return tuple(str(item) for item in raw.get(key, ()))


def _enum(value: object) -> Any:
    """A string the schema already restricted to one ``Literal`` member.

    The JSON Schema ran before this module did, so the value is known to be one
    of the allowed members. Returning ``Any`` is the single, named place where
    that trust is expressed instead of a ``cast`` at every field.
    """
    return str(value)


# --- machine.yaml ---------------------------------------------------------


def _machine(raw: Mapping[str, Any]) -> Machine:
    switch = raw.get("hardware_switches", {}).get("low_pressure_switch")
    return Machine(
        identity=Identity(
            model=raw["identity"]["model"],
            name=raw["identity"]["name"],
            controller=raw["identity"]["controller"],
            type=raw["identity"]["type"],
            serial_format=raw["identity"]["serial_format"],
        ),
        document=DocumentInfo(
            number=raw["document"]["number"],
            revision=raw["document"]["revision"],
            revision_date=raw["document"]["revision_date"],
        ),
        ratings=_frozen({key: _quantity(item) for key, item in raw["ratings"].items()}),
        limits=_frozen({key: _quantity_or_span(item) for key, item in raw["limits"].items()}),
        reference_conditions=_frozen(
            {key: _quantity(item) for key, item in raw.get("reference_conditions", {}).items()}
        ),
        low_pressure_switch=None
        if switch is None
        else LowPressureSwitch(
            closes_below=_quantity(switch["closes_below"]),
            opens_above=_quantity(switch["opens_above"]),
            signal=str(switch["signal"]),
        ),
        sensors=tuple(
            Sensor(
                signal=str(item["signal"]),
                kind=str(item["kind"]),
                range=_span(item["range"]),
                accuracy=_optional_quantity(item.get("accuracy")),
            )
            for item in raw["sensors"]
        ),
        components=tuple(
            Component(
                id=str(item["id"]),
                name=str(item["name"]),
                subsystem=_enum(item["subsystem"]),
                description_md=_text(item, "description"),
                description_html=None,
            )
            for item in raw["components"]
        ),
        parts=tuple(
            Part(
                id=str(item["id"]),
                code=str(item["code"]),
                name=str(item["name"]),
                description_md=_text(item, "description"),
                description_html=None,
                unit=_text(item, "unit"),
            )
            for item in raw["parts"]
        ),
        reference_operation=_frozen(
            {key: _quantity_or_span(item) for key, item in raw["reference_operation"].items()}
        ),
        subsystems=tuple(_enum(item) for item in raw["subsystems"]),
    )


# --- signals.yaml ---------------------------------------------------------


def _signal(raw: Mapping[str, Any]) -> Signal:
    range_raw = raw.get("range")
    return Signal(
        id=str(raw["id"]),
        panel_label=str(raw["panel_label"]),
        name=str(raw["name"]),
        metropt_column=_text(raw, "metropt_column"),
        group=_enum(raw["group"]),
        kind=_enum(raw["kind"]),
        unit=str(raw["unit"]),
        subsystem=_enum(raw["subsystem"]),
        description_md=str(raw["description"]),
        description_html=None,
        source_note=_text(raw, "source_note"),
        sample_rate_s=int(raw["sample_rate_s"]),
        range=None
        if range_raw is None
        else ValueRange(min=float(range_raw["min"]), max=float(range_raw["max"])),
        decimals=None if "display" not in raw else int(raw["display"]["decimals"]),
        band_step=float(raw["band"]["step"]),
        band_source=_enum(raw["band"]["source"]),
        modbus=Modbus(type=_enum(raw["modbus"]["type"]), scale=float(raw["modbus"]["scale"])),
        normal_bands=_frozen(
            {state: _band(item) for state, item in raw["normal_bands"].items()},
        ),
        shown_in_schematic=bool(raw["shown_in_schematic"]),
    )


def _band(raw: Mapping[str, Any]) -> NormalBand:
    if "expected" in raw:
        return DigitalBand(expected=raw["expected"])
    return AnalogBand(low=float(raw["low"]), typical=float(raw["typical"]), high=float(raw["high"]))


def _machine_states(raw: Mapping[str, Any]) -> MachineStates:
    return MachineStates(
        order=tuple(str(item) for item in raw["order"]),
        running_threshold=_quantity(raw["running_threshold"]),
        rules=_frozen({key: str(value) for key, value in raw["rules"].items()}),
        running_aliases=tuple(str(item) for item in raw["aliases"]["running"]),
        start_event=str(raw["start_event"]),
    )


def _derived(raw: Mapping[str, Any]) -> DerivedSignal:
    return DerivedSignal(
        id=str(raw["id"]),
        kind=str(raw["kind"]),
        unit=str(raw["unit"]),
        inputs=_strings(raw, "inputs"),
        input=_text(raw, "input"),
        state=_text(raw, "state"),
        states=_strings(raw, "states"),
        event=_text(raw, "event"),
        window_s=None if "window_s" not in raw else int(raw["window_s"]),
        reset_on_state_exit=_text(raw, "reset_on_state_exit"),
    )


def _behaviour(raw: Mapping[str, Any]) -> Behaviour:
    return Behaviour(
        id=str(raw["id"]),
        description_md=str(raw["description"]),
        description_html=None,
    )


# --- alarms.yaml ----------------------------------------------------------


def _alarm(raw: Mapping[str, Any]) -> Alarm:
    return Alarm(
        code=str(raw["code"]),
        type=_enum(raw["type"]),
        bit=None if raw["bit"] is None else int(raw["bit"]),
        evaluation=_enum(raw["evaluation"]),
        family=_text(raw, "family"),
        rank=None if "rank" not in raw else int(raw["rank"]),
        title=str(raw["title"]),
        display=str(raw["display"]),
        effect=_enum(raw["effect"]),
        trigger=_trigger(raw["trigger"]),
        reset=AlarmReset(
            mode=_enum(raw["reset"]["mode"]),
            hysteresis=_optional_quantity(raw["reset"].get("hysteresis")),
            note=_text(raw["reset"], "note"),
        ),
        cause_hint_md=_text(raw, "cause_hint"),
        cause_hint_html=None,
        operator_action_md=_text(raw, "operator_action"),
        operator_action_html=None,
        related_conditions=_strings(raw, "related_conditions"),
    )


def _trigger(raw: Mapping[str, Any]) -> AlarmTrigger:
    counter = raw.get("counter", {})
    tasks = counter.get("tasks", [counter["task"]] if "task" in counter else [])
    return AlarmTrigger(
        kind=_enum(raw["kind"]),
        state=_text(raw, "state"),
        exclude_start_s=_duration(raw.get("exclude_start_s")),
        condition=None if "condition" not in raw else _alarm_condition(raw["condition"]),
        for_s=_duration(raw.get("for_s")),
        counter_derived=_text(counter, "derived"),
        counter_tasks=tuple(str(item) for item in tasks),
        input=_text(raw, "input"),
    )


def _alarm_condition(raw: Mapping[str, Any]) -> AlarmCondition:
    for mode in ("all", "any"):
        if mode in raw:
            return AlarmCondition(mode=_enum(mode), leaves=tuple(_leaf(item) for item in raw[mode]))
    return AlarmCondition(mode="leaf", leaves=(_leaf(raw),))


def _leaf(raw: Mapping[str, Any]) -> AlarmLeaf:
    return AlarmLeaf(
        signal=str(raw["signal"]),
        op=_enum(raw["op"]),
        threshold=_threshold(raw["threshold"]),
    )


# --- faults.yaml ----------------------------------------------------------


def _condition(raw: Mapping[str, Any]) -> Condition:
    return Condition(
        id=str(raw["id"]),
        title=str(raw["title"]),
        symptom_md=str(raw["symptom"]),
        symptom_html=None,
        alarms=_strings(raw, "alarms"),
        signals=_strings(raw, "signals"),
        causes=tuple(
            ConditionCause(
                fault_id=str(item["fault_id"]),
                likelihood=_enum(item["likelihood"]),
                note_md=_text(item, "note"),
                note_html=None,
            )
            for item in raw["causes"]
        ),
    )


def _cause(raw: Mapping[str, Any]) -> Cause:
    return Cause(
        fault_id=str(raw["fault_id"]),
        name=str(raw["name"]),
        subsystem=_enum(raw["subsystem"]),
        benign=bool(raw["benign"]),
        summary_md=str(raw["summary"]),
        summary_html=None,
        signal_moves=tuple(_move(item) for item in raw["signal_moves"]),
        checks_md=_strings(raw, "checks"),
        checks_html=None,
        remedy_md=str(raw["remedy"]),
        remedy_html=None,
        parts=_strings(raw, "parts"),
        maintenance=_strings(raw, "maintenance"),
        components=_strings(raw, "components"),
        deprecated=bool(raw.get("deprecated", False)),
        successor=_text(raw, "successor"),
    )


def _move(raw: Mapping[str, Any]) -> SignalMove:
    return SignalMove(
        signal=_text(raw, "signal"),
        behaviour=_text(raw, "behaviour"),
        direction=str(raw["direction"]),
        phase=_text(raw, "phase"),
        onset=_text(raw, "onset"),
        note_md=_text(raw, "note"),
        note_html=None,
    )


# --- maintenance.yaml and settings.yaml -----------------------------------


def _task(raw: Mapping[str, Any]) -> MaintenanceTask:
    interval = raw["interval"]
    return MaintenanceTask(
        id=str(raw["id"]),
        name=str(raw["name"]),
        interval=Interval(
            hours=None if "hours" not in interval else int(interval["hours"]),
            months=None if "months" not in interval else int(interval["months"]),
            calendar=None if "calendar" not in interval else _enum(interval["calendar"]),
            replacement_hours=None
            if "replacement_hours" not in interval
            else int(interval["replacement_hours"]),
            rule=_enum(interval["rule"]),
        ),
        service_message=_text(raw, "service_message"),
        duration_min=int(raw["duration_min"]),
        consumables=tuple(
            Consumable(
                part=str(item["part"]),
                quantity=float(item["quantity"]),
                unit=str(item["unit"]),
            )
            for item in raw["consumables"]
        ),
        tools=_strings(raw, "tools"),
        safety_md=_strings(raw, "safety"),
        safety_html=None,
        steps_md=_strings(raw, "steps"),
        steps_html=None,
        post_checks_md=_strings(raw, "post_checks"),
        post_checks_html=None,
        related_causes=_strings(raw, "related_causes"),
        components=_strings(raw, "components"),
    )


def _parameter(raw: Mapping[str, Any]) -> Parameter:
    return Parameter(
        id=str(raw["id"]),
        param_no=str(raw["param_no"]),
        name=str(raw["name"]),
        unit=str(raw["unit"]),
        type=_enum(raw["type"]),
        min=float(raw["min"]),
        default=float(raw["default"]),
        max=float(raw["max"]),
        step=float(raw["step"]),
        access=_enum(raw["access"]),
        signal=_text(raw, "signal"),
        description_md=str(raw["description"]),
        description_html=None,
        used_by=_strings(raw, "used_by"),
        constraints=tuple(
            Constraint(
                relation=_enum(item["relation"]),
                other=str(item["other"]),
                margin=float(item.get("margin", 0.0)),
                text=str(item["text"]),
            )
            for item in raw.get("constraints", ())
        ),
    )


# --- derived bands and hashes ---------------------------------------------


def _bands(spec: Spec) -> Mapping[str, Any] | None:
    if "bands" not in spec.files_present:
        return None
    return _frozen(dict(_document(spec, "bands")))


def _source_hashes(
    spec: Spec,
    spec_files: Mapping[str, tuple[str, str]],
    cfg: BuildConfig,
) -> Mapping[str, str]:
    hashes = {cfg.path.name: cfg.source_hash}
    for key in SPEC_KEYS:
        if key not in spec.files_present:
            continue
        relative = spec_files[key][0]
        hashes[relative] = _sha256(cfg.manual_root / relative)
    return _frozen(dict(sorted(hashes.items())))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _frozen[K, V](mapping: dict[K, V]) -> Mapping[K, V]:
    """Wrap a mapping so that a frozen dataclass really is read-only."""
    return MappingProxyType(mapping)

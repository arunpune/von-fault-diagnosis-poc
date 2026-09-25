# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The frozen data model the manual build works on.

Field names follow the manual's source of truth under ``manual/spec``.

Every free-text field is stored twice: ``<name>_md`` holds the Markdown source
as authored, ``<name>_html`` the rendered fragment. ``load.load_manual`` leaves
every ``*_html`` at ``None``; only the templating pass fills them, so
the loader and the source-level checks never depend on the Jinja layer.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

__all__ = [
    "Alarm",
    "AlarmCondition",
    "AlarmLeaf",
    "AlarmReset",
    "AlarmTrigger",
    "AnalogBand",
    "Behaviour",
    "Cause",
    "Component",
    "Condition",
    "ConditionCause",
    "Constraint",
    "Consumable",
    "DerivedSignal",
    "DigitalBand",
    "DocumentInfo",
    "Identity",
    "Interval",
    "LowPressureSwitch",
    "Machine",
    "MachineStates",
    "MaintenanceTask",
    "Manual",
    "NormalBand",
    "Parameter",
    "Part",
    "Quantity",
    "Sensor",
    "SettingRef",
    "Signal",
    "SignalMove",
    "Span",
    "ValueRange",
]

Subsystem = Literal[
    "compressor",
    "intake_unloading",
    "oil",
    "cooling",
    "separator_drain",
    "dryer",
    "reservoirs",
    "distribution",
    "electrical",
    "control",
]
BandState = Literal["loaded", "unloaded", "off"]
SignalGroup = Literal["analog", "digital", "extra"]
SignalKind = Literal["pressure", "temperature", "current", "switch", "command", "status"]
AlarmType = Literal["warning", "shutdown_warning", "shutdown", "service"]
ComparisonOp = Literal["gt", "lt", "gte", "lte", "eq", "ne"]
Likelihood = Literal["common", "occasional", "rare"]


@dataclass(frozen=True)
class Quantity:
    """A number with a unit from the closed vocabulary of ``common.schema.json``."""

    value: float
    unit: str


@dataclass(frozen=True)
class Span:
    """An inclusive ``min``/``max`` pair with its own unit."""

    min: float
    max: float
    unit: str


@dataclass(frozen=True)
class ValueRange:
    """An inclusive ``min``/``max`` pair in the owning signal's unit."""

    min: float
    max: float


@dataclass(frozen=True)
class SettingRef:
    """A threshold or delay that points at a programmable setting's default."""

    setting: str
    offset: float = 0.0


@dataclass(frozen=True)
class AnalogBand:
    """The normal band of an analog tag in one machine state."""

    low: float
    typical: float
    high: float


@dataclass(frozen=True)
class DigitalBand:
    """The expected level of a digital tag in one machine state."""

    expected: int | str


NormalBand = AnalogBand | DigitalBand
Threshold = Quantity | SettingRef
Duration = int | SettingRef


@dataclass(frozen=True)
class Modbus:
    """Register type and scale of a tag (read by the simulator, printed in chapter 9)."""

    type: Literal["int16", "uint16"]
    scale: float


@dataclass(frozen=True)
class Signal:
    """One tag of the fixed signal registry."""

    id: str
    panel_label: str
    name: str
    metropt_column: str | None
    group: SignalGroup
    kind: SignalKind
    unit: str
    subsystem: Subsystem
    description_md: str
    description_html: str | None
    source_note: str | None
    sample_rate_s: int
    range: ValueRange | None
    decimals: int | None
    band_step: float
    band_source: Literal["derived", "authored"]
    modbus: Modbus
    normal_bands: Mapping[str, NormalBand]
    shown_in_schematic: bool


@dataclass(frozen=True)
class MachineStates:
    """How ``off``, ``unloaded`` and ``loaded`` are told apart."""

    order: tuple[str, ...]
    running_threshold: Quantity
    rules: Mapping[str, str]
    running_aliases: tuple[str, ...]
    start_event: str


@dataclass(frozen=True)
class DerivedSignal:
    """A quantity computed from the tags rather than measured."""

    id: str
    kind: str
    unit: str
    inputs: tuple[str, ...]
    input: str | None
    state: str | None
    states: tuple[str, ...]
    event: str | None
    window_s: int | None
    reset_on_state_exit: str | None


@dataclass(frozen=True)
class Behaviour:
    """A named way the machine behaves, referenced by ``signal_moves``."""

    id: str
    description_md: str
    description_html: str | None


@dataclass(frozen=True)
class AlarmLeaf:
    """One comparison inside an alarm trigger."""

    signal: str
    op: ComparisonOp
    threshold: Threshold


@dataclass(frozen=True)
class AlarmCondition:
    """A leaf, or one level of ``all``/``any`` over leaves."""

    mode: Literal["leaf", "all", "any"]
    leaves: tuple[AlarmLeaf, ...]


@dataclass(frozen=True)
class AlarmTrigger:
    """What makes the controller raise a message."""

    kind: Literal["signal", "external", "counter"]
    state: str | None
    exclude_start_s: Duration | None
    condition: AlarmCondition | None
    for_s: Duration | None
    counter_derived: str | None
    counter_tasks: tuple[str, ...]
    input: str | None


@dataclass(frozen=True)
class AlarmReset:
    """How the message clears again."""

    mode: Literal["auto", "auto_hysteresis", "manual", "manual_service"]
    hysteresis: Quantity | None
    note: str | None


@dataclass(frozen=True)
class Alarm:
    """One CTRL-7 controller message."""

    code: str
    type: AlarmType
    bit: int | None
    evaluation: Literal["sim", "none"]
    family: str | None
    rank: int | None
    title: str
    display: str
    effect: Literal["none", "stop_inhibit_start"]
    trigger: AlarmTrigger
    reset: AlarmReset
    cause_hint_md: str | None
    cause_hint_html: str | None
    operator_action_md: str | None
    operator_action_html: str | None
    related_conditions: tuple[str, ...]


@dataclass(frozen=True)
class SignalMove:
    """How one tag or behaviour moves when a cause is present."""

    signal: str | None
    behaviour: str | None
    direction: str
    phase: str | None
    onset: str | None
    note_md: str | None
    note_html: str | None


@dataclass(frozen=True)
class Cause:
    """One normalised cause with a stable ``fault_id``."""

    fault_id: str
    name: str
    subsystem: Subsystem
    benign: bool
    summary_md: str
    summary_html: str | None
    signal_moves: tuple[SignalMove, ...]
    checks_md: tuple[str, ...]
    checks_html: tuple[str, ...] | None
    remedy_md: str
    remedy_html: str | None
    parts: tuple[str, ...]
    maintenance: tuple[str, ...]
    components: tuple[str, ...]
    deprecated: bool
    successor: str | None


@dataclass(frozen=True)
class ConditionCause:
    """A cause as one symptom condition lists it, with its likelihood."""

    fault_id: str
    likelihood: Likelihood
    note_md: str | None
    note_html: str | None


@dataclass(frozen=True)
class Condition:
    """One symptom condition of chapter 8."""

    id: str
    title: str
    symptom_md: str
    symptom_html: str | None
    alarms: tuple[str, ...]
    signals: tuple[str, ...]
    causes: tuple[ConditionCause, ...]


@dataclass(frozen=True)
class Interval:
    """When a maintenance task falls due."""

    hours: int | None
    months: int | None
    calendar: Literal["daily", "weekly"] | None
    replacement_hours: int | None
    rule: Literal["whichever_first"]


@dataclass(frozen=True)
class Consumable:
    """A part and how much of it one task run needs."""

    part: str
    quantity: float
    unit: str


@dataclass(frozen=True)
class MaintenanceTask:
    """One task of the chapter 7 schedule."""

    id: str
    name: str
    interval: Interval
    service_message: str | None
    duration_min: int
    consumables: tuple[Consumable, ...]
    tools: tuple[str, ...]
    safety_md: tuple[str, ...]
    safety_html: tuple[str, ...] | None
    steps_md: tuple[str, ...]
    steps_html: tuple[str, ...] | None
    post_checks_md: tuple[str, ...]
    post_checks_html: tuple[str, ...] | None
    related_causes: tuple[str, ...]
    components: tuple[str, ...]


@dataclass(frozen=True)
class Constraint:
    """``default <relation> (other + margin)`` on the resolved defaults."""

    relation: Literal["gte", "lte", "gt", "lt", "eq"]
    other: str
    margin: float
    text: str


@dataclass(frozen=True)
class Parameter:
    """One programmable setting of chapter 4 (the manual's ``settings.yaml``)."""

    id: str
    param_no: str
    name: str
    unit: str
    type: Literal["number", "integer"]
    min: float
    default: float
    max: float
    step: float
    access: Literal["operator", "service"]
    signal: str | None
    description_md: str
    description_html: str | None
    used_by: tuple[str, ...]
    constraints: tuple[Constraint, ...]


@dataclass(frozen=True)
class Identity:
    """``machine.identity`` — the fictional model and controller names."""

    model: str
    name: str
    controller: str
    type: str
    serial_format: str


@dataclass(frozen=True)
class DocumentInfo:
    """``machine.document`` — must equal ``build.yaml``'s document block."""

    number: str
    revision: str
    revision_date: str


@dataclass(frozen=True)
class Sensor:
    """A sensor and the tag it feeds."""

    signal: str
    kind: str
    range: Span
    accuracy: Quantity | None


@dataclass(frozen=True)
class Component:
    """A named assembly of the machine, referenced by causes and figures."""

    id: str
    name: str
    subsystem: Subsystem
    description_md: str | None
    description_html: str | None


@dataclass(frozen=True)
class Part:
    """A spare or consumable with a fictional part code."""

    id: str
    code: str
    name: str
    description_md: str | None
    description_html: str | None
    unit: str | None


@dataclass(frozen=True)
class LowPressureSwitch:
    """The one hardware switch that is not under controller control."""

    closes_below: Quantity
    opens_above: Quantity
    signal: str


@dataclass(frozen=True)
class Machine:
    """``machine.yaml`` — identity, ratings, limits and the physical build."""

    identity: Identity
    document: DocumentInfo
    ratings: Mapping[str, Quantity]
    limits: Mapping[str, Quantity | Span]
    reference_conditions: Mapping[str, Quantity]
    low_pressure_switch: LowPressureSwitch | None
    sensors: tuple[Sensor, ...]
    components: tuple[Component, ...]
    parts: tuple[Part, ...]
    reference_operation: Mapping[str, Quantity | Span]
    subsystems: tuple[Subsystem, ...]


@dataclass(frozen=True)
class Manual:
    """Every manual source document, mapped and cross-checked for uniqueness."""

    machine: Machine
    signals: tuple[Signal, ...]
    alarms: tuple[Alarm, ...]
    conditions: tuple[Condition, ...]
    causes: Mapping[str, Cause]
    maintenance: tuple[MaintenanceTask, ...]
    parameters: tuple[Parameter, ...]
    machine_states: MachineStates
    derived_signals: tuple[DerivedSignal, ...]
    behaviours: tuple[Behaviour, ...]
    #: ``spec/derived/normal-bands.json`` as loaded, or ``None`` when absent.
    bands: Mapping[str, Any] | None
    #: manual-root-relative path → sha256 of every file the loader read.
    source_hashes: Mapping[str, str]

    def signal(self, signal_id: str) -> Signal:
        """Look a tag up by id."""
        return _one(self.signals, "id", signal_id, "signal")

    def alarm(self, code: str) -> Alarm:
        """Look a controller message up by code."""
        return _one(self.alarms, "code", code, "alarm")

    def condition(self, condition_id: str) -> Condition:
        """Look a symptom condition up by id."""
        return _one(self.conditions, "id", condition_id, "condition")

    def cause(self, fault_id: str) -> Cause:
        """Look a cause up by its stable ``fault_id``."""
        try:
            return self.causes[fault_id]
        except KeyError:
            raise KeyError(f"unknown cause {fault_id!r}") from None

    def task(self, task_id: str) -> MaintenanceTask:
        """Look a maintenance task up by id."""
        return _one(self.maintenance, "id", task_id, "maintenance task")

    def parameter(self, parameter_id: str) -> Parameter:
        """Look a programmable setting up by id."""
        return _one(self.parameters, "id", parameter_id, "parameter")


def _one[T](items: tuple[T, ...], attribute: str, value: str, label: str) -> T:
    for item in items:
        if getattr(item, attribute) == value:
            return item
    raise KeyError(f"unknown {label} {value!r}")

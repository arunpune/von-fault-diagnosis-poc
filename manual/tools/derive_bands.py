#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "pandas==3.0.6",
#     "pyarrow==25.0.1",
#     "pyyaml==6.0.3",
# ]
# ///
"""Derive the CAU-7 normal bands from the first MetroPT-3 month.

Implements docs/plan/phase1-manual-content.md section 11 and ADR 0011
(docs/adr/0011-normal-band-derivation-from-first-month.md). The guard,
state, segment and cycle functions are copied from the planning script
docs/plan/data/metropt3_stats.py so that both produce the same numbers;
this script is deliberately stand-alone (no import) because it ships with
the manual sources while the planning script stays in docs/.

Usage (no virtualenv, no workspace membership):

    uv run --no-project manual/tools/derive_bands.py
    uv run --no-project manual/tools/derive_bands.py --print-yaml --out /tmp/bands.json

Runs in well under a minute on the full 218 MB CSV; peak memory about 1.5 GB.

Dataset credit: Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021).
MetroPT-3 Dataset. UCI Machine Learning Repository.
https://doi.org/10.24432/C5VW3R (CC BY 4.0).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

# --- fixed derivation constants (plan section 11, ADR 0011) ------------------

RANGE_START = "2020-02-01 00:00:00"
RANGE_END = "2020-03-01 00:00:00"  # exclusive
GAP_SECONDS = 60  # a timestamp step above this is a logging gap
FROZEN_ROWS = 60  # identical analogue tuple for >= 60 rows = frozen logger
SETTLE_SAMPLES = 3  # samples dropped after every machine-state change
START_PEAK_SECONDS = 30  # window after an off -> running transition
RUNNING_AMPS = 1.0  # motor considered running at or above this current
MAX_NONLOAD_S = 6 * 3600  # longer non-loaded interval = not one cycle
SAMPLE_PERIOD_S = 10  # nominal MetroPT-3 sampling period
STATES = ("loaded", "unloaded", "off")

# Dataset column names used by the fixed rules (not tag ids).
COL_TP2 = "TP2"
COL_TP3 = "TP3"
COL_H1 = "H1"
COL_OIL_T = "Oil_temperature"
COL_CURRENT = "Motor_current"
COL_COMP = "COMP"
COL_DV_ELETRIC = "DV_eletric"
COL_TOWERS = "Towers"
FROZEN_KEY_COLUMNS = [COL_TP2, COL_TP3, COL_H1, COL_OIL_T, COL_CURRENT]

CREDIT = (
    "Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021). MetroPT-3 Dataset. "
    "UCI Machine Learning Repository. https://doi.org/10.24432/C5VW3R. CC BY 4.0."
)
GENERATED_BY = "manual/tools/derive_bands.py"


@dataclass(frozen=True)
class SignalDef:
    """One row of the signals registry (plan section 5.1)."""

    id: str
    metropt_column: str | None
    group: str  # analog | digital | extra
    unit: str
    step: float
    authored_band: dict[str, float] | None = None


# Built-in registry used while manual/spec/signals.yaml does not exist yet
# (plan section 5.1; MAN-05 writes the YAML from the --print-yaml snippet).
# The authored band of the synthetic extra is machine.yaml
# limits.ambient_operating (2...40 degC) around reference_conditions (20 degC).
BUILTIN_SIGNALS: tuple[SignalDef, ...] = (
    SignalDef("discharge_pressure", COL_TP2, "analog", "bar", 0.1),
    SignalDef("line_pressure", COL_TP3, "analog", "bar", 0.1),
    SignalDef("separator_discharge_pressure", COL_H1, "analog", "bar", 0.1),
    SignalDef("dryer_purge_pressure", "DV_pressure", "analog", "bar", 0.1),
    SignalDef("reservoir_pressure", "Reservoirs", "analog", "bar", 0.1),
    SignalDef("oil_temperature", COL_OIL_T, "analog", "degC", 1),
    SignalDef("motor_current", COL_CURRENT, "analog", "A", 0.1),
    SignalDef("intake_closed", COL_COMP, "digital", "bool", 1),
    SignalDef("load_valve", COL_DV_ELETRIC, "digital", "bool", 1),
    SignalDef("dryer_tower", COL_TOWERS, "digital", "bool", 1),
    SignalDef("regulator_contact", "MPG", "digital", "bool", 1),
    SignalDef("low_pressure_switch", "LPS", "digital", "bool", 1),
    SignalDef("purge_switch", "Pressure_switch", "digital", "bool", 1),
    SignalDef("oil_level_ok", "Oil_level", "digital", "bool", 1),
    SignalDef("flow_pulse", "Caudal_impulses", "digital", "bool", 1),
    SignalDef(
        "ambient_temperature",
        None,
        "extra",
        "degC",
        1,
        authored_band={"low": 2, "typical": 20, "high": 40},
    ),
)

CYCLE_KEYS = (
    "cut_in_pressure_observed",
    "cut_out_pressure_observed",
    "loaded_run_typical",
    "loaded_run_band",
    "unloaded_run_on_typical",
    "off_phase_typical",
    "load_cycles_per_hour",
    "pressure_rise_loaded",
    "pressure_decay_unloaded_typical",
    "pressure_decay_unloaded_band",
    "discharge_minus_line_loaded",
    "tower_pulse_after_cut_in",
)

# Units for the machine.yaml reference_operation snippet (plan section 4).
CYCLE_UNITS = {
    "cut_in_pressure_observed": "bar",
    "cut_out_pressure_observed": "bar",
    "loaded_run_typical": "s",
    "loaded_run_band": "s",
    "unloaded_run_on_typical": "s",
    "off_phase_typical": "s",
    "load_cycles_per_hour": "per_hour",
    "pressure_rise_loaded": "bar_per_min",
    "pressure_decay_unloaded_typical": "bar_per_min",
    "pressure_decay_unloaded_band": "bar_per_min",
    "discharge_minus_line_loaded": "bar",
    "tower_pulse_after_cut_in": "s",
}

PROVENANCE_KEYS = (
    "source_file",
    "source_sha256",
    "source_bytes",
    "rows_total",
    "range",
    "rows_used",
    "rows_dropped_gap",
    "rows_dropped_frozen",
    "rows_dropped_settle",
    "generated_by",
    "script_sha256",
    "pandas_version",
    "range_override",
)


class DeriveError(RuntimeError):
    """Any condition that makes the derivation unusable."""


def log(msg: str) -> None:
    """Progress goes to stderr so that --print-yaml keeps stdout clean."""
    print(msg, file=sys.stderr, flush=True)


# --- numbers -----------------------------------------------------------------


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def step_decimals(step: float) -> int:
    # normalize() first: the decimals of a step are a property of its value, not
    # of how it was spelled. Without it `1` (BUILTIN_SIGNALS) gives 0 decimals
    # and `1.0` (read_signals, which coerces with float()) gives 1, so the same
    # band came out as 61 before manual/spec/signals.yaml existed and as 61.0
    # after — silently breaking the byte-identity of the committed derivation.
    exponent = Decimal(str(step)).normalize().as_tuple().exponent
    return max(0, -int(exponent))


def _normalise(value: float, step: float) -> float | int:
    """Round away binary noise, turn -0.0 into 0.0, keep integral steps integral."""
    out = round(value, step_decimals(step))
    if out == 0:
        out = 0.0
    if step_decimals(step) == 0:
        return int(out)
    return float(out)


def _in_steps(value: float, step: float) -> float:
    # round first: 8.0 / 0.1 is 79.99999999999999 in binary floating point.
    return round(value / step, 9)


def floor_to_step(value: float, step: float) -> float | int:
    return _normalise(math.floor(_in_steps(value, step)) * step, step)


def ceil_to_step(value: float, step: float) -> float | int:
    return _normalise(math.ceil(_in_steps(value, step)) * step, step)


def round_to_step(value: float, step: float) -> float | int:
    """Half-up rounding to the band step (deterministic, unlike round())."""
    return _normalise(math.floor(_in_steps(value, step) + 0.5) * step, step)


def rnd(value: Any, digits: int = 4) -> float | int | None:
    """Round a raw statistic for JSON; NaN becomes None."""
    if value is None:
        return None
    if isinstance(value, (float, np.floating)):
        return None if math.isnan(float(value)) else round(float(value), digits)
    if isinstance(value, (int, np.integer)):
        return int(value)
    raise DeriveError(f"cannot round {value!r} ({type(value)!r})")


def _num(value: float | int | np.floating[Any]) -> float:
    if isinstance(value, (float, np.floating)) and math.isnan(float(value)):
        raise DeriveError("statistic is NaN; the window holds no usable rows")
    return float(value)


# --- signals registry ---------------------------------------------------------


def load_signals(path: Path) -> list[SignalDef]:
    """Read signals.yaml when it exists, else fall back to the built-in table."""
    if not path.exists():
        log(f"signals file {path} not found; using the built-in registry")
        return list(BUILTIN_SIGNALS)

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    entries = raw.get("signals") if isinstance(raw, dict) else raw
    if not isinstance(entries, list) or not entries:
        raise DeriveError(f"{path} holds no signals list")

    out: list[SignalDef] = []
    for entry in entries:
        band = entry.get("band") or {}
        step = band.get("step", 1)
        authored = None
        if entry.get("group") == "extra":
            bands = entry.get("normal_bands") or {}
            first = bands.get("loaded") or {}
            if first:
                authored = {k: first[k] for k in ("low", "typical", "high") if k in first}
        out.append(
            SignalDef(
                id=entry["id"],
                metropt_column=entry.get("metropt_column"),
                group=entry["group"],
                unit=entry.get("unit", ""),
                step=float(step),
                authored_band=authored,
            )
        )
    log(f"read {len(out)} signals from {path}")
    return out


def authored_band_of(signal: SignalDef) -> dict[str, float]:
    if signal.authored_band:
        return dict(signal.authored_band)
    builtin = {s.id: s for s in BUILTIN_SIGNALS}.get(signal.id)
    if builtin and builtin.authored_band:
        return dict(builtin.authored_band)
    raise DeriveError(f"signal {signal.id} is an extra without an authored band")


# --- data frame ---------------------------------------------------------------


def read_frame(csv: Path) -> pd.DataFrame:
    log(f"reading {csv}")
    df = pd.read_csv(csv, index_col=0)
    df.index.name = "source_index"
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df.reset_index()


def derive_guards(df: pd.DataFrame) -> pd.DataFrame:
    """Add dt, gap_before, frozen, state, seg and pos (metropt3_stats.py rules)."""
    dt = df.timestamp.diff().dt.total_seconds()
    df["dt"] = dt.fillna(float(SAMPLE_PERIOD_S))
    df["gap_before"] = df.dt > GAP_SECONDS

    key = df[FROZEN_KEY_COLUMNS]
    same = key.diff().abs().sum(axis=1) == 0
    run = (same != same.shift()).cumsum()
    run_len = same.groupby(run).transform("size")
    df["frozen"] = same & (run_len >= FROZEN_ROWS)

    loaded = (df[COL_COMP] == 0) & (df[COL_DV_ELETRIC] == 1)
    running = df[COL_CURRENT] >= RUNNING_AMPS
    df["state"] = np.where(loaded, "loaded", np.where(running, "unloaded", "off"))

    df["seg"] = (df.state != df.state.shift()).cumsum()
    df["pos"] = df.groupby("seg").cumcount()
    return df


def segment_table(df: pd.DataFrame) -> pd.DataFrame:
    """One row per machine-state segment (metropt3_stats.py segments())."""
    df = df.assign(towers_zero=(df[COL_TOWERS] == 0).astype("int64"))
    seg = df.groupby("seg").agg(
        state=("state", "first"),
        start=("timestamp", "first"),
        end=("timestamp", "last"),
        n=("timestamp", "size"),
        tp3_first=(COL_TP3, "first"),
        tp3_last=(COL_TP3, "last"),
        tp3_max=(COL_TP3, "max"),
        towers0=("towers_zero", "sum"),
        has_gap=("gap_before", "any"),
        has_frozen=("frozen", "any"),
    )
    seg["dur_s"] = (seg.end - seg.start).dt.total_seconds() + SAMPLE_PERIOD_S
    seg["dirty"] = seg.has_gap | seg.has_frozen
    return seg


def cycle_table(df: pd.DataFrame, seg: pd.DataFrame) -> pd.DataFrame:
    """One row per loaded run (metropt3_stats.py cycles())."""
    loaded = seg[seg.state == "loaded"].copy()
    if loaded.empty:
        return loaded
    idx = loaded.index.to_numpy()
    nxt, nxt2 = seg.shift(-1), seg.shift(-2)

    loaded["cutin_tp3"] = loaded.tp3_first
    loaded["cutout_tp3"] = loaded.tp3_max
    loaded["unl_dur_s"] = np.where(
        nxt.loc[idx, "state"] == "unloaded", nxt.loc[idx, "dur_s"], np.nan
    )
    loaded["off_dur_s"] = np.where(
        (nxt.loc[idx, "state"] == "unloaded") & (nxt2.loc[idx, "state"] == "off"),
        nxt2.loc[idx, "dur_s"],
        np.where(nxt.loc[idx, "state"] == "off", nxt.loc[idx, "dur_s"], np.nan),
    )
    loaded["next_start"] = loaded.start.shift(-1)
    loaded["next_cutin_tp3"] = loaded.cutin_tp3.shift(-1)
    loaded["nonload_dur_s"] = (loaded.next_start - loaded.end).dt.total_seconds()
    loaded["drop_rate_nonload"] = (loaded.cutout_tp3 - loaded.next_cutin_tp3) / (
        loaded.nonload_dur_s / 60.0
    )
    loaded["rise_rate"] = (loaded.cutout_tp3 - loaded.cutin_tp3) / (loaded.dur_s / 60.0)
    loaded["towers0_s"] = loaded.towers0 * float(SAMPLE_PERIOD_S)

    dirty_times = df.loc[df.gap_before | df.frozen, "timestamp"].to_numpy()
    lo = np.searchsorted(dirty_times, loaded.end.to_numpy(), side="right")
    hi = np.searchsorted(dirty_times, loaded.next_start.to_numpy(), side="right")
    loaded["dirty_between"] = (hi - lo) > 0
    loaded["clean"] = (
        (~loaded.dirty)
        & (~loaded.dirty_between)
        & loaded.next_start.notna()
        & (loaded.nonload_dur_s < MAX_NONLOAD_S)
    )
    return loaded


# --- statistics ---------------------------------------------------------------


def analog_entry(values: pd.Series, step: float) -> dict[str, Any]:
    if values.empty:
        raise DeriveError("no settled rows for an analog signal in this state")
    q = values.quantile([0.01, 0.05, 0.50, 0.95, 0.99])
    p1, p5, p50, p95, p99 = (float(q.iloc[i]) for i in range(5))
    return {
        "n": len(values),
        "min": rnd(values.min()),
        "max": rnd(values.max()),
        "p1": rnd(p1),
        "p5": rnd(p5),
        "p50": rnd(p50),
        "p95": rnd(p95),
        "p99": rnd(p99),
        "low": floor_to_step(p5, step),
        "typical": round_to_step(p50, step),
        "high": ceil_to_step(p95, step),
    }


def digital_entry(values: pd.Series) -> dict[str, Any]:
    if values.empty:
        raise DeriveError("no settled rows for a digital signal in this state")
    duty = float(values.mean())
    if duty >= 0.95:
        expected: int | str = 1
    elif duty <= 0.05:
        expected = 0
    else:
        expected = "alternating"
    return {"n": len(values), "duty": rnd(duty, 6), "expected": expected}


def start_current_peaks(
    df: pd.DataFrame, seg: pd.DataFrame, a: pd.Timestamp, b: pd.Timestamp
) -> dict[str, Any]:
    """Max motor current in the first 30 s after every off -> running start."""
    prev_state = seg.state.shift(1)
    candidates = seg[(seg.state != "off") & (prev_state == "off")]
    candidates = candidates[(candidates.start >= a) & (candidates.start < b)]
    if candidates.empty:
        raise DeriveError("no off -> running transition in the selected range")

    first_row = df.groupby("seg").head(1).set_index("seg")
    ok = candidates.index[
        ~first_row.loc[candidates.index, "gap_before"].to_numpy()
        & ~first_row.loc[candidates.index, "frozen"].to_numpy()
    ]
    if len(ok) == 0:
        raise DeriveError("every off -> running transition is behind a gap or frozen block")

    window = df[df.seg.isin(set(ok.tolist())) & ~df.frozen].copy()
    starts = window.seg.map(seg.start)
    window = window[window.timestamp < starts + pd.Timedelta(seconds=START_PEAK_SECONDS)]
    peaks = window.groupby("seg")[COL_CURRENT].max()
    q = peaks.quantile([0.50, 0.95])
    return {"n": len(peaks), "p50": rnd(float(q.iloc[0])), "p95": rnd(float(q.iloc[1]))}


def cycle_block(
    df_range: pd.DataFrame,
    loaded: pd.DataFrame,
    settled: pd.DataFrame,
    a: pd.Timestamp,
    b: pd.Timestamp,
) -> dict[str, Any]:
    in_range = loaded[(loaded.start >= a) & (loaded.start < b)] if not loaded.empty else loaded
    clean = in_range[in_range.clean] if not in_range.empty else in_range
    if clean.empty:
        raise DeriveError("no clean load cycle in the selected range")

    covered_hours = float(df_range.dt.clip(upper=GAP_SECONDS).sum() / 3600.0)
    if covered_hours <= 0:
        raise DeriveError("the selected range covers no time")

    loaded_rows = settled[settled.state == "loaded"]
    if loaded_rows.empty:
        raise DeriveError("no settled loaded row in the selected range")

    decay = clean.drop_rate_nonload.dropna()
    if decay.empty:
        raise DeriveError("no non-loaded decay measurable in the selected range")

    return {
        "cut_in_pressure_observed": round(_num(clean.cutin_tp3.median()), 2),
        "cut_out_pressure_observed": round(_num(clean.cutout_tp3.median()), 2),
        "loaded_run_typical": round(_num(clean.dur_s.median())),
        "loaded_run_band": {
            "min": round(_num(clean.dur_s.quantile(0.05))),
            "max": round(_num(clean.dur_s.quantile(0.95))),
        },
        "unloaded_run_on_typical": round(_num(clean.unl_dur_s.dropna().median())),
        "off_phase_typical": round(_num(clean.off_dur_s.dropna().median())),
        "load_cycles_per_hour": round(len(in_range) / covered_hours, 2),
        "pressure_rise_loaded": round(_num(clean.rise_rate.median()), 1),
        "pressure_decay_unloaded_typical": round(_num(decay.median()), 2),
        "pressure_decay_unloaded_band": {
            "min": round(_num(decay.quantile(0.05)), 2),
            "max": round(_num(decay.quantile(0.95)), 2),
        },
        "discharge_minus_line_loaded": round(
            _num((loaded_rows[COL_TP2] - loaded_rows[COL_TP3]).median()), 2
        ),
        "tower_pulse_after_cut_in": round(_num(clean.towers0_s.median())),
    }


# --- output -------------------------------------------------------------------


def build_result(
    *,
    signals: list[SignalDef],
    settled: pd.DataFrame,
    peaks: dict[str, Any],
    cycle: dict[str, Any],
    provenance: dict[str, Any],
) -> dict[str, Any]:
    by_state = {state: settled[settled.state == state] for state in STATES}
    out: dict[str, dict[str, Any]] = {}
    for signal in signals:
        if signal.group == "extra" or signal.metropt_column is None:
            band = authored_band_of(signal)
            entry = {state: {**band, "source": "authored"} for state in STATES}
        elif signal.group == "analog":
            entry = {
                state: analog_entry(by_state[state][signal.metropt_column], signal.step)
                for state in STATES
            }
        elif signal.group == "digital":
            entry = {
                state: digital_entry(by_state[state][signal.metropt_column]) for state in STATES
            }
        else:
            raise DeriveError(f"signal {signal.id} has unknown group {signal.group!r}")
        out[signal.id] = entry

    return {
        "_credit": CREDIT,
        "_license": "CC-BY-4.0",
        "cycle": cycle,
        "provenance": provenance,
        "signals": out,
        "start_current_peak": peaks,
    }


def self_check(result: dict[str, Any], signals: list[SignalDef]) -> None:
    """Key-set and monotonicity check; runs whether or not a schema is present."""
    expected_top = {"_credit", "_license", "cycle", "provenance", "signals", "start_current_peak"}
    if set(result) != expected_top:
        raise DeriveError(f"top-level keys {sorted(result)} != {sorted(expected_top)}")
    if set(result["provenance"]) != set(PROVENANCE_KEYS):
        raise DeriveError(f"provenance keys {sorted(result['provenance'])} are wrong")
    if set(result["cycle"]) != set(CYCLE_KEYS):
        raise DeriveError(f"cycle keys {sorted(result['cycle'])} are wrong")
    if set(result["start_current_peak"]) != {"n", "p50", "p95"}:
        raise DeriveError("start_current_peak keys are wrong")
    if set(result["signals"]) != {s.id for s in signals}:
        raise DeriveError("the signals block does not cover the registry exactly")
    for sid, states in result["signals"].items():
        if set(states) != set(STATES):
            raise DeriveError(f"signal {sid} misses a state entry")
        for state, entry in states.items():
            if "expected" in entry:
                continue
            low, typical, high = entry["low"], entry["typical"], entry["high"]
            if not low <= typical <= high:
                raise DeriveError(f"{sid}.{state} band {low}/{typical}/{high} is not ordered")


def validate_with_schema(result: dict[str, Any], schema_path: Path) -> None:
    if not schema_path.exists():
        log(f"no schema at {schema_path}; key self-check only")
        return
    try:
        import jsonschema  # noqa: PLC0415  (optional: not a PEP 723 dependency)
        from referencing import Registry, Resource  # noqa: PLC0415
        from referencing.jsonschema import DRAFT202012  # noqa: PLC0415
    except ImportError:
        log(
            f"jsonschema is not installed; skipping validation against {schema_path.name} "
            "(run with --with jsonschema==4.26.0 --with referencing to enable it)"
        )
        return

    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    registry: Registry = Registry()
    for sibling in sorted(schema_path.parent.glob("*.schema.json")):
        contents = json.loads(sibling.read_text(encoding="utf-8"))
        resource = Resource.from_contents(contents, default_specification=DRAFT202012)
        registry = registry.with_resource(uri=sibling.name, resource=resource)
        if "$id" in contents:
            registry = registry.with_resource(uri=contents["$id"], resource=resource)
    validator = jsonschema.Draft202012Validator(schema, registry=registry)
    errors = sorted(validator.iter_errors(result), key=lambda e: list(e.absolute_path))
    if errors:
        for err in errors[:20]:
            pointer = "/" + "/".join(str(p) for p in err.absolute_path)
            log(f"schema error at {pointer}: {err.message}")
        raise DeriveError(f"{len(errors)} schema violation(s) against {schema_path.name}")
    log(f"validated against {schema_path.name}")


def fmt(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(round(value, 6))
    return str(value)


def yaml_snippet(result: dict[str, Any], signals: list[SignalDef]) -> str:
    """One parseable YAML document: normal_bands per signal id, reference_operation."""
    lines = [
        "# Generated by " + GENERATED_BY + " -- paste each block into the matching",
        "# manual/spec/signals.yaml entry (normal_bands) and into machine.yaml",
        "# (reference_operation). Values come from spec/derived/normal-bands.json.",
        "# The state keys stay quoted: YAML 1.1 reads a bare off: as the boolean false.",
        "normal_bands:",
    ]
    for signal in signals:
        lines.append(f"  {signal.id}:")
        for state in STATES:
            entry = result["signals"][signal.id][state]
            if "expected" in entry:
                body = f"{{expected: {fmt(entry['expected'])}}}"
            else:
                body = (
                    f"{{low: {fmt(entry['low'])}, typical: {fmt(entry['typical'])}, "
                    f"high: {fmt(entry['high'])}}}"
                )
            lines.append(f'    "{state}": {body}')
    lines.append("reference_operation:")
    for key in CYCLE_KEYS:
        value = result["cycle"][key]
        unit = CYCLE_UNITS[key]
        if isinstance(value, dict):
            lines.append(
                f"  {key}: {{min: {fmt(value['min'])}, max: {fmt(value['max'])}, unit: {unit}}}"
            )
        else:
            lines.append(f"  {key}: {{value: {fmt(value)}, unit: {unit}}}")
    return "\n".join(lines) + "\n"


# --- main ---------------------------------------------------------------------


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_csv() -> str:
    env = os.environ.get("METROPT_CSV")
    if env:
        return env
    return str(repo_root() / "data" / "metropt3" / "MetroPT3(AirCompressor).csv")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    root = repo_root()
    ap = argparse.ArgumentParser(
        description="Derive manual/spec/derived/normal-bands.json from MetroPT-3.",
    )
    ap.add_argument("--csv", default=default_csv(), help="MetroPT-3 CSV (default: $METROPT_CSV)")
    ap.add_argument(
        "--out",
        default=str(root / "manual" / "spec" / "derived" / "normal-bands.json"),
        help="output JSON path",
    )
    ap.add_argument(
        "--signals",
        default=str(root / "manual" / "spec" / "signals.yaml"),
        help="signals registry; the built-in table is used when the file is absent",
    )
    ap.add_argument(
        "--range",
        nargs=2,
        metavar=("START", "END"),
        help="tests only: half-open timestamp window; sets provenance.range_override",
    )
    ap.add_argument(
        "--print-yaml",
        action="store_true",
        help="print the normal_bands and reference_operation snippets on stdout",
    )
    return ap.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    csv = Path(args.csv)
    if not csv.exists():
        raise DeriveError(f"CSV not found: {csv} (set METROPT_CSV or pass --csv)")
    out = Path(args.out)
    signals = load_signals(Path(args.signals))

    start, end = args.range if args.range else (RANGE_START, RANGE_END)
    a, b = pd.Timestamp(start), pd.Timestamp(end)
    if a >= b:
        raise DeriveError(f"empty range {start} .. {end}")

    df = derive_guards(read_frame(csv))
    missing = [s.metropt_column for s in signals if s.metropt_column and s.metropt_column not in df]
    if missing:
        raise DeriveError(f"CSV misses the columns {missing}")
    rows_total = len(df)
    log(f"{rows_total} rows, {df.timestamp.min()} .. {df.timestamp.max()}")

    seg = segment_table(df)
    loaded = cycle_table(df, seg)

    in_range = (df.timestamp >= a) & (df.timestamp < b)
    df_range = df[in_range]
    if df_range.empty:
        raise DeriveError(f"no row inside {start} .. {end}")

    dropped_frozen = int(df_range.frozen.sum())
    dropped_gap = int((df_range.gap_before & ~df_range.frozen).sum())
    kept = df_range[~df_range.frozen & ~df_range.gap_before]
    settled = kept[kept.pos >= SETTLE_SAMPLES]
    dropped_settle = int(len(kept) - len(settled))
    if len(df_range) != len(settled) + dropped_gap + dropped_frozen + dropped_settle:
        raise DeriveError("row accounting does not add up")
    log(
        f"range rows {len(df_range)}: used {len(settled)}, dropped gap {dropped_gap}, "
        f"frozen {dropped_frozen}, settle {dropped_settle}"
    )

    peaks = start_current_peaks(df, seg, a, b)
    cycle = cycle_block(df_range, loaded, settled, a, b)

    provenance = {
        "source_file": csv.name,
        "source_sha256": sha256_of(csv),
        "source_bytes": int(csv.stat().st_size),
        "rows_total": rows_total,
        "range": [a.isoformat(), b.isoformat()],
        "rows_used": len(settled),
        "rows_dropped_gap": dropped_gap,
        "rows_dropped_frozen": dropped_frozen,
        "rows_dropped_settle": dropped_settle,
        "generated_by": GENERATED_BY,
        "script_sha256": sha256_of(Path(__file__).resolve()),
        "pandas_version": pd.__version__,
        "range_override": bool(args.range),
    }

    result = build_result(
        signals=signals, settled=settled, peaks=peaks, cycle=cycle, provenance=provenance
    )
    self_check(result, signals)
    validate_with_schema(
        result, repo_root() / "manual" / "spec" / "schemas" / "normal-bands.schema.json"
    )

    out.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n"
    out.write_text(payload, encoding="utf-8")
    log(f"wrote {out} ({out.stat().st_size / 1024:.1f} KiB)")

    if args.print_yaml:
        sys.stdout.write(yaml_snippet(result, signals))
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run(parse_args(argv))
    except DeriveError as exc:
        log(f"error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

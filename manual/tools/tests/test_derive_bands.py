# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""End-to-end tests for manual/tools/derive_bands.py on a synthetic CSV.

The CSV is built row by row in this file with the verbatim MetroPT-3 header,
so no dataset is needed: about three days of load cycles, one two-hour logging
gap and one hundred-row frozen block. The script is then run as a subprocess
and its JSON and YAML outputs are checked against an oracle computed here in
plain Python (no pandas), independently of the script's implementation.

Run with:

    uv run --no-project --with pytest==9.1.1 --with pyyaml==6.0.3 \
        --with pandas==3.0.6 --with pyarrow==25.0.1 \
        pytest manual/tools/tests/test_derive_bands.py -q
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import yaml

SCRIPT = Path(__file__).resolve().parents[1] / "derive_bands.py"


def _import_script():
    spec = importlib.util.spec_from_file_location("derive_bands", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolves annotations through it
    spec.loader.exec_module(module)
    return module


derive_bands = _import_script()

HEADER = (
    ",timestamp,TP2,TP3,H1,DV_pressure,Reservoirs,Oil_temperature,Motor_current,"
    "COMP,DV_eletric,Towers,MPG,LPS,Pressure_switch,Oil_level,Caudal_impulses"
)

# Synthetic cycle shape: loaded 110 s, unloaded 400 s, off 1300 s at 10 s sampling.
LOADED_SAMPLES = 11
UNLOADED_SAMPLES = 40
OFF_SAMPLES = 130
CYCLE_SAMPLES = LOADED_SAMPLES + UNLOADED_SAMPLES + OFF_SAMPLES  # 181 -> 1810 s
CYCLES = 150
PERIOD_S = 10
T0 = datetime(2020, 1, 1, 0, 0, 0)

CUT_IN = 8.05
CUT_OUT = 10.03
OIL_LOADED, OIL_UNLOADED, OIL_OFF = 55.0, 58.0, 56.0
CURRENT_START_PEAK = 8.0
CURRENT_UNLOADED, CURRENT_OFF = 3.8, 0.04
DISCHARGE_DELTA = 0.32
TOWERS_ZERO_SAMPLES = 6  # 60 s of tower-zero after every cut-in
DV_PRESSURE = -0.02
TP2_VENTED = -0.01

GAP_SECONDS = 7200
GAP_SAMPLE = 40 * CYCLE_SAMPLES + 60  # inside the off phase of cycle 40
FROZEN_FIRST = 20 * CYCLE_SAMPLES + 60  # inside the off phase of cycle 20
FROZEN_ROWS = 100

RANGE_FIRST = 2000
RANGE_LAST = 20000  # exclusive

SETTLE = 3
FROZEN_MIN_RUN = 60


@dataclass(frozen=True)
class Row:
    index: int
    ts: datetime
    tp2: float
    tp3: float
    h1: float
    dv_pressure: float
    reservoirs: float
    oil: float
    current: float
    comp: int
    dv_eletric: int
    towers: int
    mpg: int
    lps: int
    pressure_switch: int
    oil_level: int
    caudal: int
    state: str

    @property
    def frozen_key(self) -> tuple[float, float, float, float, float]:
        return (self.tp2, self.tp3, self.h1, self.oil, self.current)

    def csv_line(self) -> str:
        analog = [
            self.tp2,
            self.tp3,
            self.h1,
            self.dv_pressure,
            self.reservoirs,
            self.oil,
            self.current,
        ]
        digital = [
            self.comp,
            self.dv_eletric,
            self.towers,
            self.mpg,
            self.lps,
            self.pressure_switch,
            self.oil_level,
            self.caudal,
        ]
        cells = [str(self.index), self.ts.strftime("%Y-%m-%d %H:%M:%S")]
        cells += [f"{v:.4f}" for v in analog]
        cells += [str(v) for v in digital]
        return ",".join(cells)


def _q(value: float) -> float:
    """The value as it survives the 4-decimal CSV round trip."""
    return round(value, 4)


def build_rows() -> list[Row]:
    """Deterministic synthetic cycles with one gap and one frozen block."""
    rows: list[Row] = []
    for _cycle in range(CYCLES):
        for i in range(LOADED_SAMPLES):
            tp3 = _q(CUT_IN + (CUT_OUT - CUT_IN) * i / (LOADED_SAMPLES - 1))
            # the discharge line ramps up over the first three samples, so the
            # settle rule and the settled TP2 - TP3 median can be told apart
            delta = DISCHARGE_DELTA * (i + 1) / 4 if i < SETTLE else DISCHARGE_DELTA
            current = CURRENT_START_PEAK if i == 0 else _q(5.95 + 0.01 * i)
            rows.append(
                Row(
                    index=0,
                    ts=T0,
                    tp2=_q(tp3 + delta),
                    tp3=tp3,
                    h1=TP2_VENTED,
                    dv_pressure=DV_PRESSURE,
                    reservoirs=tp3,
                    oil=OIL_LOADED,
                    current=current,
                    comp=0,
                    dv_eletric=1,
                    towers=0 if i < TOWERS_ZERO_SAMPLES else 1,
                    mpg=0,
                    lps=0,
                    pressure_switch=1,
                    oil_level=1,
                    caudal=1,
                    state="loaded",
                )
            )
        nonload = UNLOADED_SAMPLES + OFF_SAMPLES
        for j in range(1, nonload + 1):
            tp3 = _q(CUT_OUT - (CUT_OUT - CUT_IN) * j / nonload)
            unloaded = j <= UNLOADED_SAMPLES
            rows.append(
                Row(
                    index=0,
                    ts=T0,
                    tp2=TP2_VENTED,
                    tp3=tp3,
                    h1=tp3,
                    dv_pressure=DV_PRESSURE,
                    reservoirs=tp3,
                    oil=OIL_UNLOADED if unloaded else OIL_OFF,
                    current=CURRENT_UNLOADED if unloaded else CURRENT_OFF,
                    comp=1,
                    dv_eletric=0,
                    towers=1,
                    mpg=1,
                    lps=0,
                    pressure_switch=1,
                    oil_level=1,
                    caudal=1,
                    state="unloaded" if unloaded else "off",
                )
            )

    # freeze one hundred consecutive rows inside an off phase
    held = rows[FROZEN_FIRST]
    for k in range(FROZEN_FIRST, FROZEN_FIRST + FROZEN_ROWS):
        frozen_values = {"tp3": held.tp3, "h1": held.h1, "reservoirs": held.reservoirs}
        rows[k] = Row(**{**rows[k].__dict__, **frozen_values})

    # index in steps of ten, timestamps every ten seconds with one two-hour gap
    out: list[Row] = []
    for k, row in enumerate(rows):
        shift = GAP_SECONDS - PERIOD_S if k >= GAP_SAMPLE else 0
        stamp = T0 + timedelta(seconds=PERIOD_S * k + shift)
        out.append(Row(**{**row.__dict__, "index": 10 * k, "ts": stamp}))
    return out


def write_csv(path: Path, rows: list[Row]) -> None:
    path.write_text("\n".join([HEADER] + [r.csv_line() for r in rows]) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class Oracle:
    frozen: list[bool]
    gap: list[bool]
    pos: list[int]
    seg: list[int]


def oracle(rows: list[Row]) -> Oracle:
    """Guards, segments and settle positions computed without pandas."""
    same = [False] + [rows[k].frozen_key == rows[k - 1].frozen_key for k in range(1, len(rows))]
    frozen = [False] * len(rows)
    k = 0
    while k < len(rows):
        if not same[k]:
            k += 1
            continue
        start = k
        while k < len(rows) and same[k]:
            k += 1
        if k - start >= FROZEN_MIN_RUN:
            for j in range(start, k):
                frozen[j] = True

    gap = [False] + [
        (rows[k].ts - rows[k - 1].ts).total_seconds() > 60 for k in range(1, len(rows))
    ]

    seg: list[int] = []
    pos: list[int] = []
    current = 0
    counter = 0
    for k, row in enumerate(rows):
        if k and row.state != rows[k - 1].state:
            current += 1
            counter = 0
        seg.append(current)
        pos.append(counter)
        counter += 1
    return Oracle(frozen=frozen, gap=gap, pos=pos, seg=seg)


def run_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False
    )


@pytest.fixture(scope="module")
def synthetic(tmp_path_factory: pytest.TempPathFactory) -> dict[str, object]:
    tmp = tmp_path_factory.mktemp("bands")
    rows = build_rows()
    csv = tmp / "synthetic.csv"
    write_csv(csv, rows)
    out = tmp / "bands.json"
    start = rows[RANGE_FIRST].ts.strftime("%Y-%m-%d %H:%M:%S")
    end = rows[RANGE_LAST].ts.strftime("%Y-%m-%d %H:%M:%S")
    proc = run_script(
        "--csv",
        str(csv),
        "--out",
        str(out),
        "--signals",
        str(tmp / "absent-signals.yaml"),
        "--range",
        start,
        end,
        "--print-yaml",
    )
    assert proc.returncode == 0, proc.stderr
    return {
        "tmp": tmp,
        "csv": csv,
        "out": out,
        "rows": rows,
        "oracle": oracle(rows),
        "bands": json.loads(out.read_text(encoding="utf-8")),
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "range": (start, end),
    }


def in_range() -> range:
    return range(RANGE_FIRST, RANGE_LAST)


def test_pep723_metadata_is_pinned() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    block = text.split("# /// script", 1)[1].split("# ///", 1)[0]
    toml = "\n".join(line.removeprefix("# ").removeprefix("#") for line in block.splitlines())
    meta = tomllib.loads(toml)
    assert meta["requires-python"] == ">=3.12"
    assert set(meta["dependencies"]) == {"pandas==3.0.6", "pyarrow==25.0.1", "pyyaml==6.0.3"}
    # the tag is assembled so that REUSE does not read this assertion as a header
    tag = "SPDX-License" + "-Identifier"
    assert f"{tag}: Apache-2.0" in text


def test_provenance_rows_and_drop_counts(synthetic: dict[str, object]) -> None:
    bands = synthetic["bands"]
    rows: list[Row] = synthetic["rows"]  # type: ignore[assignment]
    orc: Oracle = synthetic["oracle"]  # type: ignore[assignment]
    prov = bands["provenance"]

    idx = list(in_range())
    expected_frozen = sum(1 for k in idx if orc.frozen[k])
    expected_gap = sum(1 for k in idx if orc.gap[k] and not orc.frozen[k])
    kept = [k for k in idx if not orc.frozen[k] and not orc.gap[k]]
    expected_settle = sum(1 for k in kept if orc.pos[k] < SETTLE)
    expected_used = len(kept) - expected_settle

    assert prov["rows_total"] == len(rows)
    assert prov["rows_dropped_frozen"] == expected_frozen == FROZEN_ROWS - 1
    assert prov["rows_dropped_gap"] == expected_gap == 1
    assert prov["rows_dropped_settle"] == expected_settle
    assert prov["rows_used"] == expected_used
    assert prov["rows_used"] + prov["rows_dropped_gap"] + prov["rows_dropped_frozen"] + prov[
        "rows_dropped_settle"
    ] == len(idx)
    assert prov["range_override"] is True
    assert prov["range"] == [rows[RANGE_FIRST].ts.isoformat(), rows[RANGE_LAST].ts.isoformat()]
    assert prov["source_file"] == "synthetic.csv"
    assert prov["generated_by"] == "manual/tools/derive_bands.py"
    assert len(prov["source_sha256"]) == 64
    assert len(prov["script_sha256"]) == 64


def test_json_key_set(synthetic: dict[str, object]) -> None:
    bands = synthetic["bands"]
    assert set(bands) == {
        "_credit",
        "_license",
        "cycle",
        "provenance",
        "signals",
        "start_current_peak",
    }
    assert bands["_license"] == "CC-BY-4.0"
    assert "MetroPT-3" in bands["_credit"] and "CC BY 4.0" in bands["_credit"]
    assert set(bands["provenance"]) == {
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
    }
    assert len(bands["signals"]) == 16
    for sid, states in bands["signals"].items():
        assert set(states) == {"loaded", "unloaded", "off"}, sid


def test_settle_rule_excludes_the_start_peak(synthetic: dict[str, object]) -> None:
    bands = synthetic["bands"]
    loaded = bands["signals"]["motor_current"]["loaded"]
    assert [loaded["low"], loaded["typical"], loaded["high"]] == [5.9, 6.0, 6.1]
    assert loaded["max"] < CURRENT_START_PEAK

    peak = bands["start_current_peak"]
    assert peak["p50"] == CURRENT_START_PEAK
    assert peak["p95"] == CURRENT_START_PEAK
    # one off -> running transition per cycle whose loaded run starts in the range
    first_cycle = -(-RANGE_FIRST // CYCLE_SAMPLES)
    last_cycle = (RANGE_LAST - 1) // CYCLE_SAMPLES
    assert peak["n"] == last_cycle - first_cycle + 1 == 99


def test_analog_bands_round_to_the_signal_step(synthetic: dict[str, object]) -> None:
    signals = synthetic["bands"]["signals"]
    assert signals["oil_temperature"]["loaded"]["typical"] == 55
    assert signals["oil_temperature"]["unloaded"]["typical"] == 58
    assert signals["oil_temperature"]["off"]["typical"] == 56
    for state in ("loaded", "unloaded", "off"):
        entry = signals["oil_temperature"][state]
        assert entry["low"] == entry["typical"] == entry["high"]

    line = signals["line_pressure"]["loaded"]
    assert line["low"] < line["typical"] < line["high"]
    assert line["low"] >= CUT_IN - 0.05  # the first three ramp samples are settled out
    assert line["high"] == 10.1  # ceil_to_step of the cut-out pressure
    # the vented discharge line rounds to a band around zero, never to -0.0
    unloaded = signals["discharge_pressure"]["unloaded"]
    assert unloaded["low"] == -0.1
    assert unloaded["typical"] == 0.0
    assert unloaded["high"] == 0.0


def test_digital_expected_values(synthetic: dict[str, object]) -> None:
    signals = synthetic["bands"]["signals"]
    assert signals["intake_closed"]["loaded"]["expected"] == 0
    assert signals["intake_closed"]["unloaded"]["expected"] == 1
    assert signals["intake_closed"]["off"]["expected"] == 1
    assert signals["load_valve"]["loaded"]["expected"] == 1
    assert signals["load_valve"]["off"]["expected"] == 0
    assert signals["dryer_tower"]["loaded"]["expected"] == "alternating"
    assert signals["dryer_tower"]["unloaded"]["expected"] == 1
    assert signals["low_pressure_switch"]["off"]["expected"] == 0
    assert 0.0 <= signals["dryer_tower"]["loaded"]["duty"] <= 1.0


def test_synthetic_extra_carries_the_authored_band(synthetic: dict[str, object]) -> None:
    ambient = synthetic["bands"]["signals"]["ambient_temperature"]
    for state in ("loaded", "unloaded", "off"):
        assert ambient[state] == {"low": 2, "typical": 20, "high": 40, "source": "authored"}


def test_cycle_block(synthetic: dict[str, object]) -> None:
    cycle = synthetic["bands"]["cycle"]
    assert cycle["cut_in_pressure_observed"] == CUT_IN
    assert cycle["cut_out_pressure_observed"] == CUT_OUT
    assert cycle["loaded_run_typical"] == LOADED_SAMPLES * PERIOD_S
    assert cycle["loaded_run_band"] == {
        "min": LOADED_SAMPLES * PERIOD_S,
        "max": LOADED_SAMPLES * PERIOD_S,
    }
    assert cycle["unloaded_run_on_typical"] == UNLOADED_SAMPLES * PERIOD_S
    assert cycle["off_phase_typical"] == OFF_SAMPLES * PERIOD_S
    assert cycle["pressure_rise_loaded"] == 1.1
    assert cycle["pressure_decay_unloaded_typical"] == 0.07
    assert cycle["pressure_decay_unloaded_band"] == {"min": 0.07, "max": 0.07}
    assert cycle["discharge_minus_line_loaded"] == DISCHARGE_DELTA
    assert cycle["tower_pulse_after_cut_in"] == TOWERS_ZERO_SAMPLES * PERIOD_S
    nominal_per_hour = 3600 / (CYCLE_SAMPLES * PERIOD_S)
    assert cycle["load_cycles_per_hour"] == pytest.approx(nominal_per_hour, abs=0.05)


def test_print_yaml_snippet(synthetic: dict[str, object]) -> None:
    doc = yaml.safe_load(synthetic["stdout"])
    assert set(doc) == {"normal_bands", "reference_operation"}
    assert len(doc["normal_bands"]) == 16
    assert set(doc["normal_bands"]) == set(synthetic["bands"]["signals"])
    assert doc["normal_bands"]["motor_current"]["loaded"] == {
        "low": 5.9,
        "typical": 6.0,
        "high": 6.1,
    }
    assert doc["normal_bands"]["intake_closed"]["loaded"] == {"expected": 0}
    assert doc["normal_bands"]["ambient_temperature"]["off"] == {
        "low": 2,
        "typical": 20,
        "high": 40,
    }
    # the state keys must survive YAML 1.1: a bare off: would parse as false
    for states in doc["normal_bands"].values():
        assert set(states) == {"loaded", "unloaded", "off"}
    assert '"off":' in synthetic["stdout"]
    ref = doc["reference_operation"]
    assert ref["cut_in_pressure_observed"] == {"value": CUT_IN, "unit": "bar"}
    assert ref["loaded_run_typical"] == {"value": 110, "unit": "s"}
    assert ref["loaded_run_band"] == {"min": 110, "max": 110, "unit": "s"}
    assert ref["load_cycles_per_hour"]["unit"] == "per_hour"
    assert ref["pressure_rise_loaded"]["unit"] == "bar_per_min"
    assert set(ref) == set(synthetic["bands"]["cycle"])


def test_second_run_is_byte_identical(synthetic: dict[str, object]) -> None:
    tmp: Path = synthetic["tmp"]  # type: ignore[assignment]
    start, end = synthetic["range"]  # type: ignore[misc]
    again = tmp / "bands-again.json"
    proc = run_script(
        "--csv",
        str(synthetic["csv"]),
        "--out",
        str(again),
        "--signals",
        str(tmp / "absent-signals.yaml"),
        "--range",
        start,
        end,
    )
    assert proc.returncode == 0, proc.stderr
    first: Path = synthetic["out"]  # type: ignore[assignment]
    assert again.read_bytes() == first.read_bytes()


def test_json_is_sorted_two_space_indented_with_trailing_newline(
    synthetic: dict[str, object],
) -> None:
    out: Path = synthetic["out"]  # type: ignore[assignment]
    text = out.read_text(encoding="utf-8")
    assert text.endswith("}\n")
    assert text.splitlines()[1].startswith('  "_credit"')
    assert text == json.dumps(json.loads(text), indent=2, sort_keys=True) + "\n"


def test_missing_csv_fails_cleanly(tmp_path: Path) -> None:
    proc = run_script("--csv", str(tmp_path / "nope.csv"), "--out", str(tmp_path / "o.json"))
    assert proc.returncode == 2
    assert "CSV not found" in proc.stderr


# --- unit tests for the rounding helpers -------------------------------------


@pytest.mark.parametrize(
    ("value", "step", "floor", "typical", "ceil"),
    [
        (8.048, 0.1, 8.0, 8.0, 8.1),
        (10.028, 0.1, 10.0, 10.0, 10.1),
        (9.106, 0.1, 9.1, 9.1, 9.2),
        (8.0, 0.1, 8.0, 8.0, 8.0),  # exact multiples must not slip a step
        (-0.02, 0.1, -0.1, 0.0, 0.0),
        (0.035, 0.1, 0.0, 0.0, 0.1),
        (55.0, 1, 55, 55, 55),
        (60.4125, 1, 60, 60, 61),
        (48.725, 1, 48, 49, 49),
    ],
)
def test_step_rounding(
    value: float, step: float, floor: float, typical: float, ceil: float
) -> None:
    assert derive_bands.floor_to_step(value, step) == floor
    assert derive_bands.round_to_step(value, step) == typical
    assert derive_bands.ceil_to_step(value, step) == ceil


def test_step_rounding_keeps_integral_steps_integral() -> None:
    assert isinstance(derive_bands.round_to_step(55.4, 1), int)
    assert isinstance(derive_bands.round_to_step(8.44, 0.1), float)
    # -0.0 never reaches the JSON
    assert repr(derive_bands.round_to_step(-0.01, 0.1)) == "0.0"


def test_step_decimals() -> None:
    assert derive_bands.step_decimals(0.1) == 1
    assert derive_bands.step_decimals(1) == 0
    assert derive_bands.step_decimals(0.01) == 2


def test_step_decimals_ignores_how_the_step_is_spelled() -> None:
    """`1` and `1.0` are the same step, so they must round the same way.

    read_signals() coerces the step with float(), BUILTIN_SIGNALS spells the
    integral ones as int. When the two disagreed, an integral-step band came
    out as 61 without manual/spec/signals.yaml and as 61.0 with it, which broke
    the byte-identity of the committed derivation.
    """
    for spelled_int, spelled_float in ((1, 1.0), (10, 10.0), (5, 5.0)):
        assert derive_bands.step_decimals(spelled_int) == derive_bands.step_decimals(spelled_float)
        assert derive_bands.step_decimals(spelled_float) == 0
    assert repr(derive_bands.round_to_step(60.6, 1.0)) == repr(derive_bands.round_to_step(60.6, 1))
    assert repr(derive_bands.round_to_step(60.6, 1.0)) == "61"


def test_schema_validation_accepts_and_rejects(
    synthetic: dict[str, object], tmp_path: Path
) -> None:
    pytest.importorskip("jsonschema")
    pytest.importorskip("referencing")
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "urn:fdp:manual:normal-bands:v1",
        "type": "object",
        "required": ["_credit", "_license", "cycle", "provenance", "signals", "start_current_peak"],
        "properties": {"provenance": {"type": "object", "required": ["source_sha256"]}},
    }
    good = tmp_path / "normal-bands.schema.json"
    good.write_text(json.dumps(schema), encoding="utf-8")
    derive_bands.validate_with_schema(synthetic["bands"], good)

    schema["properties"] = {"provenance": {"type": "array"}}
    bad = tmp_path / "strict.schema.json"
    bad.write_text(json.dumps(schema), encoding="utf-8")
    with pytest.raises(derive_bands.DeriveError):
        derive_bands.validate_with_schema(synthetic["bands"], bad)


def test_schema_validation_is_skipped_when_absent(
    synthetic: dict[str, object], tmp_path: Path
) -> None:
    derive_bands.validate_with_schema(synthetic["bands"], tmp_path / "absent.schema.json")

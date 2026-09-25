# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Reproducible MetroPT-3 statistics for the Fault Diagnosis PoC.

Reads the UCI MetroPT-3 CSV (not committed, see data/metropt3/), derives the
machine state from the digital signals, detects load/unload cycles, and writes
data/metropt3-first-month-stats.json plus a short text summary.

Usage (from the repo root, no virtualenv needed):

    uv run --no-project --with pandas --with pyarrow python scripts/data/metropt3_stats.py \
        [--csv "data/metropt3/MetroPT3(AirCompressor).csv"] \
        [--out data/metropt3-first-month-stats.json]

Runs in about 15 s on a laptop; peak memory about 1.5 GB.

Dataset credit: Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021).
MetroPT-3 Dataset. UCI Machine Learning Repository.
https://doi.org/10.24432/C5VW3R (CC BY 4.0).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ANALOG = ["TP2", "TP3", "H1", "DV_pressure", "Reservoirs", "Oil_temperature", "Motor_current"]
DIGITAL = [
    "COMP",
    "DV_eletric",
    "Towers",
    "MPG",
    "LPS",
    "Pressure_switch",
    "Oil_level",
    "Caudal_impulses",
]
COLUMNS = ANALOG + DIGITAL
QUANTILES = [0.01, 0.05, 0.50, 0.95, 0.99]

FIRST_MONTH = ("2020-02-01 00:00:00", "2020-02-29 23:59:59")
GAP_SECONDS = 60  # a timestamp step above this is a logging gap
FROZEN_ROWS = 60  # identical analogue tuple for >= 60 rows (~10 min) = frozen logger
RUNNING_AMPS = 1.0  # motor considered running above this current
MAX_NONLOAD_S = 6 * 3600  # a cycle whose non-loaded interval is longer than this is not a cycle

# Corrected failure table (see docs/dataset.md, section "The failure table").
# Times are in the dataset clock (inferred UTC). "ext" fields are the data-derived
# episode boundaries; "uci" fields reproduce the published row.
FAILURES = [
    {
        "id": "F1",
        "uci_nr": "#1",
        "start": "2020-04-18 00:00:00",
        "end": "2020-04-19 02:00:00",
        "uci_start": "2020-04-18 00:00:00",
        "uci_end": "2020-04-18 23:59:00",
        "data_onset": "2020-04-18 00:23:59",
        "data_recovery": "2020-04-19 01:55:36",
        "maintenance": None,
        "report_local": "2020-04-18 07:05",
        "type": "air_leak",
        "signature": "A",
        "component": "pneumatic panel (dryer/drain side)",
    },
    {
        "id": "F2",
        "uci_nr": "#1 (duplicate, read as #2)",
        "start": "2020-05-29 23:30:00",
        "end": "2020-05-30 06:00:00",
        "uci_start": "2020-05-29 23:30:00",
        "uci_end": "2020-05-30 06:00:00",
        "data_onset": "2020-05-29 23:14:56",
        "data_recovery": "2020-05-30 05:56:46",
        "maintenance": "2020-05-30 12:00:00",
        "report_local": "2020-05-30 01:10",
        "type": "air_leak",
        "signature": "A",
        "component": "pneumatic panel (dryer/drain side)",
    },
    {
        "id": "F3",
        "uci_nr": "#3",
        "start": "2020-06-05 10:00:00",
        "end": "2020-06-07 14:30:00",
        "uci_start": "2020-06-05 10:00:00",
        "uci_end": "2020-06-07 14:30:00",
        "data_onset": "2020-06-05 09:48:30",
        "data_recovery": "2020-06-08 13:54:18",
        "maintenance": "2020-06-08 16:00:00",
        "report_local": "2020-06-05 18:00",
        "type": "air_leak",
        "signature": "A",
        "component": "pneumatic panel (dryer/drain side)",
    },
    {
        "id": "F4",
        "uci_nr": "#4",
        "start": "2020-07-15 14:30:00",
        "end": "2020-07-15 19:00:00",
        "uci_start": "2020-07-15 14:30:00",
        "uci_end": "2020-07-15 19:00:00",
        "data_onset": "2020-07-15 14:25:23",
        "data_recovery": "2020-07-15 18:52:54",
        "maintenance": "2020-07-16 00:00:00",
        "report_local": "2020-07-15 18:25",
        "type": "air_leak",
        "signature": "B",
        "component": "pneumatic panel (downstream/clients side)",
    },
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def r(x, nd=4):
    """Round for JSON; NaN becomes None."""
    if x is None:
        return None
    if isinstance(x, (float, np.floating)):
        return None if np.isnan(x) else round(float(x), nd)
    if isinstance(x, (int, np.integer)):
        return int(x)
    return x


def stats(s: pd.Series) -> dict:
    if len(s) == 0:
        return {"n": 0}
    q = s.quantile(QUANTILES)
    return {
        "n": len(s),
        "min": r(s.min()),
        "max": r(s.max()),
        "mean": r(s.mean()),
        "std": r(s.std()),
        "p1": r(q[0.01]),
        "p5": r(q[0.05]),
        "p50": r(q[0.50]),
        "p95": r(q[0.95]),
        "p99": r(q[0.99]),
    }


def load(csv: Path) -> pd.DataFrame:
    log(f"reading {csv}")
    df = pd.read_csv(csv, index_col=0)
    df.index.name = "source_index"
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.reset_index()
    return df


def derive(df: pd.DataFrame) -> pd.DataFrame:
    """Add dt, gap, frozen and state columns."""
    dt = df.timestamp.diff().dt.total_seconds()
    df["dt"] = dt.fillna(10.0)
    df["gap_before"] = df.dt > GAP_SECONDS
    key = df[["TP2", "TP3", "H1", "Oil_temperature", "Motor_current"]]
    same = key.diff().abs().sum(axis=1) == 0
    run = (same != same.shift()).cumsum()
    run_len = same.groupby(run).transform("size")
    df["frozen"] = same & (run_len >= FROZEN_ROWS)
    loaded = (df.COMP == 0) & (df.DV_eletric == 1)
    running = df.Motor_current >= RUNNING_AMPS
    df["state"] = np.where(loaded, "loaded", np.where(running, "unloaded", "off"))
    cur = np.where(df.Motor_current >= 4.6, "loaded", np.where(running, "unloaded", "off"))
    df["state_current_only"] = cur
    return df


def segments(df: pd.DataFrame) -> pd.DataFrame:
    seg = (df.state != df.state.shift()).cumsum()
    df["seg"] = seg
    segs = df.groupby("seg").agg(
        state=("state", "first"),
        start=("timestamp", "first"),
        end=("timestamp", "last"),
        n=("timestamp", "size"),
        tp3_first=("TP3", "first"),
        tp3_last=("TP3", "last"),
        tp3_min=("TP3", "min"),
        tp3_max=("TP3", "max"),
        tp3_med=("TP3", "median"),
        dvp_med=("DV_pressure", "median"),
        oil_max=("Oil_temperature", "max"),
        mc_med=("Motor_current", "median"),
        lps=("LPS", "sum"),
        has_gap=("gap_before", "any"),
        has_frozen=("frozen", "any"),
        towers0=("Towers", lambda s: int((s == 0).sum())),
    )
    segs["dur_s"] = (segs.end - segs.start).dt.total_seconds() + 10
    segs["starts_after_gap"] = df.groupby("seg").gap_before.first()
    # a segment is dirty if it contains a gap or frozen rows, or starts right after a gap
    segs["dirty"] = segs.has_gap | segs.has_frozen | segs.starts_after_gap
    return segs


def cycles(df: pd.DataFrame, segs: pd.DataFrame) -> pd.DataFrame:
    """One row per loaded run: cut-in, cut-out, following unloaded and off durations, drop rates."""
    runs = segs[segs.state == "loaded"].copy()
    idx = runs.index.to_numpy()
    nxt, nxt2 = segs.shift(-1), segs.shift(-2)
    runs["cutin_tp3"] = runs.tp3_first
    runs["cutout_tp3"] = runs.tp3_max
    runs["unl_dur_s"] = np.where(nxt.loc[idx, "state"] == "unloaded", nxt.loc[idx, "dur_s"], np.nan)
    runs["unl_tp3_last"] = np.where(
        nxt.loc[idx, "state"] == "unloaded", nxt.loc[idx, "tp3_last"], np.nan
    )
    runs["off_dur_s"] = np.where(
        (nxt.loc[idx, "state"] == "unloaded") & (nxt2.loc[idx, "state"] == "off"),
        nxt2.loc[idx, "dur_s"],
        np.where(nxt.loc[idx, "state"] == "off", nxt.loc[idx, "dur_s"], np.nan),
    )
    runs["next_start"] = runs.start.shift(-1)
    runs["next_cutin_tp3"] = runs.cutin_tp3.shift(-1)
    runs["nonload_dur_s"] = (runs.next_start - runs.end).dt.total_seconds()
    runs["drop_rate_nonload"] = (runs.cutout_tp3 - runs.next_cutin_tp3) / (
        runs.nonload_dur_s / 60.0
    )
    runs["drop_rate_unloaded"] = (runs.cutout_tp3 - runs.unl_tp3_last) / (runs.unl_dur_s / 60.0)
    dirty_times = df.loc[df.gap_before | df.frozen, "timestamp"].to_numpy()
    ends = runs.end.to_numpy()
    starts = runs.next_start.to_numpy()
    lo = np.searchsorted(dirty_times, ends, side="right")
    hi = np.searchsorted(dirty_times, starts, side="right")
    runs["dirty_between"] = (hi - lo) > 0
    runs["clean"] = (
        (~runs.dirty)
        & (~runs.dirty_between)
        & runs.next_start.notna()
        & (runs.nonload_dur_s < MAX_NONLOAD_S)
    )
    runs["towers0_s"] = runs.towers0 * 10.0
    return runs


def covered_hours(dfw: pd.DataFrame) -> float:
    return float(dfw.dt.clip(upper=GAP_SECONDS).sum() / 3600.0)


def window_metrics(
    df: pd.DataFrame, runs: pd.DataFrame, a, b, offs: pd.DataFrame | None = None
) -> dict:
    a, b = pd.Timestamp(a), pd.Timestamp(b)
    dfw = df[(df.timestamp >= a) & (df.timestamp < b)]
    good = dfw[~dfw.frozen]
    runs_w = runs[(runs.start >= a) & (runs.start < b)]
    c = runs_w[runs_w.clean]
    hours = covered_hours(dfw)
    ld = good[good.state == "loaded"]
    m = {
        "rows": len(dfw),
        "frozen_rows": int(dfw.frozen.sum()),
        "covered_hours": r(hours, 2),
        "gaps_gt_60s": int(dfw.gap_before.sum()),
        "cycles": len(runs_w),
        "clean_cycles": len(c),
        "cycles_per_hour": r(len(runs_w) / hours, 3) if hours else None,
        "loaded_fraction": r((good.state == "loaded").mean(), 4) if len(good) else None,
        "unloaded_fraction": r((good.state == "unloaded").mean(), 4) if len(good) else None,
        "off_fraction": r((good.state == "off").mean(), 4) if len(good) else None,
        "loaded_s": stats(c.dur_s) if len(c) else {"n": 0},
        "unloaded_s": stats(c.unl_dur_s.dropna()) if len(c) else {"n": 0},
        "off_s": stats(c.off_dur_s.dropna()) if len(c) else {"n": 0},
        "nonloaded_s": stats(c.nonload_dur_s) if len(c) else {"n": 0},
        "cutin_tp3_bar": stats(c.cutin_tp3) if len(c) else {"n": 0},
        "cutout_tp3_bar": stats(c.cutout_tp3) if len(c) else {"n": 0},
        "drop_rate_nonloaded_bar_per_min": stats(c.drop_rate_nonload.dropna())
        if len(c)
        else {"n": 0},
        "drop_rate_unloaded_bar_per_min": stats(c.drop_rate_unloaded.dropna())
        if len(c)
        else {"n": 0},
        "towers0_per_cycle_s": stats(c.towers0_s) if len(c) else {"n": 0},
        "motor_current_loaded_A": stats(ld.Motor_current) if len(ld) else {"n": 0},
        "tp2_minus_tp3_loaded_bar": stats(ld.TP2 - ld.TP3) if len(ld) else {"n": 0},
        "oil_temperature_C": stats(good.Oil_temperature) if len(good) else {"n": 0},
        "oil_temperature_loaded_C": stats(ld.Oil_temperature) if len(ld) else {"n": 0},
        "dv_pressure_loaded_bar": stats(ld.DV_pressure) if len(ld) else {"n": 0},
        "dv_pressure_gt1_fraction": r((good.DV_pressure > 1).mean(), 4) if len(good) else None,
        "tp3_bar": stats(good.TP3) if len(good) else {"n": 0},
        "lps_rows": int(dfw.LPS.sum()),
        "lps_fraction": r(dfw.LPS.mean(), 5) if len(dfw) else None,
        "pressure_switch0_rows": int((dfw.Pressure_switch == 0).sum()),
        "oil_level0_fraction": r((dfw.Oil_level == 0).mean(), 4) if len(dfw) else None,
        "caudal0_fraction": r((dfw.Caudal_impulses == 0).mean(), 4) if len(dfw) else None,
        "towers0_fraction": r((dfw.Towers == 0).mean(), 4) if len(dfw) else None,
    }
    if offs is not None:
        o = offs[(offs.start >= a) & (offs.start < b)]
        m["drop_rate_off_bar_per_min"] = stats(o.drop_rate_off.dropna()) if len(o) else {"n": 0}
    return m


def daily_table(df: pd.DataFrame, runs: pd.DataFrame) -> list[dict]:
    rows = []
    for day, dfw in df.groupby(df.timestamp.dt.floor("D")):
        good = dfw[~dfw.frozen]
        runs_w = runs[(runs.start >= dfw.timestamp.min()) & (runs.start <= dfw.timestamp.max())]
        c = runs_w[runs_w.clean]
        hours = covered_hours(dfw)
        ld = good[good.state == "loaded"]
        rows.append(
            {
                "day": str(day.date()),
                "rows": len(dfw),
                "frozen_rows": int(dfw.frozen.sum()),
                "covered_h": r(hours, 2),
                "cycles": len(runs_w),
                "cyc_per_h": r(len(runs_w) / hours, 2) if hours else None,
                "loaded_frac": r((good.state == "loaded").mean(), 3) if len(good) else None,
                "load_s_med": r(c.dur_s.median(), 0) if len(c) else None,
                "unl_s_med": r(c.unl_dur_s.median(), 0) if len(c) else None,
                "off_s_med": r(c.off_dur_s.median(), 0) if len(c) else None,
                "cutin_med": r(c.cutin_tp3.median(), 3) if len(c) else None,
                "cutout_med": r(c.cutout_tp3.median(), 3) if len(c) else None,
                "drop_med": r(c.drop_rate_nonload.median(), 3) if len(c) else None,
                "mc_loaded_med": r(ld.Motor_current.median(), 3) if len(ld) else None,
                "oil_med": r(good.Oil_temperature.median(), 2) if len(good) else None,
                "oil_p95": r(good.Oil_temperature.quantile(0.95), 2) if len(good) else None,
                "oil_max": r(good.Oil_temperature.max(), 2) if len(good) else None,
                "tp3_min": r(good.TP3.min(), 3) if len(good) else None,
                "dvp_gt1_frac": r((good.DV_pressure > 1).mean(), 3) if len(good) else None,
                "lps_rows": int(dfw.LPS.sum()),
                "psw0_rows": int((dfw.Pressure_switch == 0).sum()),
                "oil_level0_frac": r((dfw.Oil_level == 0).mean(), 3),
                "caudal0_frac": r((dfw.Caudal_impulses == 0).mean(), 3),
            }
        )
    return rows


def episodes_continuous_load(segs: pd.DataFrame) -> list[dict]:
    """Loaded runs with >= 45 min of samples: the 'stuck loaded' events (labelled or not).

    Runs that cross a logging gap or a frozen block are kept but flagged; runs whose
    samples cover less than 40 % of their wall-clock span are dropped (gap artefacts).
    """
    eps = segs[(segs.state == "loaded") & (segs.n >= 270)].copy()
    eps["density"] = eps.n / (eps.dur_s / 10.0)
    eps = eps[eps.density >= 0.4]
    out = []
    for _, e in eps.iterrows():
        out.append(
            {
                "start": str(e.start),
                "end": str(e.end),
                "hours": r(e.dur_s / 3600, 2),
                "rows": int(e.n),
                "sample_density": r(e.density, 3),
                "crosses_gap": bool(e.has_gap),
                "contains_frozen": bool(e.has_frozen),
                "tp3_median": r(e.tp3_med, 3),
                "tp3_min": r(e.tp3_min, 3),
                "dv_pressure_median": r(e.dvp_med, 3),
                "oil_max": r(e.oil_max, 2),
                "motor_current_median": r(e.mc_med, 3),
                "lps_rows": int(e.lps),
            }
        )
    return out


def lps_episodes(df: pd.DataFrame) -> list[dict]:
    lps = df.LPS == 1
    run = (lps != lps.shift()).cumsum()
    pos = pd.Series(np.arange(len(df)), index=df.index)
    eps = (
        df[lps]
        .assign(_pos=pos[lps])
        .groupby(run[lps])
        .agg(
            start=("timestamp", "first"),
            end=("timestamp", "last"),
            n=("timestamp", "size"),
            tp3_min=("TP3", "min"),
            tp3_first=("TP3", "first"),
            after_gap=("gap_before", "first"),
            first_pos=("_pos", "first"),
        )
    )
    eps = eps[eps.n >= 3]
    tp3 = df.TP3.to_numpy()
    out = []
    for _, e in eps.iterrows():
        before = tp3[int(e.first_pos) - 1] if e.first_pos > 0 else np.nan
        out.append(
            {
                "start": str(e.start),
                "end": str(e.end),
                "minutes": r((e.n * 10) / 60, 1),
                "tp3_first": r(e.tp3_first, 3),
                "tp3_before": r(before, 3),
                "tp3_min": r(e.tp3_min, 3),
                "starts_after_gap": bool(e.after_gap),
            }
        )
    return out


def blocks(df: pd.DataFrame, mask: pd.Series, min_rows: int) -> list[dict]:
    run = (mask != mask.shift()).cumsum()
    found = (
        df[mask]
        .groupby(run[mask])
        .agg(start=("timestamp", "first"), end=("timestamp", "last"), n=("timestamp", "size"))
    )
    found = found[found.n >= min_rows]
    return [
        {
            "start": str(b.start),
            "end": str(b.end),
            "rows": int(b.n),
            "hours": r(((b.end - b.start).total_seconds() + 10) / 3600, 2),
        }
        for _, b in found.iterrows()
    ]


def main() -> None:  # noqa: PLR0915 - one flat pass that assembles the whole report
    ap = argparse.ArgumentParser()
    here = Path(__file__).resolve()
    root = here.parents[2] if len(here.parents) > 2 else Path.cwd()
    ap.add_argument(
        "--csv", default=str(root / "data" / "metropt3" / "MetroPT3(AirCompressor).csv")
    )
    ap.add_argument("--out", default=str(root / "data" / "metropt3-first-month-stats.json"))
    ap.add_argument("--no-sha", action="store_true", help="skip hashing the CSV")
    args = ap.parse_args()
    csv, out = Path(args.csv), Path(args.out)

    df = derive(load(csv))
    segs = segments(df)
    runs = cycles(df, segs)
    offs = segs[
        (segs.state == "off") & ~segs.dirty & (segs.dur_s > 60) & (segs.dur_s < MAX_NONLOAD_S)
    ].copy()
    offs["drop_rate_off"] = (offs.tp3_first - offs.tp3_last) / (offs.dur_s / 60.0)

    ts = df.timestamp
    dt = df.dt.iloc[1:]
    gaps = df[df.gap_before]
    gap_list = [
        {"start": str(t - pd.Timedelta(seconds=s)), "end": str(t), "seconds": int(s)}
        for t, s in zip(gaps.timestamp, gaps.dt, strict=True)
    ]
    gap_list.sort(key=lambda g: -g["seconds"])

    a, b = pd.Timestamp(FIRST_MONTH[0]), pd.Timestamp(FIRST_MONTH[1])
    fm = df[(ts >= a) & (ts <= b)]
    fm_good = fm[~fm.frozen]
    per_col = {}
    for col in COLUMNS:
        per_col[col] = {"all": stats(fm_good[col])}
        for st in ["loaded", "unloaded", "off"]:
            per_col[col][st] = stats(fm_good.loc[fm_good.state == st, col])

    runs_fm = runs[(runs.start >= a) & (runs.start <= b)]
    per_day = runs_fm.groupby(runs_fm.start.dt.floor("D")).size()
    by_hour = runs_fm.start.dt.hour.value_counts().sort_index()
    fm_metrics = window_metrics(df, runs, a, b + pd.Timedelta(seconds=1), offs)
    fm_metrics["cycles_per_day"] = stats(per_day.astype(float))
    fm_metrics["cycles_by_hour_of_day_total"] = {int(h): int(n) for h, n in by_hour.items()}
    fm_metrics["days_with_data"] = int(fm.timestamp.dt.floor("D").nunique())
    fm_metrics["state_rows"] = {k: int(v) for k, v in fm_good.state.value_counts().items()}
    fm_metrics["digital_value_fraction_1"] = {c: r(fm_good[c].mean(), 5) for c in DIGITAL}

    fail = []
    for f in FAILURES:
        s, e = pd.Timestamp(f["start"]), pd.Timestamp(f["end"])
        entry = dict(f)
        entry["pre48h"] = window_metrics(df, runs, s - pd.Timedelta(hours=48), s, offs)
        entry["pre24h"] = window_metrics(df, runs, s - pd.Timedelta(hours=24), s, offs)
        entry["inside"] = window_metrics(df, runs, s, e, offs)
        entry["post24h"] = window_metrics(df, runs, e, e + pd.Timedelta(hours=24), offs)
        fail.append(entry)

    lps_on = df.LPS == 1
    rise = lps_on & (df.LPS.shift() == 0) & ~df.gap_before
    fall = (~lps_on) & (df.LPS.shift() == 1) & ~df.gap_before
    lps_thresholds = {
        "rising_edges": int(rise.sum()),
        "tp3_at_rise": stats(df.loc[rise, "TP3"]),
        "tp3_one_sample_before_rise": stats(df.TP3.shift(1)[rise]),
        "tp3_at_reset": stats(df.loc[fall, "TP3"]),
        "tp3_max_while_lps_on": r(df.loc[lps_on, "TP3"].max(), 3),
        "tp3_p001_while_lps_off": r(df.loc[~lps_on, "TP3"].quantile(0.001), 3),
    }

    state_agreement = float((df.state == df.state_current_only).mean())
    digital_combos = df.groupby(["COMP", "DV_eletric", "MPG"]).size()
    combos = [
        {"COMP": int(k[0]), "DV_eletric": int(k[1]), "MPG": int(k[2]), "rows": int(v)}
        for k, v in digital_combos.items()
    ]

    result = {
        "_license": "CC-BY-4.0",
        "_note": (
            "Derived statistics from the MetroPT-3 dataset; see docs/dataset.md. REUSE: this JSON "
            "is annotated in REUSE.toml (CC-BY-4.0) because JSON has no comment syntax."
        ),
        "_credit": (
            "Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021). MetroPT-3 Dataset. UCI "
            "Machine Learning Repository. https://doi.org/10.24432/C5VW3R. CC BY 4.0."
        ),
        "_generated_by": "scripts/data/metropt3_stats.py",
        "source": {
            "file": csv.name,
            "bytes": csv.stat().st_size,
            "sha256": None if args.no_sha else sha256_of(csv),
            "rows": len(df),
            "first_timestamp": str(ts.min()),
            "last_timestamp": str(ts.max()),
            "span_hours": r((ts.max() - ts.min()).total_seconds() / 3600, 2),
            "source_index_step": int(df.source_index.diff().dropna().mode().iloc[0]),
            "source_index_max": int(df.source_index.max()),
            "timestamps_monotonic": bool(ts.is_monotonic_increasing),
            "duplicate_timestamps": int(ts.duplicated().sum()),
            "null_values": int(df[COLUMNS].isna().sum().sum()),
            "sampling_dt_seconds": {
                "median": r(dt.median(), 1),
                "mean": r(dt.mean(), 3),
                "value_counts_top": {
                    str(int(k)): int(v) for k, v in dt.value_counts().head(8).items()
                },
            },
            "gaps": {
                "threshold_seconds": GAP_SECONDS,
                "count": len(gap_list),
                "count_gt_600s": int((gaps.dt > 600).sum()),
                "count_gt_3600s": int((gaps.dt > 3600).sum()),
                "count_gt_86400s": int((gaps.dt > 86400).sum()),
                "total_hours": r(gaps.dt.sum() / 3600, 2),
                "longest": gap_list[:15],
                "gaps_over_1h": sorted(
                    [g for g in gap_list if g["seconds"] > 3600], key=lambda g: g["start"]
                ),
            },
            "rows_per_day_min_max": [
                int(df.timestamp.dt.floor("D").value_counts().min()),
                int(df.timestamp.dt.floor("D").value_counts().max()),
            ],
            "missing_days": [
                str(d.date())
                for d in pd.date_range(ts.min().floor("D"), ts.max().floor("D"))
                if d not in set(df.timestamp.dt.floor("D").unique())
            ],
        },
        "state_logic": {
            "rule": (
                "loaded = (COMP == 0 and DV_eletric == 1); "
                "unloaded = not loaded and Motor_current >= 1.0 A; "
                "off = not loaded and Motor_current < 1.0 A"
            ),
            "current_only_rule": (
                "loaded = Motor_current >= 4.6 A; unloaded = 1.0 <= Motor_current < 4.6 A; "
                "off = < 1.0 A"
            ),
            "agreement_digital_vs_current_only": r(state_agreement, 5),
            "rows_by_state": {k: int(v) for k, v in df.state.value_counts().items()},
            "digital_combos_COMP_DVeletric_MPG": combos,
            "frozen_rule": (
                "identical (TP2, TP3, H1, Oil_temperature, Motor_current) "
                f"for >= {FROZEN_ROWS} consecutive rows"
            ),
            "frozen_rows_total": int(df.frozen.sum()),
        },
        "first_month": {
            "range": list(FIRST_MONTH),
            "rows": len(fm),
            "frozen_rows_excluded": int(fm.frozen.sum()),
            "columns": per_col,
            "cycles": fm_metrics,
        },
        "lps_thresholds": lps_thresholds,
        "failures": fail,
        "continuous_load_episodes_ge_45min": episodes_continuous_load(segs),
        "lps_episodes_ge_30s": lps_episodes(df),
        "data_quality": {
            "frozen_blocks": blocks(df, df.frozen, FROZEN_ROWS),
            "caudal_impulses_zero_blocks_ge_1h": blocks(df, df.Caudal_impulses == 0, 360),
            "oil_level_zero_blocks_ge_1h": blocks(df, df.Oil_level == 0, 360),
            "oil_level_zero_fraction_by_month": {
                int(k): r(v, 4) for k, v in (df.Oil_level == 0).groupby(ts.dt.month).mean().items()
            },
            "caudal_zero_fraction_by_month": {
                int(k): r(v, 4)
                for k, v in (df.Caudal_impulses == 0).groupby(ts.dt.month).mean().items()
            },
            "dv_pressure_gt1_rows_by_month": {
                int(k): int(v) for k, v in (df.DV_pressure > 1).groupby(ts.dt.month).sum().items()
            },
            "lps_rows_by_month": {
                int(k): int(v) for k, v in df.LPS.groupby(ts.dt.month).sum().items()
            },
            "pressure_switch_zero_run_length_max": int(blocks_max_run(df, df.Pressure_switch == 0)),
        },
        "daily": daily_table(df, runs),
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, allow_nan=False) + "\n")
    log(f"wrote {out} ({out.stat().st_size / 1024:.0f} KiB)")

    # Short human summary on stdout
    fmc = fm_metrics
    print(
        f"rows={len(df)} span={ts.min()}..{ts.max()} gaps>60s={len(gap_list)} "
        f"frozen_rows={int(df.frozen.sum())}"
    )
    print(
        f"first month: rows={len(fm)} cycles={fmc['cycles']} cyc/h={fmc['cycles_per_hour']} "
        f"loaded_frac={fmc['loaded_fraction']} load_s_p50={fmc['loaded_s']['p50']} "
        f"unl_s_p50={fmc['unloaded_s']['p50']} off_s_p50={fmc['off_s']['p50']} "
        f"cutin_p50={fmc['cutin_tp3_bar']['p50']} cutout_p50={fmc['cutout_tp3_bar']['p50']} "
        f"drop_nonload_p50={fmc['drop_rate_nonloaded_bar_per_min']['p50']} "
        f"drop_off_p50={fmc['drop_rate_off_bar_per_min']['p50']} "
        f"drop_unl_p50={fmc['drop_rate_unloaded_bar_per_min']['p50']} "
        f"mc_loaded_p50={fmc['motor_current_loaded_A']['p50']} "
        f"oil_p50={fmc['oil_temperature_C']['p50']} oil_p95={fmc['oil_temperature_C']['p95']}"
    )
    for f in fail:
        for w in ["pre48h", "inside"]:
            m = f[w]
            print(
                f"{f['id']} {w}: cyc/h={m['cycles_per_hour']} loaded={m['loaded_fraction']} "
                f"load_s={m['loaded_s'].get('p50')} off_s={m['off_s'].get('p50')} "
                f"drop={m['drop_rate_nonloaded_bar_per_min'].get('p50')} "
                f"dvp>1={m['dv_pressure_gt1_fraction']} "
                f"oil_p50={m['oil_temperature_C'].get('p50')} "
                f"oil_max={m['oil_temperature_C'].get('max')} "
                f"mc_loaded={m['motor_current_loaded_A'].get('p50')} "
                f"tp3_p50={m['tp3_bar'].get('p50')} lps={m['lps_rows']}"
            )


def blocks_max_run(df: pd.DataFrame, mask: pd.Series) -> int:
    run = (mask != mask.shift()).cumsum()
    return int(mask.groupby(run).sum().max())


if __name__ == "__main__":
    main()

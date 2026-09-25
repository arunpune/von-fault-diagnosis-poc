// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Derives `data/metropt3-failures.json` from `data/metropt3-first-month-stats.json` at the
// repository root (docs/dataset.md#the-failure-table). Everything that can be read out of the
// statistics is read out of them; the corrections that resolve the published table — which row is
// which, an unknown onset, a typed month, the accepted causes — are the constants below, each one
// traceable to a numbered note of docs/dataset.md#how-the-windows-were-resolved.
//
//   node --conditions=@fdp/source scripts/build-failure-table.ts            writes the file
//   node --conditions=@fdp/source scripts/build-failure-table.ts --check    compares instead
//
// The comparison is byte for byte: the committed file is the contract, and `--check` is what
// proves it is still a function of the statistics. `packages/ground-truth/data` is outside
// Prettier's reach (`.prettierignore`), so nothing reformats the output behind the generator.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const STATS_FILE = join(REPO_ROOT, "data", "metropt3-first-month-stats.json");
const OUTPUT_FILE = join(PACKAGE_ROOT, "data", "metropt3-failures.json");

/** The cause of the manual's registry every unlabelled episode looks like. */
const UNLABELLED_HINT = "dryer_purge_leak";

/**
 * Below this median loaded current the motor is off, so the episode is a depressurisation in the
 * depot rather than a stuck-loaded leak. The two such rows of `continuous_load_episodes_ge_45min`
 * sit at 0.022 A; every real episode is above 5 A.
 */
const MOTOR_OFF_CURRENT_A = 1;

/** An episode of the low-pressure switch this long or longer is a window of its own. */
const DEPOT_MIN_MINUTES = 30;

interface StatsFailure {
  readonly id: string;
  readonly uci_nr: string;
  readonly start: string;
  readonly end: string;
  readonly uci_start: string;
  readonly uci_end: string;
  readonly data_onset: string;
  readonly data_recovery: string;
  readonly maintenance: string | null;
  readonly report_local: string;
  readonly signature: string;
  readonly component: string;
}

interface StatsLoadEpisode {
  readonly start: string;
  readonly end: string;
  readonly hours: number;
  readonly tp3_median: number;
  readonly dv_pressure_median: number;
  readonly oil_max: number;
  readonly motor_current_median: number;
}

interface StatsLpsEpisode {
  readonly start: string;
  readonly end: string;
  readonly minutes: number;
}

interface StatsFrozenBlock {
  readonly start: string;
  readonly end: string;
  readonly rows: number;
  readonly hours: number;
}

interface StatsGap {
  readonly start: string;
  readonly end: string;
  readonly seconds: number;
}

interface Stats {
  readonly source: {
    readonly sha256: string;
    readonly gaps: { readonly gaps_over_1h: readonly StatsGap[] };
  };
  readonly failures: readonly StatsFailure[];
  readonly continuous_load_episodes_ge_45min: readonly StatsLoadEpisode[];
  readonly lps_episodes_ge_30s: readonly StatsLpsEpisode[];
  readonly data_quality: { readonly frozen_blocks: readonly StatsFrozenBlock[] };
}

/** One row of the document, in the shape `gt-failure-table` defines. */
interface FailureRow {
  readonly id: string;
  readonly uci_nr: string | null;
  readonly start: string;
  readonly end: string;
  readonly uci_start: string | null;
  readonly uci_end: string | null;
  readonly data_onset: string | null;
  readonly data_recovery: string | null;
  readonly onset_known: boolean;
  readonly precursor_from: string | null;
  readonly report_local: string | null;
  readonly maintenance: string | null;
  readonly maintenance_verified: boolean;
  readonly fault_id: string;
  readonly accepted_fault_ids: readonly string[];
  readonly signature: string;
  readonly component: string;
  readonly native_alarm_first: string | null;
  readonly in_headline: boolean;
  readonly notes: string;
}

/** One unlabelled continuous-load episode of the document. */
interface EpisodeRow {
  readonly start: string;
  readonly end: string;
  readonly hours: number;
  readonly tp3_median: number;
  readonly dv_pressure_median: number;
  readonly oil_max: number;
  readonly fault_id_hint: string;
  readonly note: string;
}

/** What the statistics cannot say: the resolution of the published table. */
interface Correction {
  readonly onset_known: boolean;
  readonly precursor_from: string | null;
  readonly maintenance_verified: boolean;
  readonly fault_id: string;
  readonly accepted_fault_ids: readonly string[];
  readonly in_headline: boolean;
  readonly notes: string;
}

const SIGNATURE_A_ACCEPTED = ["dryer_purge_leak", "downstream_air_leak"] as const;

const CORRECTIONS: Readonly<Record<string, Correction>> = {
  F1: {
    onset_known: false,
    precursor_from: null,
    maintenance_verified: false,
    fault_id: "dryer_purge_leak",
    accepted_fault_ids: SIGNATURE_A_ACCEPTED,
    in_headline: true,
    notes:
      "The logger was frozen from 17 April 09:20 until 18 April 00:18, so the true onset is " +
      "unknown and every lead time for this failure is a lower bound. The published end is a " +
      "whole-day placeholder; the stuck-loaded run continues until 01:56 on 19 April and the " +
      "repair venting follows from 02:13 to 02:47. No maintenance note exists for it.",
  },
  F2: {
    onset_known: true,
    precursor_from: null,
    maintenance_verified: false,
    fault_id: "dryer_purge_leak",
    accepted_fault_ids: SIGNATURE_A_ACCEPTED,
    in_headline: true,
    notes:
      "The published table repeats the number of the first row; read it as the second. The " +
      "maintenance note names April, which is a typed month for 30 May, and the data shows no " +
      "intervention at the recorded hour, so the time is reported rather than verified.",
  },
  F3: {
    onset_known: true,
    precursor_from: null,
    maintenance_verified: false,
    fault_id: "dryer_purge_leak",
    accepted_fault_ids: SIGNATURE_A_ACCEPTED,
    in_headline: true,
    notes:
      "The published end is when logging stopped, not when the leak ended. The unit was still " +
      "loaded when logging resumed on 8 June and normal cycling returns at 13:54, before the " +
      "maintenance note at 16:00, so that note is not verified; the repair period in between " +
      "is an excluded window.",
  },
  F4: {
    onset_known: true,
    precursor_from: "2020-07-14T21:28:00.000Z",
    maintenance_verified: true,
    fault_id: "downstream_air_leak",
    accepted_fault_ids: ["downstream_air_leak"],
    in_headline: true,
    notes:
      "The window covers the acute phase only. The fast decay of this signature is measurable " +
      "from 14 July 21:28, and the decay rate normalises at exactly the maintenance hour, " +
      "which is what verifies the note.",
  },
};

/** The recurrence the published table does not carry at all (note 6 of the resolution). */
const F4B = {
  id: "F4b",
  uci_nr: null,
  start: "2020-07-16T20:00:00.000Z",
  end: "2020-07-17T06:00:00.000Z",
  uci_start: null,
  uci_end: null,
  data_onset: "2020-07-17T00:54:00.000Z",
  data_recovery: "2020-07-17T05:35:00.000Z",
  onset_known: true,
  precursor_from: null,
  report_local: "2020-07-17 05:46",
  maintenance: null,
  maintenance_verified: false,
  fault_id: "downstream_air_leak",
  accepted_fault_ids: ["downstream_air_leak"],
  signature: "B",
  component: "pneumatic panel (downstream/clients side)",
  in_headline: false,
  notes:
    "A recurrence the thesis reports and the published table does not carry, twenty hours " +
    "after the maintenance of the preceding failure. It counts as a secondary positive or as " +
    "an excluded window, never as a false positive.",
} as const;

/**
 * The note of each unlabelled episode, keyed by its start in the statistics.
 *
 * An episode with no entry is one of the short precursors the section groups in its last row.
 */
const EPISODE_NOTES: Readonly<Record<string, string>> = {
  "2020-03-12 00:16:06": "The thesis records a strange-noise report at 08:25 on the same day.",
  "2020-03-27 07:12:10": "The thesis lists a report on this day without any detail.",
  "2020-03-28 07:22:24": "A vent from 23:05 to 23:28 on 28 March; never reported.",
  "2020-04-12 11:50:31": "Six days before the first labelled failure.",
  "2020-05-13 13:44:04": "Sixteen days before the second labelled failure.",
  "2020-05-19 22:22:17": "Ten days before the second labelled failure.",
};

const SHORT_EPISODE_NOTE =
  "A short stuck-loaded episode with raised purge pressure, of the same kind as the labelled " +
  "failures and never reported.";

/** The three repair periods, which are neither positive nor negative. */
const REPAIR_WINDOWS: readonly (readonly [string, string])[] = [
  ["2020-04-19T02:00:00.000Z", "2020-04-19T03:30:00.000Z"],
  ["2020-06-07T14:30:00.000Z", "2020-06-08T16:00:00.000Z"],
  ["2020-07-15T19:00:00.000Z", "2020-07-16T01:00:00.000Z"],
];

const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Turns a naive timestamp of the statistics into the project's `iso_ts`.
 *
 * The recorded clock carries no zone and the project reads it as UTC, so the conversion is a
 * reformatting and never an arithmetic.
 */
function toIsoTs(naive: string): string {
  if (!NAIVE_TIMESTAMP.test(naive)) {
    throw new Error(`metropt3 statistics: ${naive} is not a naive second-resolution timestamp`);
  }
  return `${naive.replace(" ", "T")}.000Z`;
}

interface Window {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/** `from` inclusive, `to` exclusive, as the label helpers read them. */
function contains(window: { from: string; to: string }, instant: string): boolean {
  return window.from <= instant && instant < window.to;
}

function readStats(): Stats {
  return JSON.parse(readFileSync(STATS_FILE, "utf8")) as Stats;
}

/** The first activation of the low-pressure switch inside a failure window, or `null`. */
function nativeAlarmFirst(stats: Stats, from: string, to: string): string | null {
  for (const episode of stats.lps_episodes_ge_30s) {
    const start = toIsoTs(episode.start);
    if (contains({ from, to }, start)) return start;
  }
  return null;
}

function buildFailures(stats: Stats): FailureRow[] {
  const failures: FailureRow[] = stats.failures.map((row) => {
    const correction = CORRECTIONS[row.id];
    if (correction === undefined) {
      throw new Error(`metropt3 statistics: no correction is recorded for failure ${row.id}`);
    }
    const start = toIsoTs(row.start);
    const end = toIsoTs(row.end);
    return {
      id: row.id,
      uci_nr: row.uci_nr,
      start,
      end,
      uci_start: toIsoTs(row.uci_start),
      uci_end: toIsoTs(row.uci_end),
      data_onset: toIsoTs(row.data_onset),
      data_recovery: toIsoTs(row.data_recovery),
      onset_known: correction.onset_known,
      precursor_from: correction.precursor_from,
      report_local: row.report_local,
      maintenance: row.maintenance === null ? null : toIsoTs(row.maintenance),
      maintenance_verified: correction.maintenance_verified,
      fault_id: correction.fault_id,
      accepted_fault_ids: [...correction.accepted_fault_ids],
      signature: row.signature,
      component: row.component,
      native_alarm_first: nativeAlarmFirst(stats, start, end),
      in_headline: correction.in_headline,
      notes: correction.notes,
    };
  });
  const { in_headline, notes, ...f4b } = F4B;
  failures.push({
    ...f4b,
    accepted_fault_ids: [...F4B.accepted_fault_ids],
    native_alarm_first: nativeAlarmFirst(stats, F4B.start, F4B.end),
    in_headline,
    notes,
  });
  return failures;
}

/**
 * The continuous-load episodes that carry no label.
 *
 * The four episodes that are the labelled failures are recognised by their data onset, and the
 * two depot depressurisations by a median current that says the motor was off.
 */
function buildUnlabelledEpisodes(stats: Stats): EpisodeRow[] {
  const onsets = new Set(stats.failures.map((row) => row.data_onset));
  return stats.continuous_load_episodes_ge_45min
    .filter((episode) => !onsets.has(episode.start))
    .filter((episode) => episode.motor_current_median >= MOTOR_OFF_CURRENT_A)
    .map((episode) => ({
      start: toIsoTs(episode.start),
      end: toIsoTs(episode.end),
      hours: episode.hours,
      tp3_median: episode.tp3_median,
      dv_pressure_median: episode.dv_pressure_median,
      oil_max: episode.oil_max,
      fault_id_hint: UNLABELLED_HINT,
      note: EPISODE_NOTES[episode.start] ?? SHORT_EPISODE_NOTE,
    }));
}

/**
 * The depot depressurisations: a long activation of the low-pressure switch with the motor off.
 *
 * The two activations that fall inside a failure window are that failure's native alarm and not
 * a hard negative, so they are excluded here by the windows themselves.
 */
function buildDepotWindows(stats: Stats, failures: readonly FailureRow[]): Window[] {
  return stats.lps_episodes_ge_30s
    .filter((episode) => episode.minutes >= DEPOT_MIN_MINUTES)
    .map((episode) => ({ from: toIsoTs(episode.start), to: toIsoTs(episode.end) }))
    .filter(
      (window) =>
        !failures.some((failure) =>
          contains({ from: failure.start, to: failure.end }, window.from),
        ),
    )
    .map((window) => ({ ...window, reason: "depot_depressurisation" }));
}

function buildExcludedWindows(
  stats: Stats,
  failures: readonly FailureRow[],
  unlabelled: readonly EpisodeRow[],
): Window[] {
  const windows: Window[] = [
    ...REPAIR_WINDOWS.map(([from, to]) => ({ from, to, reason: "repair" })),
    ...unlabelled.map((episode) => ({
      from: episode.start,
      to: episode.end,
      reason: "unlabelled_positive",
    })),
    ...failures
      .filter((failure) => !failure.in_headline)
      .map((failure) => ({
        from: failure.start,
        to: failure.end,
        reason: "secondary_positive",
      })),
    ...stats.data_quality.frozen_blocks.map((block) => ({
      from: toIsoTs(block.start),
      to: toIsoTs(block.end),
      reason: "frozen_logger",
    })),
    ...buildDepotWindows(stats, failures),
  ];
  // Chronological, so the file reads like a timeline and a lookup can stop early.
  return windows.sort((a, b) =>
    a.from === b.from
      ? a.to === b.to
        ? a.reason.localeCompare(b.reason)
        : a.to < b.to
          ? -1
          : 1
      : a.from < b.from
        ? -1
        : 1,
  );
}

/** The whole document, in the shape of `urn:fdp:schema:gt-failure-table:v1`. */
export function buildFailureTable(): unknown {
  const stats = readStats();
  const failures = buildFailures(stats);
  const unlabelled = buildUnlabelledEpisodes(stats);
  return {
    schema: "urn:fdp:schema:gt-failure-table:v1",
    source: {
      dataset: "MetroPT-3 (UCI 791)",
      doi: "10.24432/C5VW3R",
      license: "CC-BY-4.0",
      csv_sha256: stats.source.sha256,
      resolved_from: "docs/dataset.md#how-the-windows-were-resolved",
    },
    clock: "utc-assumed",
    failures,
    unlabelled_episodes: unlabelled,
    excluded_windows: buildExcludedWindows(stats, failures, unlabelled),
    frozen_blocks: stats.data_quality.frozen_blocks.map((block) => ({
      start: toIsoTs(block.start),
      end: toIsoTs(block.end),
      rows: block.rows,
      hours: block.hours,
    })),
    gaps_over_1h: stats.source.gaps.gaps_over_1h.map((gap) => ({
      start: toIsoTs(gap.start),
      end: toIsoTs(gap.end),
      seconds: gap.seconds,
    })),
  };
}

/** The exact bytes of `data/metropt3-failures.json`. */
export function renderFailureTable(): string {
  return `${JSON.stringify(buildFailureTable(), null, 2)}\n`;
}

function main(argv: readonly string[]): number {
  const rendered = renderFailureTable();
  if (argv.includes("--check")) {
    const committed = readFileSync(OUTPUT_FILE, "utf8");
    if (committed === rendered) {
      process.stdout.write(`@fdp/ground-truth: ${OUTPUT_FILE} is up to date\n`);
      return 0;
    }
    process.stderr.write(
      `@fdp/ground-truth: ${OUTPUT_FILE} differs from what the statistics produce; ` +
        "run `pnpm --filter @fdp/ground-truth build-failure-table`\n",
    );
    return 1;
  }
  writeFileSync(OUTPUT_FILE, rendered);
  process.stdout.write(`@fdp/ground-truth: wrote ${OUTPUT_FILE}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

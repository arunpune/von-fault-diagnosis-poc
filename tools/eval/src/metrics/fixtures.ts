// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Builders for the records the metrics tests score, and the readers for the
// hand-made runs in `fixtures/metrics/`.
//
// Two jobs, one file. The builders keep a table test to the fields it is
// actually about — a matching case says "a ticket at 10:10 naming the wrong
// fault", not eight properties of which six are noise. The readers turn the
// committed JSON, where instants are ISO strings, into the `Date`-carrying
// records the library takes, and they are strict: an unknown level or a
// malformed instant fails at the fixture rather than three assertions later.
//
// It sits in `src/` rather than `test/` because the metrics tests live next to
// the code they cover and because `purity.test.ts` scans this directory —
// the helpers must obey the same import rule as the library.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AlarmActivation,
  DecisionRecord,
  ExcludedWindow,
  GateOutcome,
  Interval,
  Level,
  Prices,
  ScenarioBinding,
  ScenarioExpectation,
  ScenarioGroup,
  ScoringWindow,
  Split,
  SuspectRecord,
  TicketRecord,
} from "./types.ts";
import type { SweepEpisode, SweepRun, ThresholdPair } from "./sweep.ts";

/** Where the hand-made runs live, relative to this file. */
const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "fixtures", "metrics");

/** A `Date` from an ISO string, rejecting anything that names no instant. */
function date(value: unknown, what: string): Date {
  if (typeof value !== "string") throw new TypeError(`${what} is not an ISO string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`${what} names no instant: ${value}`);
  return parsed;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} is not an array`);
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} is not a string`);
  return value;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${what} is not a number`);
  }
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${what} is not a boolean`);
  return value;
}

function level(value: unknown, what: string): Level {
  const text = str(value, what);
  if (text !== "ticket" && text !== "review")
    throw new TypeError(`${what} is not a level: ${text}`);
  return text;
}

function strings(value: unknown, what: string): string[] {
  return array(value, what).map((entry, index) => str(entry, `${what}[${index}]`));
}

// --- Builders -------------------------------------------------------------

/** The instant every builder counts minutes from, so a table test reads in minutes. */
export const EPOCH = new Date("2020-02-03T00:00:00.000Z");

/** `EPOCH` plus `minutes`; the whole vocabulary a matching table test needs. */
export function at(minutes: number): Date {
  return new Date(EPOCH.getTime() + minutes * 60_000);
}

/** A scoring window; `leadFrom` defaults to `from` and the window is a non-benign positive. */
export function window(fields: Partial<ScoringWindow> & { id: string }): ScoringWindow {
  const from = fields.from ?? at(0);
  return {
    from,
    to: fields.to ?? at(60),
    leadFrom: fields.leadFrom ?? from,
    accepted: fields.accepted ?? ["air_leak_downstream"],
    benign: fields.benign ?? false,
    onsetKnown: fields.onsetKnown ?? true,
    headline: fields.headline ?? false,
    ...(fields.onset === undefined ? {} : { onset: fields.onset }),
    ...(fields.nativeLpsFirst === undefined ? {} : { nativeLpsFirst: fields.nativeLpsFirst }),
    id: fields.id,
  };
}

/** An excluded window with a default reason. */
export function excluded(fields: Partial<ExcludedWindow> & { id: string }): ExcludedWindow {
  return {
    from: fields.from ?? at(0),
    to: fields.to ?? at(30),
    reason: fields.reason ?? "repair",
    id: fields.id,
  };
}

/** A ticket; the episode id defaults to the ticket id and the level to `ticket`. */
export function ticket(fields: Partial<TicketRecord> & { ticketId: string }): TicketRecord {
  const fault = fields.faultAtOpen ?? "air_leak_downstream";
  return {
    episodeId: fields.episodeId ?? `e-${fields.ticketId}`,
    openedSimTs: fields.openedSimTs ?? at(0),
    faultAtOpen: fault,
    faultLatest: fields.faultLatest ?? fault,
    maxLevel: fields.maxLevel ?? "ticket",
    ...(fields.closedSimTs === undefined ? {} : { closedSimTs: fields.closedSimTs }),
    ticketId: fields.ticketId,
  };
}

/** A suspect event; the symptom key defaults to the signature-A condition's. */
export function suspect(fields: Partial<SuspectRecord> & { eventId: string }): SuspectRecord {
  return {
    simTs: fields.simTs ?? at(0),
    symptomKey: fields.symptomKey ?? "continuous_load",
    eventId: fields.eventId,
  };
}

/** A decision; free by default, so cost tests state only the tokens they mean. */
export function decision(fields: Partial<DecisionRecord> & { decisionId: string }): DecisionRecord {
  return {
    episodeId: fields.episodeId ?? `e-${fields.decisionId}`,
    simTs: fields.simTs ?? at(0),
    choice: fields.choice ?? "air_leak_downstream",
    confidence: fields.confidence ?? 0.9,
    gate: fields.gate ?? "ticket",
    abstained: fields.abstained ?? false,
    usage: fields.usage ?? { input_tokens: 0, output_tokens: 0 },
    backend: fields.backend ?? "rules",
    benignChoice: fields.benignChoice ?? false,
    decisionId: fields.decisionId,
    ...(fields.persistedSimMin === undefined ? {} : { persistedSimMin: fields.persistedSimMin }),
  };
}

/** Prices with the dated figures the reference cost cases use. */
export const TEST_PRICES: Prices = {
  vonInputPerMtok: 0.042,
  llmInputPerMtok: 5,
  llmOutputPerMtok: 25,
  asOf: "2026-09-19",
};

// --- Fixture documents ----------------------------------------------------

/** One hand-made run from `fixtures/metrics/<name>.json`. */
export interface MetricsFixture {
  readonly id: string;
  readonly backend: string;
  readonly reviewMin: number;
  readonly nativeAlarmCodes: readonly string[];
  readonly prices: Prices;
  readonly binding: ScenarioBinding;
  readonly tickets: readonly TicketRecord[];
  readonly decisions: readonly DecisionRecord[];
  readonly alarms: readonly AlarmActivation[];
  /** The suspect events detection level is scored on; none when the fixture lists none. */
  readonly suspects: readonly SuspectRecord[];
}

/** One sweep fixture: the stored run, the tickets it opened and the grid to score. */
export interface SweepFixture {
  readonly id: string;
  readonly run: SweepRun;
  readonly runTickets: readonly TicketRecord[];
  readonly grid: readonly ThresholdPair[];
}

function readJson(name: string): Record<string, unknown> {
  const path = join(FIXTURE_DIR, name);
  return record(JSON.parse(readFileSync(path, "utf8")), path);
}

function readWindow(value: unknown, what: string): ScoringWindow {
  const source = record(value, what);
  return {
    id: str(source["id"], `${what}.id`),
    from: date(source["from"], `${what}.from`),
    to: date(source["to"], `${what}.to`),
    leadFrom: date(source["lead_from"], `${what}.lead_from`),
    accepted: strings(source["accepted"], `${what}.accepted`),
    benign: bool(source["benign"], `${what}.benign`),
    onsetKnown: bool(source["onset_known"], `${what}.onset_known`),
    headline: bool(source["headline"], `${what}.headline`),
    ...(source["onset"] === undefined ? {} : { onset: date(source["onset"], `${what}.onset`) }),
    ...(source["native_lps_first"] === undefined
      ? {}
      : { nativeLpsFirst: date(source["native_lps_first"], `${what}.native_lps_first`) }),
  };
}

function readInterval(value: unknown, what: string): Interval {
  const source = record(value, what);
  return { from: date(source["from"], `${what}.from`), to: date(source["to"], `${what}.to`) };
}

function readExcluded(value: unknown, what: string): ExcludedWindow {
  const source = record(value, what);
  return {
    id: str(source["id"], `${what}.id`),
    from: date(source["from"], `${what}.from`),
    to: date(source["to"], `${what}.to`),
    reason: str(source["reason"], `${what}.reason`),
  };
}

function readTicket(value: unknown, what: string): TicketRecord {
  const source = record(value, what);
  return {
    ticketId: str(source["ticket_id"], `${what}.ticket_id`),
    episodeId: str(source["episode_id"], `${what}.episode_id`),
    openedSimTs: date(source["opened_sim_ts"], `${what}.opened_sim_ts`),
    faultAtOpen: str(source["fault_at_open"], `${what}.fault_at_open`),
    faultLatest: str(source["fault_latest"], `${what}.fault_latest`),
    maxLevel: level(source["max_level"], `${what}.max_level`),
    ...(source["closed_sim_ts"] === undefined
      ? {}
      : { closedSimTs: date(source["closed_sim_ts"], `${what}.closed_sim_ts`) }),
  };
}

function readGate(value: unknown, what: string): GateOutcome {
  const text = str(value, what);
  if (text !== "ticket" && text !== "review" && text !== "log") {
    throw new TypeError(`${what} is not a gate outcome: ${text}`);
  }
  return text;
}

function readDecision(value: unknown, what: string): DecisionRecord {
  const source = record(value, what);
  const usage = record(source["usage"], `${what}.usage`);
  return {
    decisionId: str(source["decision_id"], `${what}.decision_id`),
    episodeId: str(source["episode_id"], `${what}.episode_id`),
    simTs: date(source["sim_ts"], `${what}.sim_ts`),
    choice: str(source["choice"], `${what}.choice`),
    confidence: num(source["confidence"], `${what}.confidence`),
    gate: readGate(source["gate"], `${what}.gate`),
    abstained: bool(source["abstained"], `${what}.abstained`),
    usage: {
      input_tokens: num(usage["input_tokens"], `${what}.usage.input_tokens`),
      output_tokens: num(usage["output_tokens"], `${what}.usage.output_tokens`),
    },
    backend: str(source["backend"], `${what}.backend`),
    benignChoice: bool(source["benign_choice"], `${what}.benign_choice`),
  };
}

function readGroup(value: unknown, what: string): ScenarioGroup {
  const groups: readonly string[] = [
    "recording_positive",
    "injected",
    "negative",
    "abstain",
    "diagnostic",
  ];
  const text = str(value, what);
  if (!groups.includes(text)) throw new TypeError(`${what} is not a scenario group: ${text}`);
  return text as ScenarioGroup;
}

function readSplit(value: unknown, what: string): Split | undefined {
  if (value === undefined) return undefined;
  const text = str(value, what);
  if (text !== "dev" && text !== "test") throw new TypeError(`${what} is not a split: ${text}`);
  return text;
}

function readExpectation(value: unknown, what: string): ScenarioExpectation {
  const source = record(value, what);
  const tickets = str(source["tickets"], `${what}.tickets`);
  if (tickets !== "at_least_one" && tickets !== "none") {
    throw new TypeError(`${what}.tickets is not an expectation: ${tickets}`);
  }
  const fault = str(source["fault"], `${what}.fault`);
  const faults: readonly string[] = ["accepted", "injected", "benign_or_none", "any"];
  if (!faults.includes(fault)) throw new TypeError(`${what}.fault is unknown: ${fault}`);
  const passLevel = str(source["pass_level"], `${what}.pass_level`);
  if (passLevel !== "detection" && passLevel !== "diagnosis") {
    throw new TypeError(`${what}.pass_level is unknown: ${passLevel}`);
  }
  return {
    tickets,
    fault: fault as ScenarioExpectation["fault"],
    maxFalseTickets: num(source["max_false_tickets"], `${what}.max_false_tickets`),
    passLevel,
    ...(source["within_min"] === undefined
      ? {}
      : { withinMin: num(source["within_min"], `${what}.within_min`) }),
  };
}

function readBinding(value: unknown, what: string): ScenarioBinding {
  const source = record(value, what);
  const split = readSplit(source["split"], `${what}.split`);
  return {
    id: str(source["id"], `${what}.id`),
    group: readGroup(source["group"], `${what}.group`),
    ...(split === undefined ? {} : { split }),
    ...(source["positive"] === undefined
      ? {}
      : { positive: bool(source["positive"], `${what}.positive`) }),
    replay: readInterval(source["replay"], `${what}.replay`),
    warmupMin: num(source["warmup_min"], `${what}.warmup_min`),
    windows: array(source["windows"], `${what}.windows`).map((entry, index) =>
      readWindow(entry, `${what}.windows[${index}]`),
    ),
    excluded: array(source["excluded"], `${what}.excluded`).map((entry, index) =>
      readExcluded(entry, `${what}.excluded[${index}]`),
    ),
    benignFaultIds: new Set(strings(source["benign_fault_ids"], `${what}.benign_fault_ids`)),
    expect: readExpectation(source["expect"], `${what}.expect`),
    ...(source["gaps"] === undefined
      ? {}
      : {
          gaps: array(source["gaps"], `${what}.gaps`).map((entry, index) =>
            readInterval(entry, `${what}.gaps[${index}]`),
          ),
        }),
    ...(source["frozen"] === undefined
      ? {}
      : {
          frozen: array(source["frozen"], `${what}.frozen`).map((entry, index) =>
            readInterval(entry, `${what}.frozen[${index}]`),
          ),
        }),
  };
}

/** Reads one hand-made run from `fixtures/metrics/`. */
export function readFixture(name: string): MetricsFixture {
  const source = readJson(`${name}.json`);
  const prices = record(source["prices"], `${name}.prices`);
  return {
    id: str(source["id"], `${name}.id`),
    backend: str(source["backend"], `${name}.backend`),
    reviewMin: num(source["review_min"], `${name}.review_min`),
    nativeAlarmCodes: strings(source["native_alarm_codes"], `${name}.native_alarm_codes`),
    prices: {
      vonInputPerMtok: num(prices["von_input_per_mtok"], `${name}.prices.von_input_per_mtok`),
      llmInputPerMtok: num(prices["llm_input_per_mtok"], `${name}.prices.llm_input_per_mtok`),
      llmOutputPerMtok: num(prices["llm_output_per_mtok"], `${name}.prices.llm_output_per_mtok`),
      asOf: str(prices["as_of"], `${name}.prices.as_of`),
    },
    binding: readBinding(source["binding"], `${name}.binding`),
    tickets: array(source["tickets"], `${name}.tickets`).map((entry, index) =>
      readTicket(entry, `${name}.tickets[${index}]`),
    ),
    decisions: array(source["decisions"], `${name}.decisions`).map((entry, index) =>
      readDecision(entry, `${name}.decisions[${index}]`),
    ),
    alarms: array(source["alarms"], `${name}.alarms`).map((entry, index) => {
      const alarm = record(entry, `${name}.alarms[${index}]`);
      return {
        code: str(alarm["code"], `${name}.alarms[${index}].code`),
        simTs: date(alarm["sim_ts"], `${name}.alarms[${index}].sim_ts`),
      };
    }),
    suspects:
      source["suspects"] === undefined
        ? []
        : array(source["suspects"], `${name}.suspects`).map((entry, index) => {
            const event = record(entry, `${name}.suspects[${index}]`);
            return {
              eventId: str(event["event_id"], `${name}.suspects[${index}].event_id`),
              simTs: date(event["sim_ts"], `${name}.suspects[${index}].sim_ts`),
              symptomKey: str(event["symptom_key"], `${name}.suspects[${index}].symptom_key`),
            };
          }),
  };
}

function readEpisode(value: unknown, what: string): SweepEpisode {
  const source = record(value, what);
  return {
    episodeId: str(source["episode_id"], `${what}.episode_id`),
    decisions: array(source["decisions"], `${what}.decisions`).map((entry, index) =>
      readDecision(entry, `${what}.decisions[${index}]`),
    ),
  };
}

/** Reads the sweep fixture: a stored run, the tickets it opened and a grid. */
export function readSweepFixture(name: string): SweepFixture {
  const source = readJson(`${name}.json`);
  const run = record(source["run"], `${name}.run`);
  const thresholds = record(run["thresholds"], `${name}.run.thresholds`);
  const split = readSplit(run["split"], `${name}.run.split`);

  return {
    id: str(source["id"], `${name}.id`),
    run: {
      ...(split === undefined ? {} : { split }),
      thresholds: {
        ticketMin: num(thresholds["ticket_min"], `${name}.run.thresholds.ticket_min`),
        reviewMin: num(thresholds["review_min"], `${name}.run.thresholds.review_min`),
      },
      windows: array(run["windows"], `${name}.run.windows`).map((entry, index) =>
        readWindow(entry, `${name}.run.windows[${index}]`),
      ),
      excluded: array(run["excluded"], `${name}.run.excluded`).map((entry, index) =>
        readExcluded(entry, `${name}.run.excluded[${index}]`),
      ),
      benignFaultIds: new Set(strings(run["benign_fault_ids"], `${name}.run.benign_fault_ids`)),
      episodes: array(run["episodes"], `${name}.run.episodes`).map((entry, index) =>
        readEpisode(entry, `${name}.run.episodes[${index}]`),
      ),
      coveredMachineDays: num(run["covered_machine_days"], `${name}.run.covered_machine_days`),
      negativeMachineDays: num(run["negative_machine_days"], `${name}.run.negative_machine_days`),
    },
    runTickets: array(source["run_tickets"], `${name}.run_tickets`).map((entry, index) =>
      readTicket(entry, `${name}.run_tickets[${index}]`),
    ),
    grid: array(source["grid"], `${name}.grid`).map((entry, index) => {
      const pair = array(entry, `${name}.grid[${index}]`);
      return [
        num(pair[0], `${name}.grid[${index}][0]`),
        num(pair[1], `${name}.grid[${index}][1]`),
      ] as ThresholdPair;
    }),
  };
}

/** Reads a `<name>.expected.json` document as plain JSON; the tests read it field by field. */
export function readExpected(name: string): Record<string, unknown> {
  return readJson(`${name}.expected.json`);
}

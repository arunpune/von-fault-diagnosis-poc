// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Stack mode and the ingested catalog against a real, migrated Postgres (E5).
//
// `startPostgres()` of `@fdp/db-migrate/testing` brings up the pinned
// pgvector image with this repository's roles and every migration. As the
// admin role the test then writes what a short stack run would leave behind —
// the CI smoke's shape: a morning of 3 February with an oil-cooler injection,
// a jump to the F3 preset and the morning of 5 June after it — two suspect
// events, their episodes, three decisions with candidates, two tickets (one
// correct inside the injection window, one false outside every window), two
// controller alarms and two cost-ledger rows, and a small ingested catalog.
//
// `score-stack` then reads it as role `eval` and its metrics must equal
// `scoreScenario` on the same records written by hand; the ingested catalog
// must come back as the reference source would give it; and the eval role must
// be unable to write ground truth — the belt and braces of the database's own
// isolation test. A row count of every table before and after proves the scorer
// wrote nothing.
//
// It skips when no Docker daemon answers, and fails instead under
// FDP_REQUIRE_DOCKER=1, which CI sets.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPostgres } from "@fdp/db-migrate/testing";
import type { PgTestStack } from "@fdp/db-migrate/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadIngestedCatalog, withReadOnlyTransaction } from "../../src/catalog/ingested.ts";
import { loadReferenceCatalog } from "../../src/catalog/reference.ts";
import type { CatalogEntry } from "../../src/catalog/types.ts";
import { executeScoreStack } from "../../src/commands/score-stack.ts";
import { loadConfig } from "../../src/config.ts";
import type { Logger } from "../../src/log.ts";
import { scoreScenario } from "../../src/metrics/index.ts";
import type {
  AlarmActivation,
  DecisionRecord,
  ScenarioBinding,
  ScoringWindow,
  SuspectRecord,
  TicketRecord,
} from "../../src/metrics/index.ts";
import { defaultAlarmRegistry } from "../../src/replay/index.ts";
import { validateReport } from "../../src/report/json.ts";
import type { RunReport } from "../../src/report/types.ts";
import { defaultNativeAlarmCodes, executeRun, toBinding } from "../../src/runner/run.ts";
import { bindScenario, loadAll } from "../../src/scenario/index.ts";
import { sliceIsCut } from "../../src/slices.ts";
import { STACK_SCENARIO_ID } from "../../src/stack/score.ts";
import { dockerIsAvailable } from "../helpers/sim-stack.ts";

/** PostgreSQL's SQLSTATEs the assertions name. */
const INSUFFICIENT_PRIVILEGE = "42501";
const READ_ONLY_TRANSACTION = "25006";

const UNIT = "cau-7";
const PROVENANCE = {
  git_sha: null,
  node: process.version,
  backend_version: "test",
  ground_truth: {
    package_version: "test",
    failures_sha256: "c".repeat(64),
    injections_sha256: null,
  },
};

const docker = await dockerIsAvailable();
const dockerRequired = process.env["FDP_REQUIRE_DOCKER"] === "1";

const QUIET: Logger = {
  level: "warn",
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-eval-stack-"));
  directories.push(directory);
  return directory;
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The SQLSTATE a statement fails with, or `undefined` when it succeeds. */
async function sqlstateOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function utc(text: string): Date {
  return new Date(text);
}

// --- The seeded stack run --------------------------------------------------------------

const EVENT_1 = "11111111-0000-4000-8000-000000000001";
const EVENT_2 = "11111111-0000-4000-8000-000000000002";
const EPISODE_1 = "22222222-0000-4000-8000-000000000001";
const EPISODE_2 = "22222222-0000-4000-8000-000000000002";
const DECISION_1 = "33333333-0000-4000-8000-000000000001";
const DECISION_2 = "33333333-0000-4000-8000-000000000002";
const DECISION_3 = "33333333-0000-4000-8000-000000000003";
const TICKET_1 = "44444444-0000-4000-8000-000000000001";
const TICKET_2 = "44444444-0000-4000-8000-000000000002";

const INJECTION_START = "2020-02-03T02:00:00.000Z";

/** One minute row per replayed minute: 3 February 00:00–06:00 and 5 June 06:00–14:00. */
const TELEMETRY_SQL = `
  INSERT INTO app.telemetry_agg_1m (unit_id, minute_sim_ts, signal_id, n, min, max, avg, last)
  SELECT $1, m, s.signal_id, s.n, 8, 9, 8.5, 8.6
    FROM (VALUES ('2020-02-03T00:00Z'::timestamptz, '2020-02-03T05:59Z'::timestamptz),
                 ('2020-06-05T06:00Z'::timestamptz, '2020-06-05T13:59Z'::timestamptz)) AS r(first, last)
   CROSS JOIN LATERAL generate_series(r.first, r.last, interval '1 minute') AS m
   CROSS JOIN (VALUES ('tp2', 6), ('motor_current', 5)) AS s(signal_id, n)`;

const GROUND_TRUTH_SQL = [
  `INSERT INTO gt.injections (unit_id, instance_id, injection_id, fault_id, event, sim_ts, wall_ts,
       params, ends_sim_ts, reason)
   VALUES ($1, 'inj-a1-000001', 'oil_cooler_fouling', 'oil_cooler_fouled', 'start',
           '${INJECTION_START}', now(), '{"magnitude": 1}', '2020-02-03T12:00Z', NULL),
          ($1, 'inj-a1-000001', 'oil_cooler_fouling', 'oil_cooler_fouled', 'stop',
           '2020-02-03T05:00Z', now(), '{}', NULL, 'cleared')`,
  `INSERT INTO gt.markers (unit_id, kind, preset_id, sim_ts_from, sim_ts_to, wall_ts)
   VALUES ($1, 'jump', 'f3_air_leak_jun05', '2020-02-03T06:00Z', '2020-06-05T06:00Z', now())`,
];

const DIAGNOSIS_SQL = [
  `INSERT INTO app.suspect_events (event_id, unit_id, sim_ts, wall_ts, episode_id, symptom_key,
       rule_ids, machine_mode, evidence, observations, window_from_sim_ts, window_to_sim_ts, payload)
   VALUES ('${EVENT_1}', $1, '2020-02-03T03:00Z', now(), '${EPISODE_1}', 'oil_temperature_rising',
           '{oil_temperature_rising}', 'loaded', '[]', '[]', '2020-02-03T02:55Z', '2020-02-03T03:00Z', '{}'),
          ('${EVENT_2}', $1, '2020-06-05T07:00Z', now(), '${EPISODE_2}', 'purge_pressure_high',
           '{purge_pressure_high}', 'loaded', '[]', '[]', '2020-06-05T06:55Z', '2020-06-05T07:00Z', '{}')`,
  `INSERT INTO app.episodes (episode_id, unit_id, symptom_key, symptom_keys, status, opened_sim_ts,
       last_event_sim_ts, last_decision_sim_ts, closed_sim_ts, close_reason, first_event_id,
       ticket_id, event_count, decision_count)
   VALUES ('${EPISODE_1}', $1, 'oil_temperature_rising', '{oil_temperature_rising}', 'closed',
           '2020-02-03T03:00Z', '2020-02-03T03:30Z', '2020-02-03T03:30Z', '2020-02-03T05:30Z',
           'silence', '${EVENT_1}', '${TICKET_1}', 2, 2),
          ('${EPISODE_2}', $1, 'purge_pressure_high', '{purge_pressure_high}', 'open',
           '2020-06-05T07:00Z', '2020-06-05T07:00Z', '2020-06-05T07:00Z', NULL, NULL,
           '${EVENT_2}', '${TICKET_2}', 1, 1)`,
  `INSERT INTO app.decisions (decision_id, episode_id, event_id, unit_id, sim_ts, wall_ts, backend,
       model, choice, confidence, probabilities, severity_level, severity_score, severity_confidence,
       gate_outcome, abstained, state, state_digest, input_tokens, output_tokens, message)
   SELECT d.decision_id::uuid, d.episode_id::uuid, d.event_id::uuid, $1, d.sim_ts::timestamptz, now(),
          'von', 'von-1.13.0', d.choice, d.confidence::real, '{}', 'medium', 0.5, 0.8, d.gate,
          false, '{}', repeat('d', 64), 1480, 0,
          '{"gate": {"ticket_min_confidence": 0.85, "review_min_confidence": 0.6}}'
     FROM (VALUES ('${DECISION_1}', '${EPISODE_1}', '${EVENT_1}', '2020-02-03T03:00Z',
                   'oil_cooler_fouled', 0.9, 'ticket'),
                  ('${DECISION_2}', '${EPISODE_1}', '${EVENT_1}', '2020-02-03T03:30Z',
                   'oil_cooler_fouled', 0.7, 'review'),
                  ('${DECISION_3}', '${EPISODE_2}', '${EVENT_2}', '2020-06-05T07:00Z',
                   'airend_bearing_wear', 0.65, 'review'))
          AS d(decision_id, episode_id, event_id, sim_ts, choice, confidence, gate)`,
  `INSERT INTO app.decision_candidates (decision_id, rank, fault_id, condition_id, name,
       probability, benign, manual_ref)
   VALUES ('${DECISION_1}', 1, 'oil_cooler_fouled', 'oil_temperature_high', 'Oil cooler fouled', 0.9, false, '{}'),
          ('${DECISION_1}', 2, 'high_ambient_temperature', 'oil_temperature_high', 'Hot room', 0.1, true, '{}'),
          ('${DECISION_2}', 1, 'oil_cooler_fouled', 'oil_temperature_high', 'Oil cooler fouled', 0.7, false, '{}'),
          ('${DECISION_3}', 1, 'airend_bearing_wear', 'dryer_purge_high', 'Airend bearing wear', 0.65, false, '{}')`,
  `INSERT INTO app.tickets (ticket_id, episode_id, unit_id, status, fault_id, condition_id, title,
       cause, remedy, manual_ref, confidence, severity_level, backend, model, latest_decision_id,
       opened_sim_ts, updated_sim_ts, resolved_sim_ts, close_reason, update_count)
   VALUES ('${TICKET_1}', '${EPISODE_1}', $1, 'resolved', 'oil_cooler_fouled', 'oil_temperature_high',
           'Oil cooler fouled — Oil temperature high', 'Dust on the cooler.', 'Clean it.', '{}', 0.7,
           'medium', 'von', 'von-1.13.0', '${DECISION_2}', '2020-02-03T03:00Z', '2020-02-03T03:30Z',
           '2020-02-03T05:30Z', 'silence', 1),
          ('${TICKET_2}', '${EPISODE_2}', $1, 'review', 'airend_bearing_wear', 'dryer_purge_high',
           'Airend bearing wear — Purge pressure high', 'A worn bearing.', 'Replace it.', '{}', 0.65,
           'medium', 'von', 'von-1.13.0', '${DECISION_3}', '2020-06-05T07:00Z', '2020-06-05T07:00Z',
           NULL, NULL, 0)`,
  `INSERT INTO app.native_alarms (unit_id, code, state, sim_ts)
   VALUES ($1, 'W102', 'raised', '2020-02-03T04:00Z'), ($1, 'W103', 'raised', '2020-06-05T10:30Z')`,
  `INSERT INTO app.cost_ledger (decision_id, backend, model, input_tokens, output_tokens,
       price_input_per_mtok, price_output_per_mtok, prices_as_of, sim_ts)
   VALUES ('${DECISION_1}', 'von', 'von-1.13.0', 1480, 0, 0.042, 0, '2026-09-19', '2020-02-03T03:00Z'),
          ('${DECISION_2}', 'von', 'von-1.13.0', 1480, 0, 0.042, 0, '2026-09-19', '2020-02-03T03:30Z')`,
];

// --- The seeded catalog -----------------------------------------------------------------

/** The two conditions the seeded catalog declares, as init stores them. */
const CONDITIONS = [
  {
    condition_id: "oil_temperature_high",
    title: "Oil temperature high",
    symptom: "The oil runs hotter than usual in every state.",
    symptoms: ["The cooler outlet feels warm.", "The oil runs hotter than usual in every state."],
  },
  {
    condition_id: "low_line_pressure",
    title: "Line pressure below setpoint",
    symptom: "Consumers lose pressure although the unit is running.",
    symptoms: [],
  },
];

/** The reference catalog's entries the seeded document carries, one per condition. */
const SEEDED_CAUSES: readonly { readonly faultId: string; readonly conditionId: string }[] = [
  { faultId: "oil_cooler_fouled", conditionId: "oil_temperature_high" },
  { faultId: "downstream_air_leak", conditionId: "low_line_pressure" },
];

async function insertDocument(
  client: pg.Client,
  name: string,
  status: "succeeded" | "failed",
  finished: string,
): Promise<number> {
  const document = await client.query<{ id: string }>(
    `INSERT INTO app.manual_documents (name, path, variant, sha256, bytes)
     VALUES ($1, $2, 'realistic', $3, 1) RETURNING id`,
    [name, `/data/manual/${name}`, (status === "succeeded" ? "b" : "e").repeat(64)],
  );
  const id = Number(document.rows[0]?.id);
  await client.query(
    `INSERT INTO app.ingest_runs (document_id, started_wall_ts, finished_wall_ts, status,
         embedding_model_id, embedding_revision, embedding_dimension, catalog_source)
     VALUES ($1, $2::timestamptz - interval '1 minute', $2, $3, 'model', 'rev', 384, 'tables')`,
    [id, finished, status],
  );
  return id;
}

/** Writes one cause of the reference catalog into the normalised tables, as init would. */
async function insertCause(
  client: pg.Client,
  documentId: number,
  entry: CatalogEntry,
  conditionPk: number,
): Promise<void> {
  const cause = await client.query<{ id: string }>(
    `INSERT INTO app.catalog_causes (document_id, fault_id, name, summary, subsystem, benign, remedy,
         parts, maintenance, related_alarms, manual_section, manual_anchor, pages, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'tables') RETURNING id`,
    [
      documentId,
      entry.fault_id,
      entry.name,
      entry.summary,
      entry.subsystem,
      entry.benign,
      entry.remedy,
      entry.parts,
      entry.maintenance,
      entry.related_alarms,
      entry.manual_ref.section,
      entry.manual_ref.anchor ?? null,
      JSON.stringify(entry.pages ?? {}),
    ],
  );
  const causePk = Number(cause.rows[0]?.id);
  await client.query(
    `INSERT INTO app.catalog_condition_causes (condition_pk, cause_pk, ordinal, likelihood)
     VALUES ($1, $2, 0, 'common')`,
    [conditionPk, causePk],
  );
  for (const [ordinal, move] of entry.signal_moves.entries()) {
    await client.query(
      `INSERT INTO app.catalog_signal_moves (cause_pk, ordinal, signal_id, behaviour, direction,
           phase, onset, note, text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        causePk,
        ordinal,
        move.signal ?? null,
        move.behaviour ?? null,
        move.direction,
        move.phase ?? "any",
        move.onset ?? "sustained",
        move.note ?? null,
        move.text ?? null,
      ],
    );
  }
  for (const [ordinal, instruction] of entry.checks.entries()) {
    await client.query(
      "INSERT INTO app.catalog_checks (cause_pk, ordinal, instruction) VALUES ($1, $2, $3)",
      [causePk, ordinal, instruction],
    );
  }
}

async function seedCatalog(client: pg.Client): Promise<void> {
  const reference = new Map(loadReferenceCatalog().entries.map((entry) => [entry.fault_id, entry]));
  const active = await insertDocument(
    client,
    "cau-7-realistic.pdf",
    "succeeded",
    "2026-09-20T10:00Z",
  );
  // A later re-ingestion that failed: retrieval, and so the ingested source, keeps the first.
  await insertDocument(client, "cau-7-rebuilt.pdf", "failed", "2026-09-21T10:00Z");
  const conditionPks = new Map<string, number>();
  for (const condition of CONDITIONS) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO app.catalog_conditions (document_id, condition_id, title, symptom, symptoms, source)
       VALUES ($1, $2, $3, $4, $5, 'tables') RETURNING id`,
      [active, condition.condition_id, condition.title, condition.symptom, condition.symptoms],
    );
    conditionPks.set(condition.condition_id, Number(row.rows[0]?.id));
  }
  for (const { faultId, conditionId } of SEEDED_CAUSES) {
    const entry = reference.get(faultId);
    if (entry === undefined) throw new Error(`the reference catalog has no ${faultId}`);
    await insertCause(client, active, entry, conditionPks.get(conditionId) ?? 0);
  }
}

/** Every table of `app` and `gt` with its row count, for the "wrote nothing" assertion. */
async function rowCounts(url: string): Promise<Record<string, number>> {
  return await withClient(url, async (client) => {
    const tables = await client.query<{ name: string }>(
      `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
        WHERE table_schema IN ('app', 'gt') AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    const counts: Record<string, number> = {};
    for (const { name } of tables.rows) {
      const result = await client.query<{ count: string }>(`SELECT count(*) FROM ${name}`);
      counts[name] = Number(result.rows[0]?.count);
    }
    return counts;
  });
}

// --- The same run, written by hand ----------------------------------------------------------

const F3_WINDOW: ScoringWindow = {
  id: "F3",
  // The data onset, not the labelled 10:00 start: F3's credited span opens there.
  from: utc("2020-06-05T09:48:30.000Z"),
  to: utc("2020-06-05T14:00:00.000Z"),
  leadFrom: utc("2020-06-05T10:00:00.000Z"),
  accepted: ["dryer_purge_leak", "downstream_air_leak"],
  benign: false,
  onset: utc("2020-06-05T09:48:30.000Z"),
  onsetKnown: true,
  nativeLpsFirst: utc("2020-06-06T19:42:19.000Z"),
  headline: true,
};

const INJECTION_WINDOW: ScoringWindow = {
  id: `oil_cooler_fouling@${INJECTION_START}`,
  from: utc(INJECTION_START),
  to: utc("2020-02-03T05:00:00.000Z"),
  leadFrom: utc(INJECTION_START),
  accepted: ["oil_cooler_fouled"],
  benign: false,
  onset: utc(INJECTION_START),
  onsetKnown: true,
  headline: false,
};

const EXPECTED_TICKETS: readonly TicketRecord[] = [
  {
    ticketId: TICKET_1,
    episodeId: EPISODE_1,
    openedSimTs: utc("2020-02-03T03:00:00.000Z"),
    faultAtOpen: "oil_cooler_fouled",
    faultLatest: "oil_cooler_fouled",
    maxLevel: "ticket",
    closedSimTs: utc("2020-02-03T05:30:00.000Z"),
  },
  {
    ticketId: TICKET_2,
    episodeId: EPISODE_2,
    openedSimTs: utc("2020-06-05T07:00:00.000Z"),
    faultAtOpen: "airend_bearing_wear",
    faultLatest: "airend_bearing_wear",
    maxLevel: "review",
  },
];

function expectedDecision(
  decisionId: string,
  episodeId: string,
  simTs: string,
  choice: string,
  confidence: number,
  gate: DecisionRecord["gate"],
): DecisionRecord {
  return {
    decisionId,
    episodeId,
    simTs: utc(simTs),
    choice,
    confidence,
    gate,
    abstained: false,
    usage: { input_tokens: 1480, output_tokens: 0 },
    backend: "von",
    benignChoice: false,
  };
}

const EXPECTED_DECISIONS: readonly DecisionRecord[] = [
  expectedDecision(
    DECISION_1,
    EPISODE_1,
    "2020-02-03T03:00:00.000Z",
    "oil_cooler_fouled",
    0.9,
    "ticket",
  ),
  expectedDecision(
    DECISION_2,
    EPISODE_1,
    "2020-02-03T03:30:00.000Z",
    "oil_cooler_fouled",
    0.7,
    "review",
  ),
  expectedDecision(
    DECISION_3,
    EPISODE_2,
    "2020-06-05T07:00:00.000Z",
    "airend_bearing_wear",
    0.65,
    "review",
  ),
];

const EXPECTED_ALARMS: readonly AlarmActivation[] = [
  { code: "W102", simTs: utc("2020-02-03T04:00:00.000Z") },
  { code: "W103", simTs: utc("2020-06-05T10:30:00.000Z") },
];

/** The two suspect events seeded above, which detection level is scored on. */
const EXPECTED_SUSPECTS: readonly SuspectRecord[] = [
  {
    eventId: EVENT_1,
    simTs: utc("2020-02-03T03:00:00.000Z"),
    symptomKey: "oil_temperature_rising",
  },
  {
    eventId: EVENT_2,
    simTs: utc("2020-06-05T07:00:00.000Z"),
    symptomKey: "purge_pressure_high",
  },
];

/**
 * The binding the seeded run stands for: the replayed range, the hole of the jump, the F3 and
 * injection windows written above, and the failure table's excluded windows over the range as
 * the scenario binder resolves them for any scenario.
 */
function expectedBinding(): ScenarioBinding {
  const replay = { from: utc("2020-02-03T00:00:00.000Z"), to: utc("2020-06-05T14:00:00.000Z") };
  const template = loadAll().find((scenario) => scenario.id === "metropt3_full");
  if (template === undefined) throw new Error("no committed metropt3_full scenario");
  const bound = bindScenario(
    {
      ...template,
      replay: { from: replay.from.toISOString(), to: replay.to.toISOString() },
      ground_truth: { kind: "negative" },
    },
    { profile: "dev" },
  );
  return {
    id: STACK_SCENARIO_ID,
    group: "recording_positive",
    split: "dev",
    positive: true,
    replay,
    warmupMin: 0,
    windows: [F3_WINDOW, INJECTION_WINDOW],
    excluded: toBinding(bound).excluded,
    benignFaultIds: bound.benignFaultIds,
    expect: {
      tickets: "at_least_one",
      fault: "accepted",
      maxFalseTickets: 0,
      passLevel: "detection",
    },
    gaps: [{ from: utc("2020-02-03T06:00:00.000Z"), to: utc("2020-06-05T06:00:00.000Z") }],
  };
}

// --- The suite ------------------------------------------------------------------------------

describe.skipIf(!docker)("stack mode against a migrated Postgres", () => {
  let stack: PgTestStack;

  beforeAll(async () => {
    stack = await startPostgres();
    await withClient(stack.adminUrl, async (client) => {
      await client.query(TELEMETRY_SQL, [UNIT]);
      for (const statement of GROUND_TRUTH_SQL) await client.query(statement, [UNIT]);
      for (const statement of DIAGNOSIS_SQL) {
        await client.query(statement, statement.includes("$1") ? [UNIT] : []);
      }
      await seedCatalog(client);
      // A table the eval role has no grant on, as the database's isolation test probes app._probe.
      await client.query("CREATE TABLE app._stack_probe (id integer, note text)");
      await client.query("REVOKE ALL ON app._stack_probe FROM eval");
    });
  });

  afterAll(async () => {
    await stack?.stop();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  it("scores the stack as role eval with the in-process scorer's metrics, writing nothing", async () => {
    const before = await rowCounts(stack.adminUrl);
    const out = temporaryDirectory();
    const printed: string[] = [];
    const { score, files } = await executeScoreStack(
      { dbUrl: stack.urlFor("eval"), range: {}, outDir: out },
      { EVAL_VON_MODE: "mock" },
      {
        now: () => utc("2026-09-23T12:00:00.000Z"),
        provenance: () => PROVENANCE,
        stdout: { write: (chunk: string) => printed.push(chunk) },
        log: QUIET,
      },
    );
    expect(await rowCounts(stack.adminUrl)).toEqual(before);

    expect(score.backends.map((entry) => entry.backend)).toEqual(["von"]);
    const pair = score.backends[0];
    if (pair === undefined) throw new Error("no scored backend");

    const binding = expectedBinding();
    const prices = { ...loadConfig([], {}).prices, vonInputPerMtok: 0.042, asOf: "2026-09-19" };
    const expected = scoreScenario(
      binding,
      EXPECTED_TICKETS,
      EXPECTED_DECISIONS,
      EXPECTED_ALARMS,
      prices,
      {
        backend: "von",
        nativeAlarmCodes: defaultNativeAlarmCodes(defaultAlarmRegistry()),
        reviewMin: 0.6,
        suspects: EXPECTED_SUSPECTS,
      },
    );

    expect(pair.result.binding).toEqual(binding);
    expect(pair.result.summary.suspectEvents).toEqual(EXPECTED_SUSPECTS);
    expect(pair.result.summary.tickets).toEqual(EXPECTED_TICKETS);
    expect(pair.result.summary.decisions).toEqual(EXPECTED_DECISIONS);
    expect(pair.result.run.alarms).toEqual(EXPECTED_ALARMS);
    expect(pair.result.metrics).toEqual(expected);

    // The figures E5 reads: the injected fault detected inside its window, the false ticket, the
    // lead time against the controller's own W102, and the cost at the ledger's price.
    expect(expected.match.ticket.tp.map((match) => match.window.id)).toEqual([INJECTION_WINDOW.id]);
    expect(expected.match.review.fp.map((ticket) => ticket.ticketId)).toEqual([TICKET_2]);
    expect(expected.leadTimes[0]).toMatchObject({ nativeCode: "W102", leadMinutes: 60 });
    expect(expected.cost.usd).toBeCloseTo((3 * 1480 * 0.042) / 1e6, 12);
    expect(pair.result.summary.suspects).toBe(2);
    expect(pair.result.run.stats.samples).toBe((360 + 480) * 6);

    const report: RunReport = validateReport(JSON.parse(readFileSync(files.runJson, "utf8")));
    expect(report.run).toMatchObject({ mode: "stack", profile: "stack" });
    expect(report.run.id).toBe("20260923-120000-stack");
    expect(report.run.catalog).toMatchObject({ source: "ingested", name: "ingested", entries: 2 });
    expect(report.run.thresholds).toMatchObject({ ticket_min: 0.85, review_min: 0.6 });
    expect(readFileSync(files.reportMd, "utf8")).toContain("Stack run: scored from the database");

    const document = JSON.parse(readFileSync(files.stackJson, "utf8")) as {
      markers: { kind: string; preset_id: string; failure_id: string }[];
      windows: { id: string; kind: string; reached_by_jump: boolean }[];
      thresholds: { source: string };
    };
    expect(document.markers).toEqual([
      expect.objectContaining({ kind: "jump", preset_id: "f3_air_leak_jun05", failure_id: "F3" }),
    ]);
    expect(document.windows).toEqual([
      expect.objectContaining({ id: "F3", kind: "failure", reached_by_jump: true }),
      expect.objectContaining({
        id: INJECTION_WINDOW.id,
        kind: "injection",
        reached_by_jump: false,
      }),
    ]);
    expect(document.thresholds.source).toBe("decisions");
    expect(printed.join("")).toContain("stack window: failure F3");
    expect(printed.join("")).not.toContain(":eval@");
  });

  it("limits every read to --from and --to", async () => {
    const { score } = await executeScoreStack(
      {
        dbUrl: stack.urlFor("eval"),
        range: { from: utc("2020-06-05T00:00:00.000Z") },
        outDir: temporaryDirectory(),
      },
      {},
      { provenance: () => PROVENANCE, stdout: { write: () => true }, log: QUIET },
    );
    expect(score.coverage.segments).toHaveLength(1);
    expect(score.windows.map((entry) => entry.window.id)).toEqual(["F3"]);
    expect(score.backends[0]?.result.summary.tickets.map((ticket) => ticket.ticketId)).toEqual([
      TICKET_2,
    ]);
  });

  it("reads the ingested catalog of the active document, conditions with their symptoms", async () => {
    const catalog = await loadIngestedCatalog(stack.urlFor("eval"), { log: QUIET });
    expect(catalog.document).toEqual({ name: "cau-7-realistic.pdf", sha256: "b".repeat(64) });
    expect(catalog.invalid).toEqual([]);
    expect(catalog.entries.map((entry) => entry.fault_id)).toEqual([
      "downstream_air_leak",
      "oil_cooler_fouled",
    ]);
    const reference = new Map(
      loadReferenceCatalog().entries.map((entry) => [entry.fault_id, entry]),
    );
    for (const entry of catalog.entries) {
      // The table fills a move's phase and onset with its column defaults, which the view writes.
      const moves = reference.get(entry.fault_id)?.signal_moves.map((move) => ({
        ...move,
        phase: move.phase ?? "any",
        onset: move.onset ?? "sustained",
      }));
      expect(entry.signal_moves).toEqual(moves);
      expect(entry.checks).toEqual(reference.get(entry.fault_id)?.checks);
    }
    expect(catalog.conditions).toEqual([
      {
        condition_id: "low_line_pressure",
        title: "Line pressure below setpoint",
        symptoms: ["Consumers lose pressure although the unit is running."],
      },
      {
        condition_id: "oil_temperature_high",
        title: "Oil temperature high",
        symptoms: [
          "The oil runs hotter than usual in every state.",
          "The cooler outlet feels warm.",
        ],
      },
    ]);
    expect((await loadIngestedCatalog(stack.urlFor("eval"), { log: QUIET })).sha256).toBe(
      catalog.sha256,
    );
  });

  it.skipIf(!sliceIsCut("baseline-feb03"))(
    "runs fdp-eval run --catalog ingested --db-url and names the source in the report",
    async () => {
      const out = temporaryDirectory();
      const cfg = loadConfig(
        [
          "--profile",
          "smoke",
          "--backends",
          "rules",
          "--scenario",
          "baseline_feb03_normal",
          "--catalog",
          "ingested",
          "--db-url",
          stack.urlFor("eval"),
          "--out",
          out,
        ],
        { EVAL_VON_MODE: "mock" },
      );
      const code = await executeRun(cfg, {
        log: QUIET,
        provenance: () => PROVENANCE,
        stdout: { write: () => true },
      });
      expect(code).toBe(0);
      const report = validateReport(JSON.parse(readFileSync(join(out, "latest.json"), "utf8")));
      expect(report.run.catalog).toMatchObject({
        source: "ingested",
        name: "ingested",
        entries: 2,
      });
      expect(JSON.stringify(report)).not.toContain(":eval@");
    },
  );

  it("keeps the eval role out of every write to ground truth", async () => {
    const states = await withClient(stack.urlFor("eval"), async (client) => ({
      injections: await sqlstateOf(() =>
        client.query(
          `INSERT INTO gt.injections (unit_id, instance_id, injection_id, fault_id, event, sim_ts, wall_ts)
           VALUES ('cau-7', 'inj-zz-000009', 'oil_cooler_fouling', 'oil_cooler_fouled', 'start', now(), now())`,
        ),
      ),
      markers: await sqlstateOf(() =>
        client.query(
          `INSERT INTO gt.markers (unit_id, kind, sim_ts_from, sim_ts_to, wall_ts)
           VALUES ('cau-7', 'reset', now(), now(), now())`,
        ),
      ),
      update: await sqlstateOf(() => client.query("UPDATE gt.injections SET reason = 'reset'")),
      delete: await sqlstateOf(() => client.query("DELETE FROM gt.markers")),
      unGranted: await sqlstateOf(() => client.query("SELECT count(*) FROM app._stack_probe")),
      reads: await sqlstateOf(() => client.query("SELECT count(*) FROM gt.v_injection_windows")),
    }));
    expect(states).toEqual({
      injections: INSUFFICIENT_PRIVILEGE,
      markers: INSUFFICIENT_PRIVILEGE,
      update: INSUFFICIENT_PRIVILEGE,
      delete: INSUFFICIENT_PRIVILEGE,
      unGranted: INSUFFICIENT_PRIVILEGE,
      reads: undefined,
    });
  });

  it("lets the eval role read every table stack mode reads, and no write inside the reader", async () => {
    const missing = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{ name: string }>(
        `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
          WHERE table_schema IN ('app', 'gt') AND table_name <> '_stack_probe'
            AND NOT has_table_privilege('eval', quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT')`,
      );
      return result.rows.map((row) => row.name);
    });
    expect(missing).toEqual([]);

    // The eval role may write `app` during in-process replays; the stack reader's transaction may not.
    const state = await sqlstateOf(() =>
      withReadOnlyTransaction(stack.urlFor("eval"), (db) =>
        db.query("INSERT INTO app.heartbeats (source, status) VALUES ('telemetry', 'ok')"),
      ),
    );
    expect(state).toBe(READ_ONLY_TRANSACTION);
  });
});

describe("stack mode's Docker requirement", () => {
  it("can run, or its absence is allowed", () => {
    expect(docker || !dockerRequired, "no Docker daemon answers and FDP_REQUIRE_DOCKER=1").toBe(
      true,
    );
    if (!docker) console.info("stack-score: skipped, no Docker daemon answers");
  });
});

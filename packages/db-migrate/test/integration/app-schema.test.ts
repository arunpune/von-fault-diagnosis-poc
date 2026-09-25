// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The diagnosis schema, asserted against a real server
// (docs/architecture.md#persistence).
//
// `isolation.test.ts` proves the two schemas cannot reach each other. This
// file proves the `app` side exists as the migrations write it and behaves as
// written: every table, column, index, view and function of 0003 to 0009; DML
// as `app_rw` on all of them; the constraints that carry a design decision
// rather than a type (`episodes_one_open`, the signal-move CHECK); the two
// derived values (`cost_usd`, `app.prune_telemetry_agg`); and
// `v_catalog_entries` reassembling the catalog-entry contract.
//
// Nothing is imported from the workspace: `@fdp/db-migrate` depends on `pg`
// alone, so the catalog entries are checked structurally here and validated
// against the JSON schema by init and the backend instead.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type PgTestStack, startPostgres } from "../../src/testing.ts";
import { sqlstateOf, withClient } from "./helpers.ts";

/** PostgreSQL SQLSTATEs the assertions below name by meaning. */
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "app-schema",
);

/** Applied in this order: each file references rows the previous one wrote. */
const FIXTURE_FILES = [
  "10_manual_chunks.sql",
  "20_catalog.sql",
  "30_telemetry.sql",
  "40_diagnosis.sql",
  "50_cost_system.sql",
] as const;

/** The embedding width of 0003, repeated here so a mismatch fails loudly. */
const EMBEDDING_DIMENSION = 384;

/**
 * Every app table with its columns in the order the migration declares them,
 * and a statement that changes one of its rows. The map is the test: a column
 * renamed in a migration, or a table nobody may write, turns it red.
 */
const APP_TABLES: Record<string, { columns: string[]; update: string }> = {
  // 0003_manual_chunks
  manual_documents: {
    columns: ["id", "name", "path", "variant", "sha256", "bytes", "pages", "ingested_at", "meta"],
    update: "UPDATE app.manual_documents SET pages = 121",
  },
  ingest_runs: {
    columns: [
      "id",
      "document_id",
      "started_wall_ts",
      "finished_wall_ts",
      "status",
      "embedding_model_id",
      "embedding_revision",
      "embedding_dimension",
      "catalog_source",
      "stats",
      "error",
    ],
    update: "UPDATE app.ingest_runs SET error = 'retried'",
  },
  chunks: {
    columns: [
      "id",
      "document_id",
      "ordinal",
      "section_ref",
      "section_title",
      "page_start",
      "page_end",
      "kind",
      "content",
      "tokens",
      "tsv",
      "embedding",
      // 0008_chunk_links, init's own additive migration.
      "fault_id",
      "alarm_code",
      "table_kind",
    ],
    update: "UPDATE app.chunks SET tokens = 99",
  },
  // 0004_catalog
  catalog_sections: {
    columns: [
      "id",
      "document_id",
      "section_ref",
      "title",
      "level",
      "parent_ref",
      "page_start",
      "page_end",
    ],
    update: "UPDATE app.catalog_sections SET level = 4",
  },
  catalog_conditions: {
    columns: [
      "id",
      "document_id",
      "condition_id",
      "title",
      "symptom",
      "symptoms",
      "alarm_codes",
      "signals",
      "manual_section",
      "page_start",
      "page_end",
      "source",
      "tsv",
    ],
    update: "UPDATE app.catalog_conditions SET symptom = 'restated'",
  },
  catalog_causes: {
    columns: [
      "id",
      "document_id",
      "fault_id",
      "name",
      "summary",
      "subsystem",
      "benign",
      "remedy",
      "parts",
      "maintenance",
      "related_alarms",
      "manual_section",
      "manual_anchor",
      "page",
      "page_start",
      "page_end",
      "pages",
      "source",
      "tsv",
    ],
    update: "UPDATE app.catalog_causes SET summary = 'restated'",
  },
  catalog_condition_causes: {
    columns: ["condition_pk", "cause_pk", "ordinal", "likelihood", "note"],
    update: "UPDATE app.catalog_condition_causes SET note = 'restated'",
  },
  catalog_checks: {
    columns: ["id", "cause_pk", "ordinal", "instruction", "expected"],
    update: "UPDATE app.catalog_checks SET expected = 'restated'",
  },
  catalog_remedies: {
    columns: ["id", "cause_pk", "ordinal", "action", "post_check"],
    update: "UPDATE app.catalog_remedies SET post_check = 'restated'",
  },
  catalog_signal_moves: {
    columns: [
      "id",
      "cause_pk",
      "ordinal",
      "signal_id",
      "behaviour",
      "direction",
      "phase",
      "onset",
      "note",
      "text",
    ],
    update: "UPDATE app.catalog_signal_moves SET onset = 'sudden'",
  },
  catalog_alarms: {
    columns: [
      "id",
      "document_id",
      "code",
      "type",
      "title",
      "display",
      "trigger_text",
      "signal_id",
      "direction",
      "threshold",
      "threshold_unit",
      "delay_s",
      "reset_rule",
      "bit",
      "manual_section",
    ],
    update: "UPDATE app.catalog_alarms SET display = 'RESTATED'",
  },
  catalog_signals: {
    columns: [
      "id",
      "document_id",
      "signal_id",
      "panel_label",
      "name",
      "description",
      "unit",
      "group",
      "kind",
      "subsystem",
      "metropt_column",
      "range_min",
      "range_max",
      "normal_bands",
      "manual_section",
    ],
    update: "UPDATE app.catalog_signals SET description = 'restated'",
  },
  // 0005_telemetry
  telemetry_agg_1m: {
    columns: [
      "unit_id",
      "minute_sim_ts",
      "signal_id",
      "n",
      "min",
      "max",
      "avg",
      "last",
      "duty",
      "discontinuity",
    ],
    update: "UPDATE app.telemetry_agg_1m SET last = 1.5",
  },
  native_alarms: {
    columns: ["id", "unit_id", "code", "state", "sim_ts", "wall_ts", "seq"],
    update: "UPDATE app.native_alarms SET seq = 9",
  },
  heartbeats: {
    columns: [
      "source",
      "status",
      "last_ok_wall_ts",
      "last_seen_wall_ts",
      "consecutive_errors",
      "detail",
    ],
    update: "UPDATE app.heartbeats SET status = 'ok', last_ok_wall_ts = now()",
  },
  // 0006_diagnosis
  suspect_events: {
    columns: [
      "id",
      "event_id",
      "unit_id",
      "sim_ts",
      "wall_ts",
      "episode_id",
      "symptom_key",
      "rule_ids",
      "machine_mode",
      "evidence",
      "observations",
      "active_alarms",
      "co_symptoms",
      "ambient",
      "window_from_sim_ts",
      "window_to_sim_ts",
      "payload",
    ],
    update: "UPDATE app.suspect_events SET ambient = 'hot'",
  },
  episodes: {
    columns: [
      "id",
      "episode_id",
      "unit_id",
      "symptom_key",
      "symptom_keys",
      "status",
      "merged_into",
      "opened_sim_ts",
      "last_event_sim_ts",
      "last_decision_sim_ts",
      "closed_sim_ts",
      "close_reason",
      "first_event_id",
      "ticket_id",
      "closed_by_technician",
      "event_count",
      "decision_count",
    ],
    update: "UPDATE app.episodes SET event_count = 2",
  },
  decisions: {
    columns: [
      "id",
      "decision_id",
      "episode_id",
      "event_id",
      "unit_id",
      "sim_ts",
      "wall_ts",
      "backend",
      "model",
      "status",
      "choice",
      "confidence",
      "probabilities",
      "support",
      "severity_level",
      "severity_score",
      "severity_probabilities",
      "severity_confidence",
      "gate_outcome",
      "abstained",
      "candidates",
      "state",
      "state_digest",
      "request",
      "response",
      "request_id",
      "rationale",
      "input_tokens",
      "output_tokens",
      "latency_ms",
      "error",
      "message",
    ],
    update: "UPDATE app.decisions SET rationale = 'restated'",
  },
  decision_candidates: {
    columns: [
      "decision_id",
      "rank",
      "fault_id",
      "condition_id",
      "name",
      "probability",
      "support",
      "benign",
      "manual_ref",
      "retrieval",
    ],
    update: "UPDATE app.decision_candidates SET support = 0.5",
  },
  tickets: {
    columns: [
      "id",
      "ticket_id",
      "episode_id",
      "unit_id",
      "status",
      "fault_id",
      "condition_id",
      "title",
      "cause",
      "remedy",
      "checks",
      "manual_ref",
      "evidence",
      "confidence",
      "probabilities",
      "severity_level",
      "backend",
      "model",
      "rationale",
      "latest_decision_id",
      "opened_sim_ts",
      "updated_sim_ts",
      "resolved_sim_ts",
      "close_reason",
      "opened_wall_ts",
      "updated_wall_ts",
      "resolved_wall_ts",
      "update_count",
    ],
    update: "UPDATE app.tickets SET update_count = update_count + 1",
  },
  ticket_closures: {
    columns: ["id", "ticket_id", "verdict", "note", "closed_by", "sim_ts", "wall_ts"],
    update: "UPDATE app.ticket_closures SET note = 'restated'",
  },
  // 0007_cost_system
  cost_ledger: {
    columns: [
      "id",
      "decision_id",
      "backend",
      "model",
      "input_tokens",
      "output_tokens",
      "price_input_per_mtok",
      "price_output_per_mtok",
      "prices_as_of",
      "cost_usd",
      "wall_ts",
      "sim_ts",
    ],
    update: "UPDATE app.cost_ledger SET sim_ts = now()",
  },
  system_alerts: {
    columns: [
      "id",
      "alert_id",
      "unit_id",
      "kind",
      "state",
      "raised_wall_ts",
      "cleared_wall_ts",
      "details",
    ],
    update: "UPDATE app.system_alerts SET details = '{\"silent_for_s\": 120}'::jsonb",
  },
};

/** Children first, so a DELETE never trips a foreign key. */
const DELETE_ORDER = [
  "cost_ledger",
  "ticket_closures",
  "tickets",
  "decision_candidates",
  "decisions",
  "episodes",
  "suspect_events",
  "system_alerts",
  "heartbeats",
  "native_alarms",
  "telemetry_agg_1m",
  "catalog_signal_moves",
  "catalog_remedies",
  "catalog_checks",
  "catalog_condition_causes",
  "catalog_causes",
  "catalog_conditions",
  "catalog_signals",
  "catalog_alarms",
  "catalog_sections",
  "chunks",
  "ingest_runs",
  "manual_documents",
] as const;

/** Every index the migrations name, with the table it belongs to. */
const APP_INDEXES: readonly (readonly [string, string])[] = [
  ["chunks", "chunks_tsv_gin"],
  ["chunks", "chunks_embedding_hnsw"],
  ["chunks", "chunks_section_trgm"],
  ["catalog_condition_causes", "catalog_condition_causes_cause"],
  ["telemetry_agg_1m", "telemetry_agg_1m_lookup"],
  ["native_alarms", "native_alarms_lookup"],
  ["episodes", "episodes_one_open"],
  ["suspect_events", "suspect_events_lookup"],
  ["decisions", "decisions_lookup"],
  ["decisions", "decisions_episode"],
];

/** The key set of the `catalog-entry` schema, sorted. */
const CATALOG_ENTRY_KEYS = [
  "benign",
  "checks",
  "conditions",
  "fault_id",
  "maintenance",
  "manual_ref",
  "name",
  "pages",
  "parts",
  "related_alarms",
  "remedy",
  "signal_moves",
  "signal_moves_text",
  "source",
  "subsystem",
  "summary",
].sort();

/** A deterministic probe vector of the declared width, as a pgvector literal. */
const PROBE_VECTOR = `[${Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (i % 10) + 1).join(",")}]`;

let stack: PgTestStack;

/** Run `use` inside a transaction that is always rolled back. */
async function inRolledBackTransaction<T>(
  url: string,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(url, async (client) => {
    await client.query("BEGIN");
    try {
      return await use(client);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

beforeAll(async () => {
  stack = await startPostgres();
  // The fixtures are written by `app_rw`, so loading them is itself the
  // INSERT half of "app_rw can DML every app table".
  await withClient(stack.urlFor("app_rw"), async (client) => {
    for (const file of FIXTURE_FILES) {
      await client.query(readFileSync(join(FIXTURES_DIR, file), "utf8"));
    }
  });
});

afterAll(async () => {
  await stack.stop();
});

describe("the migrations that build the diagnosis schema", () => {
  it("applied 0001 to 0009 on a fresh database", async () => {
    const rows = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{ version: number; name: string; sha256: string }>(
        "SELECT version, name, sha256 FROM public.schema_migrations ORDER BY version",
      );
      return result.rows;
    });
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows.map((row) => row.name)).toEqual([
      "extensions_schemas",
      "ground_truth",
      "manual_chunks",
      "catalog",
      "telemetry",
      "diagnosis",
      "cost_system",
      "chunk_links",
      "backend_episode_links",
    ]);
    for (const row of rows) expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("left exactly the expected tables in app, and no review queue", async () => {
    const names = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'app' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      );
      return result.rows.map((row) => row.table_name);
    });
    expect(names).toEqual(Object.keys(APP_TABLES).sort());
    expect(names).not.toContain("review_queue");
  });

  it("gave every table the columns its migration declares, in order", async () => {
    const actual = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'app'
          ORDER BY table_name, ordinal_position`,
      );
      const byTable: Record<string, string[]> = {};
      for (const row of result.rows) (byTable[row.table_name] ??= []).push(row.column_name);
      return byTable;
    });
    for (const [table, shape] of Object.entries(APP_TABLES)) {
      expect({ [table]: actual[table] }).toEqual({ [table]: shape.columns });
    }
  });

  it("created every index, view and function the migrations name", async () => {
    const { indexes, views, functions } = await withClient(stack.adminUrl, async (client) => {
      const indexRows = await client.query<{ tablename: string; indexname: string }>(
        "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'app'",
      );
      const viewRows = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.views WHERE table_schema = 'app' ORDER BY table_name",
      );
      const functionRows = await client.query<{ name: string; args: string; result: string }>(
        `SELECT p.proname AS name,
                pg_get_function_identity_arguments(p.oid) AS args,
                pg_get_function_result(p.oid) AS result
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' ORDER BY p.proname`,
      );
      return {
        indexes: indexRows.rows.map((row) => `${row.tablename}.${row.indexname}`),
        views: viewRows.rows.map((row) => row.table_name),
        functions: functionRows.rows,
      };
    });
    for (const [table, index] of APP_INDEXES) expect(indexes).toContain(`${table}.${index}`);
    expect(views).toEqual(["v_catalog_entries", "v_cost_totals"]);
    expect(functions).toEqual([
      {
        name: "prune_telemetry_agg",
        args: "retention_days integer, now_sim_ts timestamp with time zone",
        result: "bigint",
      },
      // 0004_catalog: the immutable wrapper the generated tsvector of
      // app.catalog_conditions needs, because array_to_string is only stable.
      { name: "text_array_to_string", args: "value text[], separator text", result: "text" },
    ]);
  });

  it("declared the chunk embedding at the width 0003 states", async () => {
    const { typmod, refused } = await withClient(stack.urlFor("app_rw"), async (client) => {
      const result = await client.query<{ format_type: string }>(
        `SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
          WHERE a.attrelid = 'app.chunks'::regclass AND a.attname = 'embedding'`,
      );
      return {
        typmod: result.rows[0]?.format_type,
        refused: await sqlstateOf(() =>
          client.query(`SELECT '[1,2,3]'::vector(${EMBEDDING_DIMENSION})`),
        ),
      };
    });
    expect(typmod).toBe(`vector(${EMBEDDING_DIMENSION})`);
    // A vector of the wrong width cannot reach the column at all.
    expect(refused).toBe("22000");
  });
});

describe("DML as app_rw", () => {
  it("wrote a row into every app table", async () => {
    const counts = await withClient(stack.urlFor("app_rw"), async (client) => {
      const entries: [string, number][] = [];
      for (const table of Object.keys(APP_TABLES)) {
        const result = await client.query<{ count: string }>(`SELECT count(*) FROM app.${table}`);
        entries.push([table, Number(result.rows[0]?.count)]);
      }
      return Object.fromEntries(entries) as Record<string, number>;
    });
    for (const table of Object.keys(APP_TABLES)) {
      expect({ [table]: counts[table]! > 0 }).toEqual({ [table]: true });
    }
    // 0005 seeds both heartbeat sources so nothing has to create them.
    expect(counts["heartbeats"]).toBe(2);
  });

  it("can INSERT into app.heartbeats, the one table 0005 fills itself", async () => {
    const seeded = await inRolledBackTransaction(stack.urlFor("app_rw"), async (client) => {
      await client.query("DELETE FROM app.heartbeats WHERE source = 'telemetry'");
      const inserted = await client.query(
        "INSERT INTO app.heartbeats (source, status, consecutive_errors) VALUES ('telemetry', 'silent', 3)",
      );
      const result = await client.query<{ status: string }>(
        "SELECT status FROM app.heartbeats WHERE source = 'telemetry'",
      );
      expect(inserted.rowCount).toBe(1);
      return result.rows[0]?.status;
    });
    expect(seeded).toBe("silent");
  });

  it("can UPDATE every app table", async () => {
    const updated = await inRolledBackTransaction(stack.urlFor("app_rw"), async (client) => {
      const entries: [string, number][] = [];
      for (const [table, shape] of Object.entries(APP_TABLES)) {
        const result = await client.query(shape.update);
        entries.push([table, result.rowCount ?? 0]);
      }
      return Object.fromEntries(entries) as Record<string, number>;
    });
    for (const table of Object.keys(APP_TABLES)) {
      expect({ [table]: updated[table]! > 0 }).toEqual({ [table]: true });
    }
  });

  it("can DELETE from every app table", async () => {
    const deleted = await inRolledBackTransaction(stack.urlFor("app_rw"), async (client) => {
      const entries: [string, number][] = [];
      for (const table of DELETE_ORDER) {
        const result = await client.query(`DELETE FROM app.${table}`);
        entries.push([table, result.rowCount ?? 0]);
      }
      return Object.fromEntries(entries) as Record<string, number>;
    });
    for (const table of DELETE_ORDER) {
      expect({ [table]: deleted[table]! > 0 }).toEqual({ [table]: true });
    }
  });
});

describe("the diagnosis schema as the other two roles", () => {
  it("refuses gt_rw the decisions table", async () => {
    const state = await withClient(stack.urlFor("gt_rw"), (client) =>
      sqlstateOf(() => client.query("SELECT count(*) FROM app.decisions")),
    );
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("lets eval write a decision, as it does during a replay", async () => {
    const written = await inRolledBackTransaction(stack.urlFor("eval"), async (client) => {
      const result = await client.query(
        `INSERT INTO app.decisions (decision_id, episode_id, event_id, unit_id, sim_ts, wall_ts,
            backend, model, choice, confidence, probabilities, severity_level, severity_score,
            severity_confidence, gate_outcome, state, state_digest, message)
         VALUES ('eeeeeeee-0000-4000-8000-000000000001',
                 'aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
                 'cau-7-01', '2020-02-09T10:10:00Z', now(), 'rules', 'rules-baseline',
                 'fau_fouled_oil_cooler', 0.51, '{"fau_fouled_oil_cooler": 0.51}'::jsonb,
                 'medium', 0.5, 0.6, 'log', '{}'::jsonb, repeat('d', 64), '{}'::jsonb)`,
      );
      return result.rowCount;
    });
    expect(written).toBe(1);
  });
});

describe("0006_diagnosis · episodes_one_open", () => {
  it("refuses a second open episode for the same unit and symptom", async () => {
    const state = await inRolledBackTransaction(stack.urlFor("app_rw"), (client) =>
      sqlstateOf(() =>
        client.query(
          `INSERT INTO app.episodes (episode_id, unit_id, symptom_key, status, opened_sim_ts,
              last_event_sim_ts, first_event_id)
           VALUES ('ffffffff-0000-4000-8000-000000000001', 'cau-7-01', 'oil_temperature_high',
                   'open', '2020-02-09T10:30:00Z', '2020-02-09T10:30:00Z',
                   '11111111-1111-4111-8111-111111111111')`,
        ),
      ),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
  });

  it("accepts one once the first episode is closed", async () => {
    const inserted = await inRolledBackTransaction(stack.urlFor("app_rw"), async (client) => {
      await client.query(
        `UPDATE app.episodes SET status = 'closed', closed_sim_ts = '2020-02-09T10:20:00Z',
                close_reason = 'silence'
          WHERE episode_id = 'aaaaaaaa-0000-4000-8000-000000000001'`,
      );
      const result = await client.query(
        `INSERT INTO app.episodes (episode_id, unit_id, symptom_key, status, opened_sim_ts,
            last_event_sim_ts, first_event_id)
         VALUES ('ffffffff-0000-4000-8000-000000000002', 'cau-7-01', 'oil_temperature_high',
                 'open', '2020-02-09T10:30:00Z', '2020-02-09T10:30:00Z',
                 '11111111-1111-4111-8111-111111111111')`,
      );
      return result.rowCount;
    });
    expect(inserted).toBe(1);
  });
});

describe("0004_catalog · the signal-move CHECK", () => {
  it("refuses a move that names both a signal and a behaviour, and one that names neither", async () => {
    const states = await inRolledBackTransaction(stack.urlFor("app_rw"), async (client) => {
      const insert = (signalId: string | null, behaviour: string | null) =>
        client.query(
          `INSERT INTO app.catalog_signal_moves (cause_pk, signal_id, behaviour, direction)
           SELECT id, $1, $2, 'rises' FROM app.catalog_causes WHERE fault_id = 'fau_fouled_oil_cooler'`,
          [signalId, behaviour],
        );
      const both = await sqlstateOf(() => insert("sig_oil_temperature", "beh_load_cycle"));
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      const neither = await sqlstateOf(() => insert(null, null));
      return { both, neither };
    });
    expect(states).toEqual({ both: CHECK_VIOLATION, neither: CHECK_VIOLATION });
  });
});

describe("0007_cost_system · the generated cost column", () => {
  it("prices both worked examples of the fixture", async () => {
    const costs = await withClient(stack.urlFor("app_rw"), async (client) => {
      const result = await client.query<{ model: string; cost_usd: string }>(
        "SELECT model, cost_usd FROM app.cost_ledger ORDER BY model",
      );
      return Object.fromEntries(result.rows.map((row) => [row.model, row.cost_usd]));
    });
    // 1234 input tokens at 0.042 per million.
    expect(costs["jev-1.13"]).toBe("0.0000518280");
    // 1000 input at 5 plus 200 output at 25, per million.
    expect(costs["llm-medium"]).toBe("0.0100000000");
  });

  it("totals the ledger per backend and model", async () => {
    const totals = await withClient(stack.urlFor("app_rw"), async (client) => {
      const result = await client.query<{
        backend: string;
        model: string;
        calls: string;
        input_tokens: string;
        cost_usd: string;
      }>(
        "SELECT backend, model, calls, input_tokens, cost_usd FROM app.v_cost_totals ORDER BY backend",
      );
      return result.rows;
    });
    expect(totals).toEqual([
      {
        backend: "jev",
        model: "jev-1.13",
        calls: "1",
        input_tokens: "1234",
        cost_usd: "0.0000518280",
      },
      {
        backend: "llm",
        model: "llm-medium",
        calls: "1",
        input_tokens: "1000",
        cost_usd: "0.0100000000",
      },
    ]);
  });
});

describe("0005_telemetry · prune_telemetry_agg", () => {
  it("removes the minutes older than the retention and keeps the rest", async () => {
    const result = await inRolledBackTransaction(stack.urlFor("app_rw"), async (client) => {
      await client.query("DELETE FROM app.telemetry_agg_1m");
      await client.query(
        `INSERT INTO app.telemetry_agg_1m (unit_id, minute_sim_ts, signal_id, n, last) VALUES
           ('cau-7-01', '2020-02-07T23:59:00Z', 'sig_oil_temperature', 60, 70),
           ('cau-7-01', '2020-02-08T12:00:00Z', 'sig_oil_temperature', 60, 71),
           ('cau-7-01', '2020-02-09T00:00:00Z', 'sig_oil_temperature', 60, 72),
           ('cau-7-01', '2020-02-09T12:00:00Z', 'sig_oil_temperature', 60, 73)`,
      );
      const pruned = await client.query<{ deleted: string }>(
        "SELECT app.prune_telemetry_agg(1, '2020-02-10T00:00:00Z') AS deleted",
      );
      const left = await client.query<{ minute_sim_ts: Date }>(
        "SELECT minute_sim_ts FROM app.telemetry_agg_1m ORDER BY minute_sim_ts",
      );
      return {
        deleted: pruned.rows[0]?.deleted,
        left: left.rows.map((row) => row.minute_sim_ts.toISOString()),
      };
    });
    expect(result).toEqual({
      deleted: "2",
      left: ["2020-02-09T00:00:00.000Z", "2020-02-09T12:00:00.000Z"],
    });
  });
});

describe("0004_catalog · v_catalog_entries", () => {
  it("yields one catalog-entry per cause with exactly the contract's keys", async () => {
    const entries = await catalogEntries();
    expect(Object.keys(entries).sort()).toEqual([
      "fau_blocked_intake_filter",
      "fau_fouled_oil_cooler",
    ]);
    for (const [faultId, entry] of Object.entries(entries)) {
      expect({ [faultId]: Object.keys(entry).sort() }).toEqual({ [faultId]: CATALOG_ENTRY_KEYS });
    }
  });

  it("gives every key the type the catalog-entry schema states", async () => {
    const entry = (await catalogEntries())["fau_fouled_oil_cooler"]!;
    expect(typeof entry["fault_id"]).toBe("string");
    expect(typeof entry["name"]).toBe("string");
    expect(typeof entry["subsystem"]).toBe("string");
    expect(typeof entry["benign"]).toBe("boolean");
    expect(typeof entry["summary"]).toBe("string");
    expect(typeof entry["remedy"]).toBe("string");
    expect(typeof entry["source"]).toBe("string");
    for (const key of ["parts", "maintenance", "related_alarms", "signal_moves_text", "checks"]) {
      const value = entry[key];
      expect({ [key]: Array.isArray(value) }).toEqual({ [key]: true });
      for (const item of value as unknown[]) expect(typeof item).toBe("string");
    }
    for (const key of ["signal_moves", "conditions"]) {
      const value = entry[key];
      expect({ [key]: Array.isArray(value) }).toEqual({ [key]: true });
      for (const item of value as unknown[]) expect(typeof item).toBe("object");
    }
    for (const key of ["pages", "manual_ref"]) {
      expect({ [key]: typeof entry[key] }).toEqual({ [key]: "object" });
      expect({ [key]: Array.isArray(entry[key]) }).toEqual({ [key]: false });
    }
    expect(entry["manual_ref"]).toEqual({
      section: "8.2.3",
      anchor: "sec-8-2-3",
      page: 12,
      page_start: 12,
      page_end: 13,
    });
  });

  it("lists both conditions of the shared cause, ordered by the link's ordinal", async () => {
    const entries = await catalogEntries();
    const shared = entries["fau_fouled_oil_cooler"]!["conditions"] as Record<string, unknown>[];
    expect(shared).toHaveLength(2);
    expect(shared.map((condition) => condition["condition_id"])).toEqual([
      "cnd_oil_temperature_high",
      "cnd_air_pressure_low",
    ]);
    expect(shared[0]).toEqual({
      condition_id: "cnd_oil_temperature_high",
      title: "Oil temperature above the normal band",
      likelihood: "common",
      note: "The usual finding on a dusty site.",
      alarms: ["W101"],
    });
    // The second link has no note, so the key is absent rather than null.
    expect(shared[1]).toEqual({
      condition_id: "cnd_air_pressure_low",
      title: "Air pressure below the set band",
      likelihood: "occasional",
      alarms: ["S204"],
    });
    expect(entries["fau_blocked_intake_filter"]!["conditions"] as unknown[]).toHaveLength(1);
  });

  it("omits the keys a signal move does not carry", async () => {
    const entry = (await catalogEntries())["fau_fouled_oil_cooler"]!;
    expect(entry["signal_moves"]).toEqual([
      {
        signal: "sig_oil_temperature",
        direction: "rises",
        phase: "loaded",
        onset: "gradual",
        note: "Above the normal band after ten loaded minutes.",
        text: "Oil temperature rises gradually while the unit is loaded.",
      },
      { behaviour: "beh_load_cycle", direction: "faster", phase: "any", onset: "sustained" },
    ]);
    // Only the rendered sentences, so the behaviour move contributes nothing.
    expect(entry["signal_moves_text"]).toEqual([
      "Oil temperature rises gradually while the unit is loaded.",
    ]);
    expect(entry["checks"]).toEqual([
      "Inspect the cooler matrix for dust.",
      "Compare the oil temperature with the normal band.",
    ]);
  });
});

describe("0003_manual_chunks · the two chunk indexes", () => {
  it("answers a cosine nearest-neighbour query from the HNSW index", async () => {
    const plan = await inRolledBackTransaction(stack.urlFor("app_rw"), async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const result = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF) SELECT id FROM app.chunks ORDER BY embedding <=> $1::vector LIMIT 1`,
        [PROBE_VECTOR],
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("chunks_embedding_hnsw");
  });

  it("finds a chunk through the generated tsvector", async () => {
    const found = await withClient(stack.urlFor("app_rw"), async (client) => {
      const result = await client.query<{ ordinal: number; section_ref: string }>(
        `SELECT ordinal, section_ref FROM app.chunks
          WHERE tsv @@ plainto_tsquery('english', $1) ORDER BY ordinal`,
        ["condensate"],
      );
      return result.rows;
    });
    expect(found).toEqual([{ ordinal: 0, section_ref: "8.2.3" }]);
  });
});

/** The view's rows, keyed by `fault_id`. */
async function catalogEntries(): Promise<Record<string, Record<string, unknown>>> {
  return withClient(stack.urlFor("app_rw"), async (client) => {
    const result = await client.query<{ fault_id: string; entry: Record<string, unknown> }>(
      "SELECT fault_id, entry FROM app.v_catalog_entries ORDER BY fault_id",
    );
    return Object.fromEntries(result.rows.map((row) => [row.fault_id, row.entry]));
  });
}

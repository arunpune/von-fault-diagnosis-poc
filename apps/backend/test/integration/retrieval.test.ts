// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval against the real schema.
 *
 * pgvector runs in a container with every migration, 0008's chunk links
 * included. The test stores the fixture catalog the way init does (as the
 * owning role, table by table in init's order), then thirty fictional manual
 * chunks — one troubleshooting row per cause, carrying its `fault_id`, and
 * prose from the fault-finding sections and elsewhere in a made-up manual —
 * with their vectors. Retrieval then reads it all as `app_rw`, the credential
 * the backend runs with, so a missing grant fails here.
 *
 * The vectors come from the real model when it is available
 * (`MODEL_CACHE_DIR` holding the pinned files, or `EMBEDDER_ALLOW_DOWNLOAD=true`)
 * and from a deterministic bag-of-words hash otherwise. Either way the chunks
 * and the query go through the same embedder, which is all stage 3 needs.
 *
 * Every sentence below is invented for this test; none comes from a real
 * manual, and no real manufacturer or product is named.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { startPostgres, type PgTestStack } from "@fdp/db-migrate/testing";
import {
  EMBEDDING,
  alarmByCode,
  validate,
  type CatalogEntry,
  type SuspectEvent,
} from "@fdp/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPool,
  query,
  queryOne,
  withTx,
  type Pool,
  type Queryable,
} from "../../src/db/pool.ts";
import { loadCatalog, type Catalog } from "../../src/retrieval/catalog.ts";
import {
  createEmbedder,
  l2Normalize,
  modelFilePath,
  toVectorLiteral,
  type Embedder,
} from "../../src/retrieval/embedder.ts";
import { ENGLISH_STOP_WORDS } from "../../src/retrieval/english-stop.ts";
import { searchFullText, searchVector } from "../../src/retrieval/hybrid.ts";
import { MAX_CANDIDATES, createPgRetriever, type Retriever } from "../../src/retrieval/index.ts";
import { buildQuery } from "../../src/retrieval/query.ts";
import { lexemes, stem } from "../../src/retrieval/text.ts";
import type { Candidate } from "../../src/retrieval/types.ts";
import {
  FAST_DECAY_EVENT,
  OIL_COOLER_EVENT,
  SIGNATURE_A_EVENT,
} from "../fixtures/catalog/events.ts";
import { FIXTURE_CATALOG } from "../fixtures/catalog/index.ts";

/** The symptom sentences of each condition, which only `app.catalog_conditions` holds. */
const SYMPTOMS: Readonly<Record<string, readonly string[]>> = {
  continuous_load: [
    "The compressor runs loaded without a break and never unloads.",
    "Line pressure stays below the cut-out setting while the unit delivers.",
  ],
  dryer_changeover_fault: [
    "The same dryer tower stays in service for longer than one tower period.",
    "The outlet dew point climbs while the towers stay still.",
  ],
  frequent_cycling: [
    "The compressor loads and unloads much more often than usual.",
    "Each unloaded pause is short because line pressure falls quickly.",
  ],
  low_line_pressure: [
    "Pressure in the distribution line sits below the setpoint.",
    "Consumers downstream report a low supply pressure.",
  ],
  motor_current_low: [
    "The motor draws less current than usual while loaded.",
    "Delivered air flow falls short of the rated output.",
  ],
  oil_temperature_high: [
    "Oil temperature climbs above its usual running band.",
    "The cooler outlet is hotter than usual.",
  ],
  purge_pressure_high: [
    "The dryer purge line carries pressure between changeover pulses.",
    "A steady hiss is heard at the purge silencer.",
  ],
  separator_pressure_abnormal: [
    "Separator discharge pressure drifts away from line pressure.",
    "Condensate or oil mist appears at the drain outlet.",
  ],
  water_in_air: [
    "Water or moisture appears in the delivered air.",
    "Consumers downstream collect condensate in their filters.",
  ],
};

interface ProseChunk {
  readonly section: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Eighteen prose chunks: eight inside the fault-finding sections the causes
 * point at (they reach a cause through the section prefix) and ten from the
 * rest of the manual (they reach none, and only compete for the neighbours).
 */
const PROSE: readonly ProseChunk[] = [
  {
    section: "8.3",
    title: "Line pressure below setpoint",
    body: "First decide whether the loss is inside the unit or in the plant. Watch how fast line pressure falls while the unit is unloaded: a fast fall with the unit idle points at a leak in the distribution pipework, or at a plant that draws more air than it used to.",
  },
  {
    section: "8.4",
    title: "Dryer purge pressure high, air escaping at the purge silencer",
    body: "The desiccant dryer purges one tower while the other dries the air. Purge pressure should rise only for the short changeover pulse; pressure that stays up between pulses means air escapes continuously through the purge path and the compressor stays loaded to make up for it.",
  },
  {
    section: "8.4.1",
    title: "Inspecting the purge silencer",
    body: "With the unit loaded, listen at the purge silencer between changeover pulses. Remove the silencer and look for torn or clogged elements before suspecting the purge valve.",
  },
  {
    section: "8.5",
    title: "Dryer towers do not change over",
    body: "The changeover valve moves the air flow from one tower to the other at the end of each tower period. When it sticks, one tower saturates and the dew point of the delivered air climbs.",
  },
  {
    section: "8.6",
    title: "Motor current low under load, delivery low",
    body: "A restriction on the intake side starves the airend, so the motor works less and the unit takes longer to fill the line. Look at the intake filter restriction indicator first.",
  },
  {
    section: "8.7",
    title: "Motor current low under load, delivery low",
    body: "Worn rotors let compressed air slip back to the intake side inside the airend. Delivery falls slowly over months while the motor current drops a little under load.",
  },
  {
    section: "8.8",
    title: "Oil temperature high",
    body: "Compare the oil temperature with the cooling-air temperature at the inlet. When the air is hot the cooler cannot shed the heat; when the air is mild, look at the cooler fins, the oil filter and the oil level in that order.",
  },
  {
    section: "8.9",
    title: "Separator discharge pressure abnormal",
    body: "The condensate drain on the separator opens briefly to release water. A drain that stays open blows air to atmosphere, and the unit loads more often to keep the line up.",
  },
  {
    section: "1.1",
    title: "Safety notes",
    body: "Isolate the unit electrically and vent all pressure before opening any cover. Wear hearing protection near a running unit.",
  },
  {
    section: "2.1",
    title: "Unit overview",
    body: "The unit is an oil-injected screw compressor with an integrated desiccant dryer, an air receiver and a controller with a text display.",
  },
  {
    section: "3.2",
    title: "Controller keys",
    body: "The start key begins a timed start sequence. The stop key unloads the unit and stops the motor after the run-on time.",
  },
  {
    section: "4.1",
    title: "Installation clearances",
    body: "Leave free space around the unit for cooling air and service access. The cooling-air inlet must not draw warm exhaust air back in.",
  },
  {
    section: "5.1",
    title: "Maintenance intervals",
    body: "Weekly, monthly and annual checks are listed in the maintenance table. Record every check in the service log.",
  },
  {
    section: "5.2",
    title: "Changing the oil",
    body: "Drain the oil while it is warm, replace the oil filter element and refill to the upper mark of the sight glass.",
  },
  {
    section: "6.1",
    title: "Dryer principle",
    body: "Two towers filled with desiccant take turns: one dries the delivered air while the other is regenerated by a small purge flow.",
  },
  {
    section: "7.1",
    title: "Alarm messages",
    body: "Warnings appear on the display and leave the unit running. Shutdown alarms stop the motor and must be acknowledged.",
  },
  {
    section: "7.2",
    title: "Resetting an alarm",
    body: "Remove the cause, then press the reset key. An alarm that returns at once calls for the fault-finding tables of chapter eight.",
  },
  {
    section: "9.1",
    title: "Technical data",
    body: "Rated delivery, maximum working pressure, motor power and sound level are printed on the data plate.",
  },
];

/** One row of `app.chunks`, before its vector is computed. */
interface ChunkRow {
  readonly section: string;
  readonly title: string;
  readonly kind: "text" | "table";
  readonly content: string;
  readonly faultId: string | null;
}

/**
 * The thirty chunks: a troubleshooting row per cause, in init's table-chunk
 * format, then the prose.
 */
function chunkRows(entries: readonly CatalogEntry[]): ChunkRow[] {
  const rows: ChunkRow[] = entries.map((entry) => {
    const title = entry.manual_ref.title ?? entry.name;
    return {
      section: entry.manual_ref.section,
      title,
      kind: "table",
      content:
        `${entry.manual_ref.section} ${title} — Fault finding\n` +
        `Cause: ${entry.name} | Check: ${entry.checks.join(" ")} | Remedy: ${entry.remedy}`,
      faultId: entry.fault_id,
    };
  });
  for (const prose of PROSE) {
    rows.push({
      section: prose.section,
      title: prose.title,
      kind: "text",
      content: `${prose.section} ${prose.title}\n${prose.body}`,
      faultId: null,
    });
  }
  return rows;
}

/** A 32-bit FNV-1a hash, so a word always lands in the same dimension. */
function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The deterministic stand-in for the model: a normalised bag of hashed words.
 *
 * Two texts are close when they share words, which is enough for stage 3 to
 * contribute a ranking the fusion can use, and needs neither a download nor
 * a native runtime.
 */
function createHashEmbedder(dimension: number): Embedder {
  function embedOne(text: string): Float32Array {
    const vector = new Float32Array(dimension);
    for (const word of text.toLowerCase().split(/[^a-z]+/)) {
      if (word.length < 3) continue;
      const slot = fnv1a(word) % dimension;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    return l2Normalize(vector);
  }
  return { dimension, embed: (texts) => Promise.resolve(texts.map(embedOne)) };
}

/** The real model when the environment offers it, the hash embedder otherwise. */
async function chooseEmbedder(): Promise<{ embedder: Embedder; real: boolean }> {
  const allowDownload = process.env.EMBEDDER_ALLOW_DOWNLOAD === "true";
  const cacheDir = process.env.MODEL_CACHE_DIR ?? join(tmpdir(), "fdp-models");
  const cached = EMBEDDING.files.every((file) =>
    existsSync(modelFilePath(EMBEDDING, cacheDir, file.path)),
  );
  if (!cached && !allowDownload) {
    return { embedder: createHashEmbedder(EMBEDDING.dimension), real: false };
  }
  return { embedder: await createEmbedder({ cacheDir, allowDownload }), real: true };
}

/** Insert one row and return its identity. */
async function insertId(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ id: string }>(db, `${sql} RETURNING id`, params);
  if (row === undefined) throw new Error(`no id returned by: ${sql}`);
  return Number(row.id);
}

/** Every section a cause or a chunk points at, parents included. */
function sectionRows(chunks: readonly ChunkRow[]): { ref: string; title: string }[] {
  const titles = new Map<string, string>();
  for (const chunk of chunks)
    if (!titles.has(chunk.section)) titles.set(chunk.section, chunk.title);
  return [...titles].map(([ref, title]) => ({ ref, title }));
}

/**
 * Store the catalog and the chunks as init does: document,
 * a `running` run, sections, conditions, causes, their links, checks, remedies
 * and signal moves, alarms, chunks — and the run marked `succeeded` last, in
 * the same transaction.
 */
async function storeManual(
  admin: Pool,
  entries: readonly CatalogEntry[],
  embedder: Embedder,
): Promise<number> {
  const chunks = chunkRows(entries);
  const vectors = await embedder.embed(chunks.map((chunk) => chunk.content));

  return withTx(admin, async (tx) => {
    const documentId = await insertId(
      tx,
      "INSERT INTO app.manual_documents (name, path, variant, sha256, bytes, pages) VALUES ($1, $2, $3, $4, $5, $6)",
      ["Operator manual (test)", "/manual/test.pdf", "clean", "a".repeat(64), 123_456, 40],
    );
    const runId = await insertId(
      tx,
      "INSERT INTO app.ingest_runs (document_id, status, embedding_model_id, embedding_revision, embedding_dimension, catalog_source) " +
        "VALUES ($1, 'running', $2, $3, $4, 'yaml')",
      [documentId, EMBEDDING.model_id, EMBEDDING.revision, EMBEDDING.dimension],
    );

    for (const section of sectionRows(chunks)) {
      const parent = section.ref.includes(".")
        ? section.ref.slice(0, section.ref.lastIndexOf("."))
        : null;
      await query(
        tx,
        "INSERT INTO app.catalog_sections (document_id, section_ref, title, level, parent_ref) VALUES ($1, $2, $3, $4, $5)",
        [documentId, section.ref, section.title, section.ref.split(".").length, parent],
      );
    }

    const conditionPks = new Map<string, number>();
    for (const entry of entries) {
      for (const condition of entry.conditions) {
        if (conditionPks.has(condition.condition_id)) continue;
        conditionPks.set(
          condition.condition_id,
          await insertId(
            tx,
            "INSERT INTO app.catalog_conditions (document_id, condition_id, title, symptoms, alarm_codes, source) " +
              "VALUES ($1, $2, $3, $4, $5, 'yaml')",
            [
              documentId,
              condition.condition_id,
              condition.title,
              SYMPTOMS[condition.condition_id] ?? [],
              condition.alarms,
            ],
          ),
        );
      }
    }

    for (const entry of entries) {
      const causePk = await insertId(
        tx,
        "INSERT INTO app.catalog_causes (document_id, fault_id, name, summary, subsystem, benign, remedy, parts, " +
          "maintenance, related_alarms, manual_section, manual_anchor, source) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
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
          entry.source,
        ],
      );
      for (const [ordinal, condition] of entry.conditions.entries()) {
        await query(
          tx,
          "INSERT INTO app.catalog_condition_causes (condition_pk, cause_pk, ordinal, likelihood, note) VALUES ($1, $2, $3, $4, $5)",
          [
            conditionPks.get(condition.condition_id),
            causePk,
            ordinal,
            condition.likelihood,
            condition.note ?? null,
          ],
        );
      }
      for (const [ordinal, instruction] of entry.checks.entries()) {
        await query(
          tx,
          "INSERT INTO app.catalog_checks (cause_pk, ordinal, instruction) VALUES ($1, $2, $3)",
          [causePk, ordinal, instruction],
        );
      }
      await query(
        tx,
        "INSERT INTO app.catalog_remedies (cause_pk, ordinal, action) VALUES ($1, 0, $2)",
        [causePk, entry.remedy],
      );
      for (const [ordinal, move] of entry.signal_moves.entries()) {
        await query(
          tx,
          "INSERT INTO app.catalog_signal_moves (cause_pk, ordinal, signal_id, behaviour, direction, phase, onset, note, text) " +
            "VALUES ($1, $2, $3, $4, $5, coalesce($6, 'any'), coalesce($7, 'sustained'), $8, $9)",
          [
            causePk,
            ordinal,
            move.signal ?? null,
            move.behaviour ?? null,
            move.direction,
            move.phase ?? null,
            move.onset ?? null,
            move.note ?? null,
            move.text ?? null,
          ],
        );
      }
    }

    const codes = [...new Set(entries.flatMap((entry) => entry.related_alarms))].sort();
    for (const code of codes) {
      const alarm = alarmByCode(code);
      if (alarm === undefined)
        throw new Error(`the fixture names an alarm the registry lacks: ${code}`);
      await query(
        tx,
        "INSERT INTO app.catalog_alarms (document_id, code, type, title) VALUES ($1, $2, $3, $4)",
        [documentId, code, alarm.type, alarm.title],
      );
    }

    for (const [ordinal, chunk] of chunks.entries()) {
      const vector = vectors[ordinal];
      if (vector === undefined) throw new Error(`no vector for chunk ${ordinal}`);
      await query(
        tx,
        "INSERT INTO app.chunks (document_id, ordinal, section_ref, section_title, kind, content, embedding, fault_id, table_kind) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)",
        [
          documentId,
          ordinal,
          chunk.section,
          chunk.title,
          chunk.kind,
          chunk.content,
          toVectorLiteral(vector),
          chunk.faultId,
          chunk.kind === "table" ? "troubleshooting" : null,
        ],
      );
    }

    await query(
      tx,
      "UPDATE app.ingest_runs SET status = 'succeeded', finished_wall_ts = now() WHERE id = $1",
      [runId],
    );
    return documentId;
  });
}

/**
 * A later re-ingestion that failed: init leaves the new document row and its
 * failed run behind for diagnosis and keeps the previous manual.
 */
async function storeFailedReingestion(admin: Pool): Promise<number> {
  const documentId = await insertId(
    admin,
    "INSERT INTO app.manual_documents (name, path, variant, sha256, bytes) VALUES ($1, $2, $3, $4, $5)",
    ["Operator manual (broken)", "/manual/broken.pdf", "byo", "b".repeat(64), 99],
  );
  await query(
    admin,
    "INSERT INTO app.ingest_runs (document_id, status, started_wall_ts, finished_wall_ts, embedding_model_id, " +
      "embedding_revision, embedding_dimension, error) " +
      "VALUES ($1, 'failed', now() + interval '1 minute', now() + interval '2 minutes', $2, $3, $4, 'extraction failed')",
    [documentId, EMBEDDING.model_id, EMBEDDING.revision, EMBEDDING.dimension],
  );
  return documentId;
}

function ids(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.fault_id);
}

let pg: PgTestStack;
let admin: Pool;
let app: Pool;
let embedder: Embedder;
let realModel: boolean;
let documentId: number;
let catalog: Catalog;
let retriever: Retriever;

beforeAll(async () => {
  ({ embedder, real: realModel } = await chooseEmbedder());
  process.stdout.write(
    `retrieval.test.ts: stage 3 runs on ${realModel ? `the real model ${EMBEDDING.model_id}` : "the deterministic hash embedder"}\n`,
  );
  pg = await startPostgres({ migrate: true });
  admin = createPool(pg.adminUrl, { applicationName: "fdp-backend-retrieval-admin" });
  app = createPool(pg.urlFor("app_rw"), { applicationName: "fdp-backend-retrieval" });

  documentId = await storeManual(admin, FIXTURE_CATALOG, embedder);
  await storeFailedReingestion(admin);

  catalog = await loadCatalog(app);
  retriever = createPgRetriever({ pool: app, embedder });
});

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await pg?.stop();
});

describe("app.v_catalog_entries, read as app_rw", () => {
  it("serves the active document: the one whose ingest run succeeded, not the newer failed one", () => {
    expect(catalog.documentId).toBe(documentId);
  });

  it("produces one valid catalog-entry per stored cause", async () => {
    const rows = await query<{ fault_id: string; entry: unknown }>(
      app,
      "SELECT fault_id, entry FROM app.v_catalog_entries WHERE document_id = $1 ORDER BY fault_id",
      [documentId],
    );
    expect(rows.map((row) => row.fault_id)).toEqual(
      FIXTURE_CATALOG.map((entry) => entry.fault_id).sort(),
    );
    for (const row of rows) {
      const result = validate("catalog-entry", row.entry);
      expect(result.ok ? [] : result.errors.map((error) => error.text)).toEqual([]);
    }
    expect(catalog.invalid).toEqual([]);
    expect(catalog.entries).toHaveLength(FIXTURE_CATALOG.length);
  });

  it("round-trips the fields retrieval reads", () => {
    for (const stored of catalog.entries) {
      const original = FIXTURE_CATALOG.find((entry) => entry.fault_id === stored.fault_id);
      expect(original).toBeDefined();
      if (original === undefined) continue;
      expect(stored.benign).toBe(original.benign);
      expect(
        stored.signal_moves.map((move) => [move.signal ?? move.behaviour, move.direction]),
      ).toEqual(
        original.signal_moves.map((move) => [move.signal ?? move.behaviour, move.direction]),
      );
      expect(stored.conditions.map((condition) => condition.condition_id)).toEqual(
        original.conditions.map((condition) => condition.condition_id),
      );
      expect(stored.manual_ref.section).toBe(original.manual_ref.section);
    }
  });

  it("carries the symptoms and the alarm titles the query builder needs", () => {
    expect(catalog.conditions.get("continuous_load")?.symptoms).toEqual(SYMPTOMS.continuous_load);
    expect(catalog.alarmTitles.get("W103")).toBe("Dryer purge pressure high");
  });
});

describe("the database stages, read as app_rw", () => {
  const context = (link: "fault_id" | "section_ref") => ({ documentId, link });
  const text = "purge silencer hiss between changeover pulses";

  it("full text reaches causes through the catalog and through both chunk links", async () => {
    for (const link of ["fault_id", "section_ref"] as const) {
      const found = await searchFullText(app, context(link), text, 20);
      expect(found.length).toBeGreaterThan(0);
      expect(found.map((hit) => hit.fault_id)).toContain("purge_silencer_damaged");
      for (const hit of found) expect(hit.score).toBeGreaterThan(0);
    }
  });

  it("the vector search runs exactly or through the index and maps chunks through both links", async () => {
    const [vector] = await embedder.embed([text]);
    if (vector === undefined) throw new Error("the embedder returned nothing");
    for (const link of ["fault_id", "section_ref"] as const) {
      const exact = await searchVector(app, context(link), toVectorLiteral(vector), {
        exact: true,
      });
      expect(exact.map((hit) => hit.fault_id)).toContain("purge_silencer_damaged");
      const indexed = await searchVector(app, context(link), toVectorLiteral(vector), {
        exact: false,
      });
      expect(indexed.length).toBeGreaterThan(0);
    }
  });
});

describe("createPgRetriever for the F3-like event (signature A)", () => {
  let candidates: Candidate[];

  beforeAll(async () => {
    candidates = await retriever.retrieve(SIGNATURE_A_EVENT);
  });

  it("offers at most six catalog-entry-shaped candidates with retrieval scores", () => {
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    for (const candidate of candidates) {
      const { retrieval, ...entry } = candidate;
      expect(validate("catalog-entry", entry).ok).toBe(true);
      for (const score of Object.values(retrieval)) expect(Number.isFinite(score)).toBe(true);
    }
  });

  it("puts dryer_purge_leak in the top three", () => {
    expect(ids(candidates).slice(0, 3)).toContain("dryer_purge_leak");
  });

  it("was ranked by all three stages", () => {
    const expected = candidates.find((candidate) => candidate.fault_id === "dryer_purge_leak");
    expect(expected?.retrieval.catalog).toBeGreaterThan(0);
    expect(expected?.retrieval.text).toBeGreaterThan(0);
    expect(expected?.retrieval.vector).toBeGreaterThan(0);
    expect(expected?.retrieval.rrf).toBeGreaterThan(0);
  });

  it("keeps a benign explanation on the sheet", () => {
    expect(candidates.some((candidate) => candidate.benign)).toBe(true);
  });

  it("returns the same order and the same scores on every run", async () => {
    const again = await retriever.retrieve(SIGNATURE_A_EVENT);
    const fresh = await createPgRetriever({ pool: app, embedder }).retrieve(SIGNATURE_A_EVENT);
    expect(again).toEqual(candidates);
    expect(fresh).toEqual(candidates);
  });
});

describe("the database-free stand-in reads words as the english configuration does", () => {
  /** Every word of the texts this file stores, lowercased, letters only. */
  function storedWords(): string[] {
    const texts = [
      ...FIXTURE_CATALOG.flatMap((entry) => [
        entry.name,
        entry.summary,
        entry.remedy,
        ...entry.checks,
        ...entry.signal_moves_text,
        ...entry.conditions.map((condition) => condition.title),
      ]),
      ...Object.values(SYMPTOMS).flat(),
      ...PROSE.flatMap((prose) => [prose.title, prose.body]),
    ];
    const words = new Set(
      texts
        .join(" ")
        .toLowerCase()
        .split(/[^a-z]+/),
    );
    words.delete("");
    return [...words].sort();
  }

  it("uses PostgreSQL's english stop list, word for word and in order", async () => {
    const row = await queryOne<{ list: string }>(
      admin,
      "SELECT pg_read_file(setting || '/tsearch_data/english.stop') AS list FROM pg_config WHERE name = 'SHAREDIR'",
    );
    const listed = (row?.list ?? "").split("\n").filter((word) => word !== "");
    expect(listed).toEqual([...ENGLISH_STOP_WORDS]);
  });

  it("stems every word of the stored texts as english_stem does", async () => {
    const words = storedWords();
    expect(words.length).toBeGreaterThan(300);
    const rows = await query<{ word: string; lexemes: string[] | null }>(
      app,
      "SELECT w AS word, ts_lexize('english_stem', w) AS lexemes FROM unnest($1::text[]) AS w",
      [words],
    );
    const differing = rows
      .map((row) => ({
        word: row.word,
        postgres: row.lexemes ?? [],
        standIn: ENGLISH_STOP_WORDS.has(row.word) ? [] : [stem(row.word)],
      }))
      .filter((row) => row.postgres.join() !== row.standIn.join());
    expect(differing).toEqual([]);
  });

  it("gives a rule detail the lexemes to_tsvector('english') gives it", async () => {
    const sentence =
      "Oil temperature has been climbing steadily while the load pattern stayed normal.";
    const vector = await queryOne<{ lexemes: string[] }>(
      app,
      "SELECT tsvector_to_array(to_tsvector('english', $1)) AS lexemes",
      [sentence],
    );
    expect([...(vector?.lexemes ?? [])].sort()).toEqual([...lexemes(sentence)].sort());
  });
});

describe("the stage-2 query over the stored catalog", () => {
  it("carries the stored symptoms and the rule details, and no observation sentence", () => {
    const event: SuspectEvent & { readonly rules_fired: readonly { readonly detail: string }[] } = {
      ...OIL_COOLER_EVENT,
      rule_ids: ["oil_temperature_rising"],
      rules_fired: [{ detail: "Oil temperature has been climbing steadily." }],
      evidence: [
        { metric: "oil_temperature", observation: "Oil temperature has been climbing steadily." },
        { metric: "line_pressure", observation: "Line pressure normal, falling for minutes." },
      ],
    };
    const { text } = buildQuery(event, catalog);
    for (const symptom of SYMPTOMS.oil_temperature_high ?? []) expect(text).toContain(symptom);
    expect(text).toContain("Oil temperature has been climbing steadily.");
    expect(text).not.toContain("Line pressure normal, falling for minutes.");
  });
});

describe("createPgRetriever for the other fixture situations", () => {
  const cases: readonly (readonly [string, SuspectEvent, readonly string[]])[] = [
    ["the oil-cooler event", OIL_COOLER_EVENT, ["oil_cooler_fouled"]],
    ["the fast-decay event", FAST_DECAY_EVENT, ["downstream_air_leak", "high_air_demand"]],
  ];

  it.each(cases)(
    "%s offers the expected explanation in the top three",
    async (_name, event, expected) => {
      const top = ids(await retriever.retrieve(event)).slice(0, 3);
      expect(top.some((faultId) => expected.includes(faultId))).toBe(true);
    },
  );
});

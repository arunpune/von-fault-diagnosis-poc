// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * From one event to at most six candidates.
 *
 * The list rules are proven on hand-made stage scores, where the fused order
 * can be worked out on paper: at most six, at least three, the best benign
 * cause inside the top twelve kept, ordered by the fusion — and, given the
 * event's condition, the causes the manual files under it first. The
 * database-free retriever is then run on the fixture catalog and events, the
 * same pair the decision tests use, and must put the expected cause first, and
 * on the manual's catalog with synthetic, detection-shaped events. The pg
 * retriever's composition is checked against a recording pool; its SQL runs
 * against pgvector in `test/integration/retrieval.test.ts`.
 */

import { EventEmitter } from "node:events";

import { validate, type CatalogEntry, type SignalMove, type SuspectEvent } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  FAST_DECAY_EVENT,
  FIXTURE_CASES,
  OIL_COOLER_EVENT,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { FIXTURE_CATALOG, catalogEntry } from "../../test/fixtures/catalog/index.ts";
import { MAN_CATALOG, causesUnder } from "../../test/fixtures/catalog/man/index.ts";
import {
  baselineBusierHour,
  coldNightOilCooler,
  depot,
  downstreamLeak,
  hotRoom,
  oilCoolerByMode,
  signatureA,
} from "../../test/fixtures/synthetic/calibration.ts";
import type { Pool } from "../db/pool.ts";
import { EMPTY_CATALOG, catalogFromEntries, type Catalog, type CatalogLoader } from "./catalog.ts";
import type { Embedder } from "./embedder.ts";
import {
  BENIGN_WINDOW,
  CONDITION_BONUS,
  CO_SYMPTOM_BONUS,
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  assembleCandidates,
  createCatalogRetriever,
  createPgRetriever,
  keywordOverlap,
  moveSentences,
  scoreCatalogStage,
  type StageScores,
} from "./index.ts";
import { matchContextOf, observedFromEvent, scoreSignalMoves } from "./match.ts";
import { lexemes } from "./text.ts";
import type { Candidate } from "./types.ts";

/** A copy of a fixture entry under another id, so a test can have as many as it needs. */
function entry(faultId: string, benign = false): CatalogEntry {
  return { ...catalogEntry("downstream_air_leak"), fault_id: faultId, benign };
}

function ids(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.fault_id);
}

/** Stage scores that rank `order` first to last in all three stages. */
function descending(order: readonly string[]): Map<string, StageScores> {
  return new Map(
    order.map((faultId, index) => {
      const score = 1 - index / (order.length + 1);
      return [faultId, { catalog: score, text: score, vector: score }];
    }),
  );
}

describe("assembleCandidates", () => {
  const many = Array.from({ length: 14 }, (_, index) =>
    entry(`cause_${String.fromCharCode(97 + index)}`),
  );
  const manyIds = many.map((item) => item.fault_id);

  it("offers at most six, in fused order, each with its stage scores and rrf", () => {
    const candidates = assembleCandidates(many, descending(manyIds));

    expect(candidates).toHaveLength(MAX_CANDIDATES);
    expect(ids(candidates)).toEqual(manyIds.slice(0, MAX_CANDIDATES));
    const [first] = candidates;
    expect(first?.retrieval.catalog).toBeCloseTo(1, 12);
    expect(first?.retrieval.text).toBeCloseTo(1, 12);
    expect(first?.retrieval.vector).toBeCloseTo(1, 12);
    expect(first?.retrieval.rrf).toBeCloseTo(3 / 61, 12);
    const fused = candidates.map((candidate) => candidate.retrieval.rrf);
    expect(fused).toEqual([...fused].sort((left, right) => right - left));
  });

  it("orders by the fusion, not by any single stage", () => {
    const stages = new Map<string, StageScores>([
      // First in one stage only.
      ["cause_a", { catalog: 0.9, text: 0, vector: 0 }],
      // Second in all three.
      ["cause_b", { catalog: 0.8, text: 0.5, vector: 0.5 }],
      ["cause_c", { catalog: 0.1, text: 0.9, vector: 0.9 }],
    ]);
    expect(ids(assembleCandidates(many, stages))).toEqual(["cause_c", "cause_b", "cause_a"]);
  });

  it("fills a short list to three, however weak the fillers", () => {
    const stages = new Map<string, StageScores>([
      ["cause_d", { catalog: 0, text: 0.4, vector: 0 }],
      ["cause_b", { catalog: 0, text: 0, vector: 0 }],
      ["cause_c", { catalog: 0, text: 0, vector: 0 }],
      ["cause_a", { catalog: 0, text: 0, vector: 0 }],
    ]);
    const candidates = assembleCandidates(many, stages);

    expect(candidates).toHaveLength(MIN_CANDIDATES);
    // The fused one first, then causes no stage scored, in fault_id order.
    expect(ids(candidates)).toEqual(["cause_d", "cause_a", "cause_b"]);
    expect(candidates[0]?.retrieval.rrf).toBeGreaterThan(0);
    expect(candidates[1]?.retrieval.rrf).toBe(0);
  });

  it("cannot offer more causes than the catalog holds", () => {
    const two = many.slice(0, 2);
    expect(ids(assembleCandidates(two, new Map()))).toEqual(["cause_a", "cause_b"]);
    expect(assembleCandidates([], new Map())).toEqual([]);
  });

  it("keeps the best-ranked benign cause of the top twelve in the last seat", () => {
    const withBenign = [...many.slice(0, 10), entry("zz_busy_plant", true)];
    const order = [...withBenign.slice(0, 10).map((item) => item.fault_id), "zz_busy_plant"];
    const candidates = assembleCandidates(withBenign, descending(order));

    expect(candidates).toHaveLength(MAX_CANDIDATES);
    expect(ids(candidates).slice(0, 5)).toEqual(order.slice(0, 5));
    expect(candidates[5]?.fault_id).toBe("zz_busy_plant");
    expect(candidates[5]?.benign).toBe(true);
  });

  it("leaves a benign cause already on the list where it is", () => {
    const withBenign = [entry("cause_a"), entry("cause_b", true), ...many.slice(2, 9)];
    const candidates = assembleCandidates(
      withBenign,
      descending(withBenign.map((item) => item.fault_id)),
    );
    expect(ids(candidates)).toEqual(
      withBenign.slice(0, MAX_CANDIDATES).map((item) => item.fault_id),
    );
  });

  it("does not reach past the twelfth fused rank for a benign cause", () => {
    const withBenign = [...many.slice(0, BENIGN_WINDOW), entry("zz_busy_plant", true)];
    const order = withBenign.map((item) => item.fault_id);
    const candidates = assembleCandidates(withBenign, descending(order));
    expect(candidates.some((candidate) => candidate.benign)).toBe(false);
  });

  it("ignores stage scores for causes the catalog does not hold", () => {
    const stages = descending(["ghost", "cause_a", "cause_b", "cause_c"]);
    expect(ids(assembleCandidates(many, stages))).toEqual(["cause_a", "cause_b", "cause_c"]);
  });
});

describe("assembleCandidates with the event's condition", () => {
  // Fourteen synthetic causes, fused a…n in that order in all three stages.
  // Which of them the manual files under the event's condition is what each
  // test varies; nothing here is a scenario or a recorded event.
  const SYMPTOM = "synthetic_symptom";

  /** A cause filed under `SYMPTOM` when `listed`, under another condition otherwise. */
  function cause(faultId: string, listed: boolean, benign = false): CatalogEntry {
    const base = catalogEntry("downstream_air_leak");
    const [first] = base.conditions;
    const condition = { ...first, condition_id: listed ? SYMPTOM : "another_condition" };
    return { ...base, fault_id: faultId, benign, conditions: [condition] };
  }

  const letters = "abcdefghijklmn".split("");
  const idOf = (letter: string): string => `cause_${letter}`;
  const order = letters.map(idOf);

  /** The fourteen causes, those in `listed` filed under the symptom, those in `benign` benign. */
  function catalog(listed: string, benign = ""): CatalogEntry[] {
    return letters.map((letter) =>
      cause(idOf(letter), listed.includes(letter), benign.includes(letter)),
    );
  }

  it("puts the causes filed under the condition first, each part in fused order", () => {
    const entries = catalog("eg");
    const stages = descending(order);

    expect(ids(assembleCandidates(entries, stages, SYMPTOM))).toEqual(
      ["e", "g", "a", "b", "c", "d"].map(idOf),
    );
    // Without the condition the fusion alone orders the list, as before.
    expect(ids(assembleCandidates(entries, stages))).toEqual(order.slice(0, MAX_CANDIDATES));
  });

  it("offers every cause of a condition that lists six or fewer, however poorly they fuse", () => {
    const candidates = assembleCandidates(catalog("klmn"), descending(order), SYMPTOM);

    expect(ids(candidates)).toEqual(["k", "l", "m", "n", "a", "b"].map(idOf));
    // The rrf each carries is still its fused score: the order changed, the scores did not.
    expect(candidates[0]?.retrieval.rrf).toBeLessThan(candidates[4]?.retrieval.rrf ?? 0);
  });

  it("offers the six best-fused causes of a condition that lists more than six", () => {
    const candidates = assembleCandidates(catalog("bdfhjln"), descending(order), SYMPTOM);
    expect(ids(candidates)).toEqual(["b", "d", "f", "h", "j", "l"].map(idOf));
  });

  it("still keeps a benign cause in the last seat when the condition lists none", () => {
    // Seven listed causes fill the six; the best-fused cause of all is benign and
    // filed elsewhere, eighth in the list as ordered, inside the window of twelve.
    const candidates = assembleCandidates(catalog("bdfhjln", "a"), descending(order), SYMPTOM);
    expect(ids(candidates)).toEqual(["b", "d", "f", "h", "j", "a"].map(idOf));
    expect(candidates[5]?.benign).toBe(true);
  });

  it("keeps the condition's own benign cause before a better-fused one filed elsewhere", () => {
    const candidates = assembleCandidates(catalog("bdfhjln", "an"), descending(order), SYMPTOM);
    expect(ids(candidates)).toEqual(["b", "d", "f", "h", "j", "n"].map(idOf));
  });

  it("changes nothing when the catalog files no cause under the condition", () => {
    const entries = catalog("");
    const stages = descending(order);
    expect(ids(assembleCandidates(entries, stages, SYMPTOM))).toEqual(
      ids(assembleCandidates(entries, stages)),
    );
  });
});

describe("scoreCatalogStage", () => {
  const observed = observedFromEvent(SIGNATURE_A_EVENT.observations);

  it("adds +0.15 for the event's condition and +0.05 for a co-occurring one", () => {
    const scores = scoreCatalogStage(FIXTURE_CATALOG, SIGNATURE_A_EVENT, observed);
    const base = (faultId: string): number =>
      scoreSignalMoves(
        observed,
        catalogEntry(faultId).signal_moves,
        matchContextOf(SIGNATURE_A_EVENT),
      ).score;

    // Listed under continuous_load (the symptom) and purge_pressure_high (a co-symptom).
    expect(scores.get("dryer_purge_leak")).toBeCloseTo(
      base("dryer_purge_leak") + CONDITION_BONUS + CO_SYMPTOM_BONUS,
      12,
    );
    // Listed under continuous_load only.
    expect(scores.get("airend_element_wear")).toBeCloseTo(
      base("airend_element_wear") + CONDITION_BONUS,
      12,
    );
    // Listed under purge_pressure_high (a co-symptom) but not continuous_load.
    expect(scores.get("tower_changeover_valve_fault")).toBeCloseTo(
      base("tower_changeover_valve_fault") + CO_SYMPTOM_BONUS,
      12,
    );
    // Neither.
    expect(scores.get("oil_cooler_fouled")).toBeCloseTo(base("oil_cooler_fouled"), 12);
  });

  it("matches the observations in the event's own mode", () => {
    // A cause that expects the regulator contact to stay off, against a contact
    // resting at its usual value: off while loaded (silent), on while idling
    // (a contradiction). Same words, same entry; only the event's mode differs.
    const contactStaysOff: CatalogEntry = {
      ...catalogEntry("oil_cooler_fouled"),
      signal_moves: [
        { signal: "oil_temperature", direction: "rises" },
        { signal: "regulator_contact", direction: "stays_off" },
      ],
    };
    const contact = [
      ...observedFromEvent(OIL_COOLER_EVENT.observations),
      { signal: "regulator_contact", level: "normal", trend: "flat" } as const,
    ];
    const whileMode = (mode: SuspectEvent["machine_state"]["mode"]): number | undefined =>
      scoreCatalogStage(
        [contactStaysOff],
        { ...OIL_COOLER_EVENT, machine_state: { ...OIL_COOLER_EVENT.machine_state, mode } },
        contact,
      ).get("oil_cooler_fouled");

    // Both scores carry the +0.15 of the oil-temperature condition the event names.
    expect(whileMode("loaded")).toBeCloseTo(0.5 + CONDITION_BONUS, 12);
    expect(whileMode("unloaded")).toBeCloseTo(0.25 + CONDITION_BONUS, 12);
  });
});

describe("keywordOverlap", () => {
  it("is the share of the query's lexemes the entry also uses", () => {
    const dryer = catalogEntry("dryer_purge_leak");
    expect(keywordOverlap(lexemes("purge valve"), dryer)).toBe(1);
    expect(keywordOverlap(lexemes("purge valve zzzword"), dryer)).toBeCloseTo(2 / 3, 12);
    expect(keywordOverlap(new Set(), dryer)).toBe(0);
  });

  it("meets the entry's words in another inflection and never counts a stop word", () => {
    const dryer = catalogEntry("dryer_purge_leak");
    expect(keywordOverlap(lexemes("the purging valves"), dryer)).toBe(1);
  });
});

describe("createCatalogRetriever on the fixture catalog", () => {
  const retriever = createCatalogRetriever(FIXTURE_CATALOG);

  it("puts dryer_purge_leak first for the signature-A event", async () => {
    const candidates = await retriever.retrieve(SIGNATURE_A_EVENT);
    expect(candidates[0]?.fault_id).toBe("dryer_purge_leak");
  });

  it("puts a plant-side explanation first for the fast-decay event", async () => {
    const candidates = await retriever.retrieve(FAST_DECAY_EVENT);
    expect(["high_air_demand", "downstream_air_leak"]).toContain(candidates[0]?.fault_id);
  });

  it("offers the fouled oil cooler among the first two for the oil-cooler event", async () => {
    const candidates = await retriever.retrieve(OIL_COOLER_EVENT);
    expect(ids(candidates).slice(0, 2)).toContain("oil_cooler_fouled");
  });

  it.each(FIXTURE_CASES.map((fixture) => [fixture.name, fixture.event] as const))(
    "%s: three to six contract-shaped candidates, a benign one among them, stable across runs",
    async (_name, event) => {
      const first = await retriever.retrieve(event);
      const second = await retriever.retrieve(event);

      expect(first.length).toBeGreaterThanOrEqual(MIN_CANDIDATES);
      expect(first.length).toBeLessThanOrEqual(MAX_CANDIDATES);
      expect(first.some((candidate) => candidate.benign)).toBe(true);
      expect(ids(second)).toEqual(ids(first));
      for (const candidate of first) {
        const { retrieval, ...catalogShape } = candidate;
        expect(validate("catalog-entry", catalogShape).ok).toBe(true);
        expect(retrieval.vector).toBe(0);
      }
    },
  );
});

describe("createCatalogRetriever with the condition symptoms (synthetic)", () => {
  // A synthetic oil-temperature event and eight synthetic causes filed under
  // its condition, all expecting the oil temperature to rise: stage 1 ties
  // them, and the tie goes by fault_id, so the cooler cause ranks last there.
  // The seven others share the rule detail's words; the cooler cause shares
  // only the condition's symptom sentence. Nothing here is a labelled window
  // or a recorded event.
  const SYMPTOM =
    "The cooler fins are caked with dust and the cooling air leaving the unit is warm.";

  function oilCause(faultId: string, name: string, summary: string): CatalogEntry {
    return {
      ...catalogEntry("oil_cooler_fouled"),
      fault_id: faultId,
      name,
      summary,
      remedy: "",
      checks: [],
      benign: false,
      signal_moves: [{ signal: "oil_temperature", direction: "rises" }],
      signal_moves_text: [],
      conditions: [
        {
          condition_id: "oil_temperature_high",
          title: "Oil temperature high",
          likelihood: "common",
          alarms: [],
        },
      ],
    };
  }

  const distractors = "abcdefg"
    .split("")
    .map((letter) =>
      oilCause(
        `oil_cause_${letter}`,
        `Load pattern change ${letter}`,
        "The load pattern changed, so the oil temperature climbs steadily.",
      ),
    );
  const cooler = oilCause(
    "oil_cooler_fins_blocked",
    "Cooler fins blocked",
    "Dust on the cooler fins keeps the cooling air from carrying the heat away.",
  );
  const entries = [...distractors, cooler];

  const event: SuspectEvent = {
    ...OIL_COOLER_EVENT,
    rule_ids: ["oil_temperature_rising"],
    evidence: [
      {
        metric: "oil_temperature",
        observation:
          "Oil temperature has been climbing steadily while the load pattern stayed normal.",
      },
    ],
    observations: [
      { signal: "oil_temperature", level: "far_above", trend: "rising", since: "several hours" },
    ],
    active_alarms: [],
    co_symptoms: [],
  };

  it("ties the causes in stage 1, so the text stage decides", () => {
    const stage1 = scoreCatalogStage(entries, event, observedFromEvent(event.observations));
    expect(new Set(stage1.values())).toEqual(new Set([1 + CONDITION_BONUS]));
  });

  it("leaves the cooler cause out of the six without the symptom", async () => {
    const candidates = await createCatalogRetriever(entries).retrieve(event);
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    expect(ids(candidates)).not.toContain("oil_cooler_fins_blocked");
  });

  it("offers it once the condition's symptom reaches the query", async () => {
    const retriever = createCatalogRetriever(entries, {
      conditions: [
        {
          condition_id: "oil_temperature_high",
          title: "Oil temperature high",
          symptoms: [SYMPTOM],
        },
      ],
    });
    const candidates = await retriever.retrieve(event);
    expect(ids(candidates)).toContain("oil_cooler_fins_blocked");
    const best = Math.max(...candidates.map((candidate) => candidate.retrieval.text));
    expect(
      candidates.find((candidate) => candidate.fault_id === "oil_cooler_fins_blocked")?.retrieval
        .text,
    ).toBe(best);
  });
});

describe("createCatalogRetriever on the manual's catalog, detection-shaped synthetic events", () => {
  // The calibration events: detection run over frames written from the
  // manual and machine.yaml, never from a scenario, a label or an injection.
  // The manual's fault-finding table is "condition → possible causes", so no
  // possible cause of the condition an event names may be left off while a
  // cause the manual files elsewhere is offered — except the one benign seat
  // retrieval keeps. Before this rule the oil-temperature events offered a
  // blowdown valve, a dryer purge leak or a spent desiccant while the fan, the
  // oil level and the thermostatic valve were left off.
  const retriever = createCatalogRetriever(MAN_CATALOG);
  const leak = downstreamLeak();
  const cooler = oilCoolerByMode();
  const events: readonly (readonly [string, SuspectEvent])[] = [
    ["signature A", signatureA().event],
    ["downstream leak before the switch", leak.beforeSwitch.event],
    ["downstream leak after the switch", leak.afterSwitch.event],
    ["oil cooler, off", cooler.off.event],
    ["oil cooler, unloaded", cooler.unloaded.event],
    ["oil cooler, loaded", cooler.loaded.event],
    ["oil cooler, cold night", coldNightOilCooler().event],
    ["hot room", hotRoom().event],
    ["baseline, busier hour", baselineBusierHour().event],
    ["depot", depot().event],
  ];

  it.each(events)(
    "%s: the condition's causes are offered before any cause filed elsewhere",
    async (_name, event) => {
      const candidates = await retriever.retrieve(event);
      const under = causesUnder(event.symptom_key).map((entry) => entry.fault_id);
      const offered = new Set(ids(candidates));
      const elsewhere = candidates.filter((candidate) => !under.includes(candidate.fault_id));

      expect(under.length).toBeGreaterThan(0);
      if (under.length <= MAX_CANDIDATES - 1) {
        // Room for all of them and a seat to spare: every one is offered.
        expect(under.filter((id) => !offered.has(id))).toEqual([]);
      } else if (under.some((id) => !offered.has(id))) {
        // More than the list holds: whatever else is offered is the benign seat alone.
        expect(elsewhere.length).toBeLessThanOrEqual(1);
        expect(elsewhere.every((candidate) => candidate.benign)).toBe(true);
      }
      expect(ids(candidates).slice(0, candidates.length - elsewhere.length)).toEqual(
        ids(candidates).filter((id) => under.includes(id)),
      );
    },
  );

  it("offers the leak on every downstream-leak event, before and after the switch", async () => {
    for (const event of [leak.beforeSwitch.event, leak.afterSwitch.event]) {
      expect(ids(await retriever.retrieve(event))).toContain("downstream_air_leak");
    }
  });
});

describe("the keyword stand-in reads the move sentences", () => {
  /** An entry's moves, each changed by `change`; the list stays non-empty. */
  function mapMoves(
    entry: CatalogEntry,
    change: (move: SignalMove, index: number) => SignalMove,
  ): CatalogEntry["signal_moves"] {
    const [first, ...rest] = entry.signal_moves;
    return [change(first, 0), ...rest.map((move, index) => change(move, index + 1))];
  }

  const listed = catalogEntry("dryer_purge_leak");
  // The extracted catalog's shape: the sentences on the moves, the list empty.
  const onMoves: CatalogEntry = {
    ...listed,
    signal_moves_text: [],
    signal_moves: mapMoves(listed, (move, index) => ({
      ...move,
      text: listed.signal_moves_text[index] ?? "",
    })),
  };

  it("reads signal_moves_text when the catalog filled it", () => {
    expect(listed.signal_moves_text.length).toBeGreaterThan(0);
    expect(moveSentences(listed)).toBe(listed.signal_moves_text);
  });

  it("falls back to the moves' own text when signal_moves_text is empty", () => {
    expect(moveSentences(onMoves)).toEqual(listed.signal_moves_text);
    const words = lexemes(listed.signal_moves_text.join(" "));
    expect(keywordOverlap(words, onMoves)).toBe(keywordOverlap(words, listed));
  });

  it("has no sentence for moves that carry none", () => {
    const bare: CatalogEntry = {
      ...onMoves,
      signal_moves: mapMoves(listed, (move) => ({ ...move, text: undefined })),
    };
    expect(moveSentences(bare)).toEqual([]);
  });
});

describe("createPgRetriever", () => {
  interface Statement {
    readonly text: string;
    readonly params: readonly unknown[];
  }

  interface CannedRow {
    readonly fault_id: string;
    readonly score: number;
  }

  const TEXT_ROWS: readonly CannedRow[] = [
    { fault_id: "purge_silencer_damaged", score: 0.4 },
    { fault_id: "dryer_purge_leak", score: 0.3 },
  ];
  const VECTOR_ROWS: readonly CannedRow[] = [{ fault_id: "dryer_purge_leak", score: 0.7 }];

  /** A pool that answers each retrieval statement from canned rows and records it. */
  function cannedPool(
    textRows: readonly CannedRow[] = TEXT_ROWS,
    vectorRows: readonly CannedRow[] = VECTOR_ROWS,
  ): { pool: Pool; statements: Statement[] } {
    const statements: Statement[] = [];
    function rowsFor(text: string): unknown[] {
      if (text.includes("information_schema.columns")) return [{ "?column?": 1 }];
      if (text.includes("count(*)")) return [{ chunks: "30" }];
      if (text.includes("websearch_to_tsquery")) return [...textRows];
      if (text.includes("<=>")) return [...vectorRows];
      return [];
    }
    const query = (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      const rows = rowsFor(text);
      return Promise.resolve({ rows, command: "", rowCount: rows.length, oid: 0, fields: [] });
    };
    // The client is an emitter, as node-postgres's is: `withTx` listens on it.
    const client = (): EventEmitter =>
      Object.assign(new EventEmitter(), { query, release: () => undefined });
    const pool = { query, connect: () => Promise.resolve(client()) };
    return { pool: pool as unknown as Pool, statements };
  }

  function fixedLoader(catalog: Catalog): CatalogLoader {
    return { load: () => Promise.resolve(catalog) };
  }

  function recordingEmbedder(): Embedder & { texts: string[] } {
    const texts: string[] = [];
    return {
      texts,
      dimension: 2,
      embed(batch: readonly string[]) {
        texts.push(...batch);
        return Promise.resolve(batch.map(() => Float32Array.from([0.6, 0.8])));
      },
    };
  }

  const active: Catalog = { ...catalogFromEntries(FIXTURE_CATALOG), documentId: 5 };

  it("fuses the catalog match with both database stages", async () => {
    const { pool, statements } = cannedPool();
    const embedder = recordingEmbedder();
    const retriever = createPgRetriever({ pool, embedder, catalogLoader: fixedLoader(active) });

    const candidates = await retriever.retrieve(SIGNATURE_A_EVENT);

    expect(candidates[0]?.fault_id).toBe("dryer_purge_leak");
    expect(candidates[0]?.retrieval.text).toBe(0.3);
    expect(candidates[0]?.retrieval.vector).toBe(0.7);
    expect(candidates.find((c) => c.fault_id === "purge_silencer_damaged")?.retrieval.text).toBe(
      0.4,
    );
    expect(embedder.texts).toHaveLength(1);
    expect(embedder.texts[0]).not.toMatch(/\d/);

    const vectorSearch = statements.find((statement) => statement.text.includes("<=>"));
    expect(vectorSearch?.params).toEqual([5, "[0.6000000238418579,0.800000011920929]", 20]);
    // 30 chunks is far below 5,000: the exact, deterministic search.
    expect(
      statements.some((statement) => statement.text === "SET LOCAL enable_indexscan = off"),
    ).toBe(true);
  });

  it("offers the causes filed under the event's condition first, whatever the database ranks", async () => {
    // Both database stages put two causes the manual files under no condition of
    // the signature-A event (continuous_load, co-symptom purge_pressure_high) on
    // top; the six causes filed under continuous_load still take the six seats.
    const elsewhere = [
      { fault_id: "oil_cooler_fouled", score: 0.9 },
      { fault_id: "oil_level_low", score: 0.8 },
    ];
    const { pool } = cannedPool(elsewhere, elsewhere);
    const retriever = createPgRetriever({
      pool,
      embedder: recordingEmbedder(),
      catalogLoader: fixedLoader(active),
    });
    const underCondition = FIXTURE_CATALOG.filter((item) =>
      item.conditions.some((condition) => condition.condition_id === SIGNATURE_A_EVENT.symptom_key),
    ).map((item) => item.fault_id);

    const candidates = await retriever.retrieve(SIGNATURE_A_EVENT);

    expect(underCondition).toHaveLength(MAX_CANDIDATES);
    expect(new Set(ids(candidates))).toEqual(new Set(underCondition));
    expect(candidates.some((candidate) => candidate.benign)).toBe(true);
  });

  it("resolves the chunk link and the chunk count once per document", async () => {
    const { pool, statements } = cannedPool();
    const retriever = createPgRetriever({
      pool,
      embedder: recordingEmbedder(),
      catalogLoader: fixedLoader(active),
    });

    await retriever.retrieve(SIGNATURE_A_EVENT);
    await retriever.retrieve(FAST_DECAY_EVENT);

    const count = (needle: string): number =>
      statements.filter((statement) => statement.text.includes(needle)).length;
    expect(count("information_schema.columns")).toBe(1);
    expect(count("count(*)")).toBe(1);
    expect(count("websearch_to_tsquery")).toBe(2);
  });

  it("ranks by the catalog alone, without touching the database, when no manual is active", async () => {
    const { pool, statements } = cannedPool();
    const embedder = recordingEmbedder();
    const fixed = { ...catalogFromEntries(FIXTURE_CATALOG), documentId: null };
    const retriever = createPgRetriever({ pool, embedder, catalogLoader: fixedLoader(fixed) });

    const candidates = await retriever.retrieve(SIGNATURE_A_EVENT);

    expect(candidates.length).toBeGreaterThanOrEqual(MIN_CANDIDATES);
    expect(statements).toEqual([]);
    expect(embedder.texts).toEqual([]);
    await expect(
      createPgRetriever({ pool, embedder, catalogLoader: fixedLoader(EMPTY_CATALOG) }).retrieve(
        SIGNATURE_A_EVENT,
      ),
    ).resolves.toEqual([]);
  });

  it("lets a failing stage fail the retrieval rather than shorten the list", async () => {
    const { pool } = cannedPool();
    const broken: Embedder = {
      dimension: 2,
      embed: () => Promise.reject(new Error("the graph could not run")),
    };
    const retriever = createPgRetriever({
      pool,
      embedder: broken,
      catalogLoader: fixedLoader(active),
    });
    const event: SuspectEvent = SIGNATURE_A_EVENT;
    await expect(retriever.retrieve(event)).rejects.toThrow("the graph could not run");
  });
});

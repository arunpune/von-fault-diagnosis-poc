// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The cost ledger against the real schema.
 *
 * The arithmetic exists twice — `computeCost` and the generated `cost_usd` of
 * `app.cost_ledger` — and this file is where the two meet. Three decision
 * messages, one per backend, are built the way the pipeline builds them (the
 * backend's output, the message with its `cost` block, the ledger row out of
 * the message), written as `app_rw`, and the column the database derived is
 * compared with the number the message already carries: as ten-decimal text
 * and as a JavaScript number, with no tolerance. The `api-cost` body the cost
 * panel reads is then validated against its schema.
 *
 * `app.cost_ledger.decision_id` references `app.decisions`, so each ledger row
 * sits on a decision row seeded here with the columns 0006 requires; the
 * decisions repository itself lives in `src/persistence/`.
 */

import { validate } from "@fdp/contracts";
import type { Decision } from "@fdp/contracts";
import { startPostgres, type PgTestStack } from "@fdp/db-migrate/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  candidatesFor,
  FIXTURE_LABELS,
  FIXTURE_SEVERITY_HINTS,
} from "../fixtures/catalog/index.ts";
import {
  FIXTURE_UNIT_ID,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../fixtures/catalog/events.ts";
import { gateThresholds, loadEnv } from "../../src/config/env.ts";
import {
  computeCost,
  COST_DECIMALS,
  costBlock,
  costUnits,
  pricesFor,
  record,
  summaryPrices,
  type CostLedgerRow,
  type Prices,
} from "../../src/cost/index.ts";
import { createCostRepo, MAX_RECENT_ROWS, type CostRepo } from "../../src/cost/repo.ts";
import { createPool, query, queryOne, type Pool, type Queryable } from "../../src/db/pool.ts";
import { toDecisionMessage } from "../../src/decision/message.ts";
import { createRulesBackend } from "../../src/decision/rules/index.ts";
import type {
  DecisionBackendName,
  DecisionInput,
  DecisionOutput,
  DecisionUsage,
} from "../../src/decision/types.ts";

const ENV = loadEnv({ LLM_API_KEY: "sk-test-not-a-key", PRICES_AS_OF: "2026-09-19" });

const EPISODE_ID = "44444444-4444-4444-8444-444444444444";

const INPUT: DecisionInput = {
  event: SIGNATURE_A_EVENT,
  candidates: candidatesFor(SIGNATURE_A_CANDIDATE_IDS),
  unit_id: FIXTURE_UNIT_ID,
};

/** One billed decision of the fixture: which backend, which model, what it reported. */
interface Billed {
  readonly decisionId: string;
  readonly backend: DecisionBackendName;
  readonly model: string;
  readonly usage: DecisionUsage;
  readonly wallTs: string;
}

/** The three hand-worked figures: Jev input only, both LLM prices, rules free. */
const BILLED: readonly Billed[] = [
  {
    decisionId: "55555555-5555-4555-8555-555555555501",
    backend: "jev",
    model: "jev-1.13.0",
    usage: { input_tokens: 1_234, output_tokens: 0 },
    wallTs: "2026-09-22T08:00:01.000Z",
  },
  {
    decisionId: "55555555-5555-4555-8555-555555555502",
    backend: "llm",
    model: "claude-opus-5",
    usage: { input_tokens: 1_000, output_tokens: 200 },
    wallTs: "2026-09-22T08:00:02.000Z",
  },
  {
    decisionId: "55555555-5555-4555-8555-555555555503",
    backend: "rules",
    model: "rules-v1",
    usage: { input_tokens: 0, output_tokens: 0 },
    wallTs: "2026-09-22T08:00:03.000Z",
  },
];

let pg: PgTestStack;
let appPool: Pool;
let repo: CostRepo;
let twin: DecisionOutput;
const messages = new Map<string, Decision>();

/** The cost as `numeric(16,10)` prints it. */
function ledgerText(units: bigint): string {
  return (Number(units) / 10 ** COST_DECIMALS).toFixed(COST_DECIMALS);
}

/** The backend output of one billed decision: the twin's answer under that backend's name. */
function outputFor(billed: Billed): DecisionOutput {
  return { ...twin, backend: billed.backend, model: billed.model, usage: billed.usage };
}

/** The decision message the pipeline would publish, priced the way the pipeline prices it. */
function messageFor(billed: Billed, prices: Prices = pricesFor(ENV, billed.backend)): Decision {
  return toDecisionMessage(outputFor(billed), {
    unit_id: FIXTURE_UNIT_ID,
    decision_id: billed.decisionId,
    episode_id: EPISODE_ID,
    event_id: SIGNATURE_A_EVENT.event_id,
    sim_ts: SIGNATURE_A_EVENT.sim_ts,
    wall_ts: billed.wallTs,
    backend: billed.backend,
    model: billed.model,
    symptom_key: SIGNATURE_A_EVENT.symptom_key,
    candidates: INPUT.candidates,
    gate: {
      ticketMin: gateThresholds(ENV.gate, billed.backend).ticketMinConfidence,
      reviewMin: gateThresholds(ENV.gate, billed.backend).reviewMinConfidence,
    },
    prices: (usage) => costBlock(usage, prices),
  });
}

/** The suspect event and the episode every decision of this file hangs from. */
async function seedEpisode(db: Queryable): Promise<void> {
  const event = SIGNATURE_A_EVENT;
  await query(
    db,
    `INSERT INTO app.suspect_events
            (event_id, unit_id, sim_ts, wall_ts, symptom_key, rule_ids, machine_mode, evidence,
             observations, window_from_sim_ts, window_to_sim_ts, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb)`,
    [
      event.event_id,
      event.unit_id,
      event.sim_ts,
      event.wall_ts,
      event.symptom_key,
      event.rule_ids,
      event.machine_state.mode,
      JSON.stringify(event.evidence),
      JSON.stringify(event.observations),
      event.window.from_sim_ts,
      event.window.to_sim_ts,
      JSON.stringify(event),
    ],
  );
  await query(
    db,
    `INSERT INTO app.episodes
            (episode_id, unit_id, symptom_key, status, opened_sim_ts, last_event_sim_ts,
             first_event_id)
     VALUES ($1, $2, $3, 'open', $4, $4, $5)`,
    [EPISODE_ID, event.unit_id, event.symptom_key, event.sim_ts, event.event_id],
  );
}

/** The `app.decisions` row a ledger row points at, from the message and the output. */
async function seedDecision(db: Queryable, message: Decision, output: DecisionOutput) {
  await query(
    db,
    `INSERT INTO app.decisions
            (decision_id, episode_id, event_id, unit_id, sim_ts, wall_ts, backend, model, status,
             choice, confidence, probabilities, severity_level, severity_score,
             severity_confidence, gate_outcome, state, state_digest, input_tokens, output_tokens,
             message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
             $17::jsonb, $18, $19, $20, $21::jsonb)`,
    [
      message.decision_id,
      message.episode_id,
      message.event_id,
      message.unit_id,
      message.sim_ts,
      message.wall_ts,
      message.backend,
      message.model,
      message.status,
      message.choice,
      message.confidence,
      JSON.stringify(message.probabilities),
      message.severity.level,
      message.severity.score,
      message.severity.confidence,
      message.gate.outcome,
      JSON.stringify(output.state),
      message.state_digest,
      message.usage.input_tokens,
      message.usage.output_tokens,
      JSON.stringify(message),
    ],
  );
}

/** The row `record` makes of a message; every message here is an answered one. */
function rowOf(message: Decision): CostLedgerRow {
  const row = record(message);
  if (row === null) throw new Error(`decision ${message.decision_id} bills nothing`);
  return row;
}

/** What the database generated for one decision, as the column prints it. */
async function storedCost(db: Queryable, decisionId: string): Promise<string | undefined> {
  const row = await queryOne<{ cost_usd: string }>(
    db,
    "SELECT cost_usd::text AS cost_usd FROM app.cost_ledger WHERE decision_id = $1",
    [decisionId],
  );
  return row?.cost_usd;
}

beforeAll(async () => {
  pg = await startPostgres({ migrate: true });
  appPool = createPool(pg.urlFor("app_rw"), { applicationName: "fdp-backend-cost" });
  repo = createCostRepo(appPool, summaryPrices(ENV));
  twin = await createRulesBackend({
    severityHints: FIXTURE_SEVERITY_HINTS,
    labels: FIXTURE_LABELS,
  }).decide(INPUT);

  await seedEpisode(appPool);
  for (const billed of BILLED) {
    const message = messageFor(billed);
    messages.set(billed.decisionId, message);
    await seedDecision(appPool, message, outputFor(billed));
  }
});

afterAll(async () => {
  await appPool?.end().catch(() => undefined);
  await pg?.stop();
});

describe("the generated cost_usd", () => {
  it.each(BILLED.map((billed) => [billed.backend, billed] as const))(
    "equals computeCost and the message's cost block for the %s decision",
    async (_backend, billed) => {
      const message = messages.get(billed.decisionId);
      if (message === undefined) throw new Error("the message was not seeded");
      const prices = pricesFor(ENV, billed.backend);

      const generated = await repo.insert(rowOf(message));

      expect(generated).toBe(computeCost(billed.usage, prices));
      expect(generated).toBe(message.cost.usd);
      expect(await storedCost(appPool, billed.decisionId)).toBe(
        ledgerText(costUnits(billed.usage, prices)),
      );
    },
  );

  it("holds the three hand-worked figures exactly", async () => {
    expect(await storedCost(appPool, BILLED[0]?.decisionId ?? "")).toBe("0.0000518280");
    expect(await storedCost(appPool, BILLED[1]?.decisionId ?? "")).toBe("0.0100000000");
    expect(await storedCost(appPool, BILLED[2]?.decisionId ?? "")).toBe("0.0000000000");
  });

  it("bills a decision once: a replayed message inserts nothing", async () => {
    const message = messages.get(BILLED[0]?.decisionId ?? "");
    if (message === undefined) throw new Error("the message was not seeded");
    expect(await repo.insert(rowOf(message))).toBeNull();
    expect((await repo.totals()).calls).toBe(BILLED.length);
  });

  it("is the database's to write: app_rw cannot supply one", async () => {
    await expect(
      query(
        appPool,
        `INSERT INTO app.cost_ledger
                (decision_id, backend, model, input_tokens, price_input_per_mtok, prices_as_of,
                 cost_usd)
         VALUES ($1, 'jev', 'jev-1.13.0', 1, 0.042, '2026-09-19', 1)`,
        [BILLED[0]?.decisionId],
      ),
    ).rejects.toMatchObject({ code: "428C9" });
  });

  it("rounds the eleventh decimal the way computeCost does", async () => {
    // Inside a transaction that is rolled back, so the summary below never sees it.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      const edges: readonly [string, number][] = [
        ["55555555-5555-4555-8555-555555555591", 0.00005],
        ["55555555-5555-4555-8555-555555555592", 0.000049],
        ["55555555-5555-4555-8555-555555555593", 0.00015],
      ];
      const inTx = createCostRepo(client, summaryPrices(ENV));
      for (const [decisionId, price] of edges) {
        const billed: Billed = {
          decisionId,
          backend: "llm",
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 0 },
          wallTs: "2026-09-22T08:00:09.000Z",
        };
        const prices: Prices = { ...pricesFor(ENV, "llm"), price_input_per_mtok: price };
        const message = messageFor(billed, prices);
        await seedDecision(client, message, outputFor(billed));

        expect(await inTx.insert(rowOf(message))).toBe(computeCost(billed.usage, prices));
        expect(await storedCost(client, decisionId)).toBe(
          ledgerText(costUnits(billed.usage, prices)),
        );
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("summary()", () => {
  it("validates against api-cost", async () => {
    const summary = await repo.summary();
    const result = validate("api-cost", summary);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("totals every billed row, as numbers", async () => {
    const { totals } = await repo.summary();
    const expected = BILLED.reduce(
      (sum, billed) => sum + costUnits(billed.usage, pricesFor(ENV, billed.backend)),
      0n,
    );

    expect(totals.calls).toBe(3);
    expect(totals.input_tokens).toBe(2_234);
    expect(totals.output_tokens).toBe(200);
    expect(totals.usd).toBe(Number(expected) / 10 ** COST_DECIMALS);
    expect(await repo.totalUsd()).toBe(totals.usd);
  });

  it("breaks the totals down per backend from app.v_cost_totals", async () => {
    const { by_backend: byBackend } = await repo.summary();

    expect(Object.keys(byBackend).sort()).toEqual(["jev", "llm", "rules"]);
    expect(byBackend["jev"]).toEqual({
      model: "jev-1.13.0",
      usd: 0.000051828,
      calls: 1,
      input_tokens: 1_234,
      output_tokens: 0,
    });
    expect(byBackend["llm"]).toEqual({
      model: "claude-opus-5",
      usd: 0.01,
      calls: 1,
      input_tokens: 1_000,
      output_tokens: 200,
    });
    expect(byBackend["rules"]?.usd).toBe(0);
  });

  it("carries the day series, the configured prices and the newest rows first", async () => {
    const summary = await repo.summary();

    expect(summary.by_day).toEqual([{ day_wall: "2026-09-22", usd: summary.totals.usd }]);
    expect(summary.prices).toEqual({
      jev_input_per_mtok: 0.042,
      llm_input_per_mtok: 5,
      llm_output_per_mtok: 25,
      as_of: "2026-09-19",
    });
    expect(summary.recent.map((row) => row.backend)).toEqual(["rules", "llm", "jev"]);
    expect(summary.recent.length).toBeLessThanOrEqual(MAX_RECENT_ROWS);
    expect(summary.recent[2]).toEqual({
      decision_id: BILLED[0]?.decisionId,
      backend: "jev",
      model: "jev-1.13.0",
      input_tokens: 1_234,
      output_tokens: 0,
      cost_usd: 0.000051828,
      wall_ts: "2026-09-22T08:00:01.000Z",
      sim_ts: SIGNATURE_A_EVENT.sim_ts,
    });
  });
});

describe("ledger()", () => {
  it("returns the newest rows first, with the dated prices they were billed at", async () => {
    const { items } = await repo.ledger(2);

    expect(items.map((item) => item.backend)).toEqual(["rules", "llm"]);
    expect(items[1]).toEqual({
      decision_id: BILLED[1]?.decisionId,
      backend: "llm",
      model: "claude-opus-5",
      input_tokens: 1_000,
      output_tokens: 200,
      cost_usd: 0.01,
      wall_ts: "2026-09-22T08:00:02.000Z",
      sim_ts: SIGNATURE_A_EVENT.sim_ts,
      price_input_per_mtok: 5,
      price_output_per_mtok: 25,
      prices_as_of: "2026-09-19",
    });
  });

  it("returns every row when not asked for fewer", async () => {
    expect((await repo.ledger()).items).toHaveLength(3);
  });
});

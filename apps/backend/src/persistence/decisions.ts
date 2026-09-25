// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `app.decisions` and `app.decision_candidates`, written and read as `app_rw`.
 *
 * A decision row holds three things the broker never sees: the `state` the
 * backend was shown, and the provider's `request` and `response` bodies
 * (without headers, so without keys). Everything
 * else is the `decision` message, once as columns a query can filter and
 * aggregate and once whole in `message`, which is what the reads hand back.
 *
 * The candidate rows keep what the message cannot: the support of a backend
 * whose per-candidate figure is not a Noul (the rules twin's match scores)
 * and the retrieval stage scores that put a
 * cause in the list. {@link candidateRows} assembles them from what the
 * runtime has in hand after a decision.
 */

import type { Decision, ManualReference } from "@fdp/contracts";

import { query, queryOne, withTx, type Pool } from "../db/pool.ts";
import type { Candidate, RetrievalScores } from "../retrieval/types.ts";
import { clampLimit, CURSOR_TS_SQL, pageParams, toPage, type KeyedRow } from "./cursor.ts";
import { isUuid, jsonb, jsonbOrNull } from "./sql.ts";
import type {
  DecisionCandidateRow,
  DecisionListQuery,
  DecisionsRepo,
  StoredDecision,
} from "./types.ts";

const INSERT = `
INSERT INTO app.decisions
       (decision_id, episode_id, event_id, unit_id, sim_ts, wall_ts, backend, model, status,
        choice, confidence, probabilities, support, severity_level, severity_score,
        severity_probabilities, severity_confidence, gate_outcome, abstained, candidates,
        state, state_digest, request, response, request_id, rationale,
        input_tokens, output_tokens, latency_ms, error, message)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9,
        $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, $17, $18, $19, $20::jsonb,
        $21::jsonb, $22, $23::jsonb, $24::jsonb, $25, $26,
        $27::integer, $28::integer, $29::integer, $30::jsonb, $31::jsonb)
ON CONFLICT (decision_id) DO NOTHING`;

// One JSON document for the whole list, unpacked by the server: the statement
// keeps one parameter whatever the number of candidates, and no value is ever
// spliced into the text. `retrieval` is NOT NULL with `{}` as its default, so a
// candidate whose stage scores are unknown is stored as that default and read
// back as `null` (the runtime's decision outputs carry no stage scores).
const INSERT_CANDIDATES = `
INSERT INTO app.decision_candidates
       (decision_id, rank, fault_id, condition_id, name, probability, support, benign,
        manual_ref, retrieval)
SELECT $1::uuid, c.rank, c.fault_id, c.condition_id, c.name, c.probability, c.support, c.benign,
       c.manual_ref, coalesce(c.retrieval, '{}'::jsonb)
  FROM jsonb_to_recordset($2::jsonb)
       AS c(rank integer, fault_id text, condition_id text, name text, probability real,
            support real, benign boolean, manual_ref jsonb, retrieval jsonb)
ON CONFLICT (decision_id, fault_id) DO NOTHING`;

const CANDIDATES = `
SELECT fault_id, condition_id, name, probability, support, benign, manual_ref,
       nullif(retrieval, '{}'::jsonb) AS retrieval
  FROM app.decision_candidates
 WHERE decision_id = $1::uuid
 ORDER BY rank, fault_id`;

// `$3` and `$4` are the key of the previous page's last row, both NULL on the
// first page; the plain `sim_ts <=` bound lets the planner use the
// `(unit_id, sim_ts DESC)` and `(episode_id, sim_ts DESC)` indexes.
const LIST = `
SELECT id::text AS cursor_id, ${CURSOR_TS_SQL} AS cursor_ts, message
  FROM app.decisions
 WHERE unit_id = $1
   AND ($2::uuid IS NULL OR episode_id = $2::uuid)
   AND ($3::timestamptz IS NULL
        OR (sim_ts <= $3::timestamptz AND (sim_ts, id) < ($3::timestamptz, $4::bigint)))
 ORDER BY sim_ts DESC, id DESC
 LIMIT $5::integer`;

const GET = "SELECT message FROM app.decisions WHERE decision_id = $1::uuid";

const GET_WITH_STATE = "SELECT message, state FROM app.decisions WHERE decision_id = $1::uuid";

type DecisionRecord = KeyedRow & { message: Decision };

type CandidateRecord = {
  fault_id: string;
  condition_id: string;
  name: string;
  probability: number;
  support: number | null;
  benign: boolean;
  manual_ref: ManualReference;
  retrieval: RetrievalScores | null;
};

/** The `jsonb_to_recordset` document of one candidate list. */
function candidateDocument(candidates: readonly DecisionCandidateRow[]): string {
  return jsonb(
    candidates.map((candidate, index) => ({
      rank: index + 1,
      fault_id: candidate.fault_id,
      condition_id: candidate.condition_id,
      name: candidate.name,
      probability: candidate.probability,
      support: candidate.support,
      benign: candidate.benign,
      manual_ref: candidate.manual_ref,
      retrieval: candidate.retrieval,
    })),
  );
}

/** What {@link candidateRows} joins the message's candidates with. */
export interface CandidateSources {
  /**
   * The backend's own per-candidate figure (`DecisionOutput.support`), which
   * for the rules twin never reaches the message. The message's `support`
   * fills in for a candidate this map does not name.
   */
  readonly support?: Readonly<Record<string, number | null>>;
  /** What retrieval offered, for the stage scores of each candidate. */
  readonly retrieved?: readonly Candidate[];
}

/**
 * The `app.decision_candidates` rows of one decision, in the message's order.
 *
 * The message fixes the list, the ranks and each candidate's condition and
 * probability; the sources add what it leaves out.
 */
export function candidateRows(
  message: Decision,
  sources: CandidateSources = {},
): DecisionCandidateRow[] {
  const retrieval = new Map(
    (sources.retrieved ?? []).map((candidate) => [candidate.fault_id, candidate.retrieval]),
  );
  return message.candidates.map((candidate) => ({
    fault_id: candidate.fault_id,
    condition_id: candidate.condition_id,
    name: candidate.name,
    probability: candidate.probability,
    support: sources.support?.[candidate.fault_id] ?? message.support[candidate.fault_id] ?? null,
    benign: candidate.benign,
    manual_ref: candidate.manual_ref,
    retrieval: retrieval.get(candidate.fault_id) ?? null,
  }));
}

/** The decision statements of one unit over one `app_rw` pool. */
export function createDecisionsRepo(pool: Pool, unitId: string): DecisionsRepo {
  return {
    async insert(message, state, request, response) {
      const result = await withTx(pool, (client) =>
        client.query(INSERT, [
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
          jsonb(message.probabilities),
          jsonb(message.support),
          message.severity.level,
          message.severity.score,
          jsonb(message.severity.probabilities),
          message.severity.confidence,
          message.gate.outcome,
          message.gate.abstained,
          jsonb(message.candidates),
          jsonb(state),
          message.state_digest,
          jsonbOrNull(request),
          jsonbOrNull(response),
          message.request_id ?? null,
          message.rationale ?? null,
          message.usage.input_tokens,
          message.usage.output_tokens,
          message.latency_ms,
          jsonbOrNull(message.error),
          jsonb(message),
        ]),
      );
      return (result.rowCount ?? 0) === 1;
    },

    async insertCandidates(decisionId, candidates) {
      if (candidates.length === 0) return 0;
      const result = await withTx(pool, (client) =>
        client.query(INSERT_CANDIDATES, [decisionId, candidateDocument(candidates)]),
      );
      return result.rowCount ?? 0;
    },

    async candidates(decisionId) {
      if (!isUuid(decisionId)) return [];
      return query<CandidateRecord>(pool, CANDIDATES, [decisionId]);
    },

    async list(request: DecisionListQuery = {}) {
      const limit = clampLimit(request.limit);
      const bounds = pageParams(request.before, limit);
      const episodeId = request.episode_id;
      if (episodeId !== undefined && !isUuid(episodeId)) return { items: [], next_cursor: null };
      const rows = await query<DecisionRecord>(pool, LIST, [unitId, episodeId ?? null, ...bounds]);
      return toPage(rows, limit, (row) => row.message);
    },

    async get(decisionId, options = {}): Promise<StoredDecision | undefined> {
      if (!isUuid(decisionId)) return undefined;
      if (options.withState === true) {
        const row = await queryOne<{ message: Decision; state: unknown }>(pool, GET_WITH_STATE, [
          decisionId,
        ]);
        return row === undefined ? undefined : { ...row.message, state: row.state };
      }
      const row = await queryOne<{ message: Decision }>(pool, GET, [decisionId]);
      return row?.message;
    },
  };
}

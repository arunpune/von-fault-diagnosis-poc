// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The decision repository and its candidate-row builder over a recording pool
// double. The statements run against the schema in
// test/integration/persistence.test.ts.

import type { Decision } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { candidatesFor } from "../../test/fixtures/catalog/index.ts";
import { answered, failed } from "../episodes/decisions.test-helper.ts";
import { InvalidCursorError } from "./cursor.ts";
import { candidateRows, createDecisionsRepo } from "./decisions.ts";
import { fakePool, texts } from "./fake-pool.test-helper.ts";

const UNIT = "cau-7";
const CANDIDATES = candidatesFor(SIGNATURE_A_CANDIDATE_IDS);
const EPISODE_ID = "0000000e-0000-4000-8000-000000000001";
const DECISION_ID = "0000000d-0000-4000-8000-000000000001";

function decision(): Decision {
  return answered({
    event: SIGNATURE_A_EVENT,
    candidates: CANDIDATES,
    episodeId: EPISODE_ID,
    decisionId: DECISION_ID,
    choice: "dryer_purge_leak",
    confidence: 0.9,
  }).decision;
}

describe("candidateRows", () => {
  it("keeps the message's order, condition and probability, and adds the sources", () => {
    const message = decision();
    const support = Object.fromEntries(CANDIDATES.map((c, index) => [c.fault_id, index / 10]));

    const rows = candidateRows(message, { support, retrieved: CANDIDATES });

    expect(rows.map((row) => row.fault_id)).toEqual(SIGNATURE_A_CANDIDATE_IDS);
    expect(rows[0]).toEqual({
      fault_id: "dryer_purge_leak",
      condition_id: message.candidates[0]!.condition_id,
      name: message.candidates[0]!.name,
      probability: 0.9,
      support: 0,
      benign: message.candidates[0]!.benign,
      manual_ref: message.candidates[0]!.manual_ref,
      retrieval: CANDIDATES[0]!.retrieval,
    });
    expect(rows[3]?.support).toBe(0.3);
  });

  it("falls back to the message's support, then to null, and to no retrieval scores", () => {
    const message = { ...decision(), support: { dryer_purge_leak: 0.7 } };

    const rows = candidateRows(message, { support: { dryer_purge_leak: null } });

    expect(rows[0]).toMatchObject({ support: 0.7, retrieval: null });
    expect(rows[1]).toMatchObject({ support: null, retrieval: null });
  });

  it("has no rows for a failed call, which offers no candidates", () => {
    const message = failed({
      event: SIGNATURE_A_EVENT,
      candidates: CANDIDATES,
      episodeId: EPISODE_ID,
      decisionId: DECISION_ID,
    });
    expect(candidateRows(message, { retrieved: CANDIDATES })).toEqual([]);
  });
});

describe("createDecisionsRepo().insert", () => {
  it("writes the message, the state and the provider bodies inside one transaction", async () => {
    const fake = fakePool(() => ({ rowCount: 1 }));
    const message = decision();
    const state = { observations: ["purge pressure far above normal"] };

    await expect(
      createDecisionsRepo(fake.pool, UNIT).insert(message, state, { questions: {} }, undefined),
    ).resolves.toBe(true);

    expect(texts(fake.statements)).toEqual(["BEGIN", "INSERT INTO app.decisions", "COMMIT"]);
    expect(fake.released()).toBe(1);
    const params = fake.statements[1]!.params;
    expect(fake.statements[1]!.text).not.toContain(DECISION_ID);
    expect(params.slice(0, 3)).toEqual([DECISION_ID, EPISODE_ID, SIGNATURE_A_EVENT.event_id]);
    expect(JSON.parse(params[20] as string)).toEqual(state);
    expect(JSON.parse(params[22] as string)).toEqual({ questions: {} });
    expect(params[23]).toBeNull();
    expect(params[29]).toBeNull();
    expect(JSON.parse(params[30] as string)).toEqual(message);
  });

  it("keeps a failed call's error and records a missing state as the JSON null", async () => {
    const fake = fakePool(() => ({ rowCount: 0 }));
    const message = failed({
      event: SIGNATURE_A_EVENT,
      candidates: CANDIDATES,
      episodeId: EPISODE_ID,
      decisionId: DECISION_ID,
    });

    await expect(createDecisionsRepo(fake.pool, UNIT).insert(message, undefined)).resolves.toBe(
      false,
    );

    const params = fake.statements[1]!.params;
    expect(params[20]).toBe("null");
    expect(JSON.parse(params[29] as string)).toEqual(message.error);
  });
});

describe("createDecisionsRepo().insertCandidates", () => {
  it("sends the list as one JSON document with ranks from 1", async () => {
    const fake = fakePool(() => ({ rowCount: CANDIDATES.length }));
    const rows = candidateRows(decision(), { retrieved: CANDIDATES });

    await expect(
      createDecisionsRepo(fake.pool, UNIT).insertCandidates(DECISION_ID, rows),
    ).resolves.toBe(CANDIDATES.length);

    expect(texts(fake.statements)).toEqual([
      "BEGIN",
      "INSERT INTO app.decision_candidates",
      "COMMIT",
    ]);
    const [decisionId, document] = fake.statements[1]!.params;
    expect(decisionId).toBe(DECISION_ID);
    const sent = JSON.parse(document as string) as { rank: number; fault_id: string }[];
    expect(sent.map((row) => [row.rank, row.fault_id])).toEqual(
      SIGNATURE_A_CANDIDATE_IDS.map((faultId, index) => [index + 1, faultId]),
    );
  });

  it("sends nothing for an empty list", async () => {
    const fake = fakePool();
    await expect(
      createDecisionsRepo(fake.pool, UNIT).insertCandidates(DECISION_ID, []),
    ).resolves.toBe(0);
    expect(fake.statements).toEqual([]);
  });
});

describe("createDecisionsRepo() reads", () => {
  it("adds the stored state to the message only when asked", async () => {
    const message = decision();
    const state = { candidates: [] };
    const fake = fakePool((text) => ({
      rows: [text.includes("state") ? { message, state } : { message }],
    }));
    const repo = createDecisionsRepo(fake.pool, UNIT);

    await expect(repo.get(DECISION_ID)).resolves.toEqual(message);
    await expect(repo.get(DECISION_ID, { withState: true })).resolves.toEqual({
      ...message,
      state,
    });
    expect(fake.statements.map((statement) => statement.params)).toEqual([
      [DECISION_ID],
      [DECISION_ID],
    ]);
  });

  it("answers an id that is not a UUID with nothing, without a statement", async () => {
    const fake = fakePool();
    const repo = createDecisionsRepo(fake.pool, UNIT);

    await expect(repo.get("not-a-uuid")).resolves.toBeUndefined();
    await expect(repo.candidates("42")).resolves.toEqual([]);
    await expect(repo.list({ episode_id: "episode-1" })).resolves.toEqual({
      items: [],
      next_cursor: null,
    });
    expect(fake.statements).toEqual([]);
  });

  it("narrows the page to an episode and refuses a foreign cursor", async () => {
    const fake = fakePool(() => ({ rows: [] }));
    const repo = createDecisionsRepo(fake.pool, UNIT);

    await expect(repo.list({ episode_id: EPISODE_ID, limit: 10 })).resolves.toEqual({
      items: [],
      next_cursor: null,
    });
    expect(fake.statements[0]!.params).toEqual([UNIT, EPISODE_ID, null, null, 11]);
    await expect(repo.list({ before: "%%%" })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

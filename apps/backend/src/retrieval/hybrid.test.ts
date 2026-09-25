// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The fusion and the database stages' plumbing.
 *
 * `rrf` is checked on hand-made lists whose fused order can be worked out on
 * paper. The two SQL stages run against pgvector in
 * `test/integration/retrieval.test.ts`; here a recording pool pins what only
 * a unit test can see cheaply: the exact-search switch lives inside the
 * stage's own transaction, and a database without init's `0008` column is
 * never asked for it.
 */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { Pool, Queryable } from "../db/pool.ts";
import {
  RRF_K,
  detectChunkLink,
  fullTextQuery,
  rankedIds,
  rrf,
  searchFullText,
  searchVector,
} from "./hybrid.ts";

describe("rrf", () => {
  it("adds 1 / (k + rank) from every list an id appears in", () => {
    const fused = rrf([["a", "b", "c"], ["b", "c"], ["c"]]);
    expect(fused.map((entry) => entry.fault_id)).toEqual(["c", "b", "a"]);
    expect(fused[0]?.rrf).toBeCloseTo(1 / 63 + 1 / 62 + 1 / 61, 15);
    expect(fused[1]?.rrf).toBeCloseTo(1 / 62 + 1 / 61, 15);
    expect(fused[2]?.rrf).toBeCloseTo(1 / 61, 15);
  });

  it("ranks an id that is second everywhere above one that is first once", () => {
    const fused = rrf([
      ["a", "b"],
      ["c", "b"],
      ["d", "b"],
    ]);
    expect(fused[0]?.fault_id).toBe("b");
    expect(fused.slice(1).map((entry) => entry.fault_id)).toEqual(["a", "c", "d"]);
  });

  it("breaks a tie by fault_id ascending, whatever order the lists came in", () => {
    expect(rrf([["zeta"], ["alpha"], ["mu"]]).map((entry) => entry.fault_id)).toEqual([
      "alpha",
      "mu",
      "zeta",
    ]);
    expect(rrf([["mu"], ["zeta"], ["alpha"]]).map((entry) => entry.fault_id)).toEqual([
      "alpha",
      "mu",
      "zeta",
    ]);
  });

  it("uses k = 60 unless told otherwise", () => {
    expect(RRF_K).toBe(60);
    expect(rrf([["x"]], 0)[0]?.rrf).toBe(1);
    expect(rrf([])).toEqual([]);
    expect(rrf([[], []])).toEqual([]);
  });
});

describe("rankedIds", () => {
  it("orders a stage's scores into the list the fusion reads, zeros dropped", () => {
    expect(
      rankedIds([
        { fault_id: "b", score: 0.4 },
        { fault_id: "a", score: 0.4 },
        { fault_id: "c", score: 0.9 },
        { fault_id: "d", score: 0 },
        { fault_id: "e", score: -0.1 },
      ]),
    ).toEqual(["c", "a", "b"]);
  });
});

describe("fullTextQuery", () => {
  it("asks websearch_to_tsquery for any of the words, each once", () => {
    expect(fullTextQuery("Dryer purge pressure high; purge line (P) sags")).toBe(
      "dryer or purge or pressure or high or line or sags",
    );
  });

  it("cannot be turned into a phrase, a negation or a stray operator", () => {
    expect(fullTextQuery(`"stays loaded" -cut-out OR or AND`)).toBe(
      "stays or loaded or cut or out or and",
    );
    expect(fullTextQuery("  (  ) . ")).toBe("");
  });
});

interface Recorded {
  text: string;
  params: unknown[];
}

/**
 * A pool whose one client records every statement and answers with `rows`.
 *
 * The client is an emitter, as node-postgres's is: `withTx` listens on it for
 * the server ending the connection while the transaction holds it.
 */
function recordingPool(rows: unknown[] = []): { pool: Pool; statements: Recorded[] } {
  const statements: Recorded[] = [];
  const client = Object.assign(new EventEmitter(), {
    query(text: string, params: unknown[] = []) {
      statements.push({ text, params });
      return Promise.resolve({ rows, command: "", rowCount: rows.length, oid: 0, fields: [] });
    },
    release() {},
  });
  const pool = { connect: () => Promise.resolve(client), query: client.query };
  return { pool: pool as unknown as Pool, statements };
}

describe("searchVector", () => {
  const vector = "[0.1,0.2]";

  it("turns index scans off inside its own transaction when asked for an exact search", async () => {
    const { pool, statements } = recordingPool([{ fault_id: "dryer_purge_leak", score: "0.8" }]);
    const found = await searchVector(pool, { documentId: 4, link: "fault_id" }, vector, {
      exact: true,
    });

    expect(found).toEqual([{ fault_id: "dryer_purge_leak", score: 0.8 }]);
    expect(statements.map((statement) => statement.text.trim().split(/\s+/)[0])).toEqual([
      "BEGIN",
      "SET",
      "WITH",
      "COMMIT",
    ]);
    expect(statements[1]?.text).toBe("SET LOCAL enable_indexscan = off");
    expect(statements[2]?.params).toEqual([4, vector, 20]);
  });

  it("leaves the planner alone for a large document", async () => {
    const { pool, statements } = recordingPool();
    await searchVector(pool, { documentId: 4, link: "fault_id" }, vector, { exact: false });
    expect(statements.some((statement) => statement.text.startsWith("SET"))).toBe(false);
  });

  it("never names chunks.fault_id on a database that predates init's 0008", async () => {
    const { pool, statements } = recordingPool();
    await searchVector(pool, { documentId: 4, link: "section_ref" }, vector, { exact: true });
    const search = statements.find((statement) => statement.text.includes("<=>"));
    expect(search?.text).not.toContain("ch.fault_id");
    expect(search?.text).toContain("ch.section_ref");
  });
});

describe("searchFullText", () => {
  function recordingDb(): Queryable & { statements: Recorded[] } {
    const statements: Recorded[] = [];
    return {
      statements,
      query(text: string, params: unknown[] = []) {
        statements.push({ text, params });
        return Promise.resolve({ rows: [], command: "", rowCount: 0, oid: 0, fields: [] } as never);
      },
    };
  }

  it("sends the any-word query, scoped to the document", async () => {
    const db = recordingDb();
    await searchFullText(db, { documentId: 9, link: "fault_id" }, "Purge pressure high", 20);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.params).toEqual([9, "purge or pressure or high", 20]);
    expect(db.statements[0]?.text).toContain("websearch_to_tsquery('english', $2)");
  });

  it("does not query at all when the sentence holds no word", async () => {
    const db = recordingDb();
    await expect(
      searchFullText(db, { documentId: 9, link: "fault_id" }, " . ", 20),
    ).resolves.toEqual([]);
    expect(db.statements).toHaveLength(0);
  });
});

describe("detectChunkLink", () => {
  function answering(rows: unknown[]): Queryable {
    return {
      query: () =>
        Promise.resolve({ rows, command: "", rowCount: rows.length, oid: 0, fields: [] } as never),
    };
  }

  it("maps through chunks.fault_id when init's column exists, through sections otherwise", async () => {
    await expect(detectChunkLink(answering([{ "?column?": 1 }]))).resolves.toBe("fault_id");
    await expect(detectChunkLink(answering([]))).resolves.toBe("section_ref");
  });
});

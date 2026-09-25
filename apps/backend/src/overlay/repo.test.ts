// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The statements of the overlay repository, against a recording `Queryable`.
// `test/integration/overlay.test.ts` runs the same statements on the real
// schema; this file pins the parameters, the dedupe answer and the way a
// `timestamptz` comes back as an `iso_ts` string.

import { describe, expect, it } from "vitest";

import type { Queryable } from "../db/pool.ts";
import { catalogDigest, createOverlayRepo } from "./repo.ts";
import {
  gtCatalog,
  gtInjectionStart,
  gtInjectionStop,
  gtMarker,
} from "../../test/helpers/overlay.ts";

interface Call {
  text: string;
  params: unknown[];
}

/** A queryable that records every statement and answers with `rows`. */
function recorder(rows: unknown[][] = []): Queryable & { calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  return {
    calls,
    query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      const answer = rows[index] ?? [];
      index += 1;
      return Promise.resolve({
        rows: answer,
        command: "",
        rowCount: answer.length,
        oid: 0,
        fields: [],
      } as never);
    },
  };
}

describe("catalogDigest", () => {
  it("deduplicates on the digest the simulator published", () => {
    const catalog = gtCatalog();
    expect(catalogDigest(catalog)).toBe(catalog.source_sha256);
  });

  it("falls back to the digest of the message when there is none", () => {
    const withoutDigest = gtCatalog();
    delete withoutDigest.source_sha256;
    const digest = catalogDigest(withoutDigest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(gtCatalog().source_sha256);
  });
});

describe("writes", () => {
  it("inserts a catalog and reports whether the row was new", async () => {
    const db = recorder([[{ id: "1" }], []]);
    const repo = createOverlayRepo(db);
    const catalog = gtCatalog();

    await expect(repo.recordCatalog(catalog)).resolves.toBe(true);
    await expect(repo.recordCatalog(catalog)).resolves.toBe(false);

    const [first] = db.calls;
    expect(first?.text).toContain("gt.catalog_snapshot");
    expect(first?.text).toContain("ON CONFLICT (payload_sha256) DO NOTHING");
    expect(first?.params).toEqual([
      catalog.unit_id,
      catalog.wall_ts,
      catalog.source_sha256,
      catalog,
    ]);
  });

  it("inserts an injection event on the columns of migration 0002", async () => {
    const db = recorder([[{ id: "1" }]]);
    const message = gtInjectionStop();

    await expect(createOverlayRepo(db).recordInjection(message)).resolves.toBe(true);

    const [call] = db.calls;
    expect(call?.text).toContain("ON CONFLICT (unit_id, instance_id, event) DO NOTHING");
    expect(call?.params).toEqual([
      message.unit_id,
      message.instance_id,
      message.injection_id,
      message.fault_id,
      "stop",
      message.sim_ts,
      message.wall_ts,
      message.params,
      message.ends_sim_ts,
      "cleared",
    ]);
  });

  it("stores no reason for a start, which carries none", async () => {
    const db = recorder([[{ id: "1" }]]);
    await createOverlayRepo(db).recordInjection(gtInjectionStart());
    expect(db.calls[0]?.params.at(-1)).toBeNull();
  });

  it("stores a marker with a null preset when the jump named an instant", async () => {
    const db = recorder();
    const marker = gtMarker();
    delete marker.preset_id;
    await createOverlayRepo(db).recordMarker(marker);
    expect(db.calls[0]?.text).toContain("gt.markers");
    expect(db.calls[0]?.params).toEqual([
      marker.unit_id,
      "jump",
      null,
      marker.sim_ts_from,
      marker.sim_ts_to,
      marker.wall_ts,
    ]);
  });
});

describe("reads", () => {
  it("passes both bounds and turns the timestamps back into iso_ts", async () => {
    const db = recorder([
      [
        {
          unit_id: "cau-7",
          instance_id: "inj-7f3a-1",
          injection_id: "oil_cooler_fouling",
          fault_id: "oil_cooler_fouled",
          start_sim_ts: new Date("2020-02-01T04:00:00.000Z"),
          end_sim_ts: new Date("2020-02-01T06:12:30.000Z"),
          reason: "cleared",
          params: { magnitude: 1, duration_sim_min: 600 },
        },
      ],
    ]);

    const windows = await createOverlayRepo(db).injectionWindows("cau-7", {
      from: "2020-02-01T00:00:00.000Z",
      to: "2020-02-02T00:00:00.000Z",
    });

    expect(db.calls[0]?.text).toContain("gt.v_injection_windows");
    expect(db.calls[0]?.params).toEqual([
      "cau-7",
      "2020-02-01T00:00:00.000Z",
      "2020-02-02T00:00:00.000Z",
    ]);
    expect(windows[0]).toEqual({
      unit_id: "cau-7",
      instance_id: "inj-7f3a-1",
      injection_id: "oil_cooler_fouling",
      fault_id: "oil_cooler_fouled",
      start_sim_ts: "2020-02-01T04:00:00.000Z",
      end_sim_ts: "2020-02-01T06:12:30.000Z",
      reason: "cleared",
      params: { magnitude: 1, duration_sim_min: 600 },
    });
  });

  it("sends a null bound for an unbounded window", async () => {
    const db = recorder();
    await createOverlayRepo(db).markers("cau-7");
    expect(db.calls[0]?.params).toEqual(["cau-7", null, null]);
  });

  it("keeps an unfinished window open rather than inventing an end", async () => {
    const db = recorder([
      [
        {
          unit_id: "cau-7",
          instance_id: "inj-7f3a-2",
          injection_id: "oil_cooler_fouling",
          fault_id: "oil_cooler_fouled",
          start_sim_ts: new Date("2020-02-01T04:00:00.000Z"),
          end_sim_ts: null,
          reason: null,
          params: null,
        },
      ],
    ]);
    const [window] = await createOverlayRepo(db).injectionWindows("cau-7");
    expect(window?.end_sim_ts).toBeNull();
    expect(window?.params).toEqual({});
  });

  it("refuses a marker row whose kind the CHECK constraint should have refused", async () => {
    const db = recorder([
      [
        {
          unit_id: "cau-7",
          kind: "inject",
          preset_id: null,
          sim_ts_from: new Date("2020-02-01T04:00:00.000Z"),
          sim_ts_to: new Date("2020-06-05T06:00:00.000Z"),
          wall_ts: new Date("2026-06-05T09:41:12.000Z"),
        },
      ],
    ]);
    await expect(createOverlayRepo(db).markers("cau-7")).rejects.toThrow(/unknown kind: inject/);
  });
});

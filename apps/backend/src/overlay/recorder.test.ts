// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder against the two doubles of `test/helpers/overlay.ts`: what it
// subscribes, what it stores, what it keeps in memory, what it forwards to the
// hub, and the three things it must survive — a redelivery, an invalid payload
// and a failing write.

import { topics } from "@fdp/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../log.ts";
import { createRecorder, type OverlayFrame, type OverlayRecorder } from "./recorder.ts";
import {
  fakeOpsClient,
  fakeOverlayRepo,
  gtActive,
  gtCatalog,
  gtInjectionStart,
  gtInjectionStop,
  gtMarker,
  type FakeOpsClient,
  type FakeOverlayRepo,
} from "../../test/helpers/overlay.ts";

const UNIT = "cau-7";
const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

let ops: FakeOpsClient;
let repo: FakeOverlayRepo;
let frames: OverlayFrame[];
let recorder: OverlayRecorder;

beforeEach(async () => {
  ops = fakeOpsClient();
  repo = fakeOverlayRepo();
  frames = [];
  recorder = createRecorder({
    ops,
    repo,
    logger,
    unitId: UNIT,
    hub: {
      publish: (frame) => frames.push(frame),
    },
  });
  await recorder.start();
});

describe("start", () => {
  it("subscribes the four overlay topics and nothing else", () => {
    expect(ops.subscribed).toEqual([
      topics.gtCatalog(UNIT),
      topics.gtInjection(UNIT),
      topics.gtInjectionActive(UNIT),
      topics.gtMarker(UNIT),
    ]);
  });
});

describe("the retained messages", () => {
  it("has neither before the simulator published one", () => {
    expect(recorder.catalog()).toBeNull();
    expect(recorder.active()).toBeNull();
  });

  it("keeps the newest catalog and active list in memory", async () => {
    const catalog = gtCatalog();
    const active = gtActive();
    await ops.deliver(topics.gtCatalog(UNIT), catalog);
    await ops.deliver(topics.gtInjectionActive(UNIT), active);

    expect(recorder.catalog()).toEqual(catalog);
    expect(recorder.active()).toEqual(active);
    expect(frames.map((frame) => frame.type)).toEqual([
      "overlay.catalog",
      "overlay.injection_active",
    ]);
  });

  it("records a catalog once, however often it is redelivered", async () => {
    const catalog = gtCatalog();
    await ops.deliver(topics.gtCatalog(UNIT), catalog);
    await ops.deliver(topics.gtCatalog(UNIT), { ...catalog, wall_ts: "2026-06-05T10:00:00.000Z" });

    expect(repo.catalogs.size).toBe(1);
    expect(recorder.counters().catalog).toMatchObject({ received: 2, stored: 1, duplicates: 1 });
  });

  it("does not store the active list: it is a snapshot of rows it already holds", async () => {
    await ops.deliver(topics.gtInjectionActive(UNIT), gtActive());
    expect(repo.injections.size).toBe(0);
    expect(recorder.counters().injection_active).toMatchObject({ received: 1, stored: 0 });
  });
});

describe("injections", () => {
  it("stores a start and its stop as two rows", async () => {
    await ops.deliver(topics.gtInjection(UNIT), gtInjectionStart());
    await ops.deliver(topics.gtInjection(UNIT), gtInjectionStop());

    expect([...repo.injections.keys()]).toEqual([
      "cau-7/inj-7f3a-1/start",
      "cau-7/inj-7f3a-1/stop",
    ]);
    expect(recorder.counters().injection).toMatchObject({ received: 2, stored: 2, duplicates: 0 });
  });

  it("absorbs a repeated start on the injection key", async () => {
    await ops.deliver(topics.gtInjection(UNIT), gtInjectionStart());
    await ops.deliver(topics.gtInjection(UNIT), gtInjectionStart());

    expect(repo.injections.size).toBe(1);
    expect(recorder.counters().injection).toMatchObject({ received: 2, stored: 1, duplicates: 1 });
  });

  it("pairs a stop with its own instance, not with another one", async () => {
    const second = { ...gtInjectionStart(), instance_id: "inj-7f3a-2" };
    await ops.deliver(topics.gtInjection(UNIT), gtInjectionStart());
    await ops.deliver(topics.gtInjection(UNIT), second);
    await ops.deliver(topics.gtInjection(UNIT), gtInjectionStop());

    const windows = await repo.injectionWindows(UNIT);
    expect(windows).toHaveLength(2);
    expect(windows.find((window) => window.instance_id === "inj-7f3a-1")).toMatchObject({
      end_sim_ts: "2020-02-01T06:12:30.000Z",
      reason: "cleared",
    });
    expect(windows.find((window) => window.instance_id === "inj-7f3a-2")).toMatchObject({
      end_sim_ts: "2020-02-01T14:00:00.000Z",
      reason: null,
    });
  });
});

describe("markers", () => {
  it("stores every marker: a marker has no natural key", async () => {
    await ops.deliver(topics.gtMarker(UNIT), gtMarker());
    await ops.deliver(topics.gtMarker(UNIT), gtMarker());

    expect(repo.markerRows).toHaveLength(2);
    expect(recorder.counters().marker).toMatchObject({ received: 2, stored: 2 });
    expect(frames.map((frame) => frame.type)).toEqual(["overlay.marker", "overlay.marker"]);
  });
});

describe("what it survives", () => {
  it("drops a payload that does not match its schema, and counts it", async () => {
    await ops.deliver(topics.gtInjection(UNIT), { ...gtInjectionStart(), event: "pause" });

    expect(repo.injections.size).toBe(0);
    expect(frames).toEqual([]);
    expect(recorder.counters().injection).toMatchObject({ received: 0, invalid: 1 });
  });

  it("counts a failing write instead of throwing into the broker adapter", async () => {
    repo.failWrites();
    await expect(ops.deliver(topics.gtMarker(UNIT), gtMarker())).resolves.toBeUndefined();
    expect(repo.markerRows).toEqual([]);
    expect(recorder.counters().marker).toMatchObject({ received: 1, stored: 0, failed: 1 });
  });

  it("still shows the catalog it could not store, so the screen stays live", async () => {
    repo.failWrites();
    await ops.deliver(topics.gtCatalog(UNIT), gtCatalog());
    expect(recorder.catalog()).not.toBeNull();
    expect(frames.map((frame) => frame.type)).toEqual(["overlay.catalog"]);
    expect(recorder.counters().catalog).toMatchObject({ stored: 0, failed: 1 });
  });
});

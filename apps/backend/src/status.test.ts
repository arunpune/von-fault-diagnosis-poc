// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The retained status-backend publisher: once at start, every
// 5 s after that, and within 200 ms of a change — never early for a message
// that says what the last one said. Vitest's fake timers drive the cadence, so
// no test waits for a real second, and every message is checked against the
// contract.

import { validate, type StatusBackend } from "@fdp/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixedClock } from "./clock.ts";
import { sequentialIds } from "./episodes/decisions.test-helper.ts";
import { createHeartbeat } from "./heartbeat/index.ts";
import {
  buildStatusBackend,
  createStatusPublisher,
  STATUS_DEBOUNCE_MS,
  STATUS_INTERVAL_MS,
  type StatusInfo,
} from "./status.ts";

const INFO: StatusInfo = { unitId: "cau-7", backend: "von", model: "von-1.13.0", version: "1.0.0" };

function harness() {
  const wall = fixedClock("2026-09-22T10:00:00.000Z");
  const heartbeat = createHeartbeat({
    wall,
    timeouts: { telemetryS: 15, decisionS: 60 },
    sink: { alert: () => undefined, heartbeat: () => undefined },
    unitId: "cau-7",
    ids: sequentialIds(7),
  });
  const counts = { episodes: 0, tickets: 0 };
  const published: StatusBackend[] = [];
  const publisher = createStatusPublisher({
    publish: (message) => published.push(message),
    wall,
    info: INFO,
    sources: {
      heartbeat: () => heartbeat.snapshot(),
      episodesOpen: () => counts.episodes,
      ticketsOpen: () => counts.tickets,
    },
  });
  return { wall, heartbeat, counts, published, publisher };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createStatusPublisher", () => {
  it("publishes at start and then every 5 s", () => {
    const { published, publisher } = harness();
    publisher.start();
    publisher.start();
    expect(published).toHaveLength(1);

    vi.advanceTimersByTime(STATUS_INTERVAL_MS - 1);
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(published).toHaveLength(2);
    vi.advanceTimersByTime(3 * STATUS_INTERVAL_MS);
    expect(published).toHaveLength(5);
    publisher.stop();
  });

  it("publishes a change 200 ms after it is noticed, folding a burst into one message", () => {
    const { counts, heartbeat, published, publisher } = harness();
    publisher.start();

    counts.episodes = 1;
    publisher.notify();
    vi.advanceTimersByTime(100);
    counts.tickets = 1;
    heartbeat.noteDecisionOk();
    publisher.notify();
    vi.advanceTimersByTime(STATUS_DEBOUNCE_MS - 101);
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({
      episodes_open: 1,
      tickets_open: 1,
      decision: { total: 1, ok: 1, failed: 0, consecutive_errors: 0 },
    });
    publisher.stop();
  });

  it("does not publish early when nothing it reports has changed", () => {
    const { wall, published, publisher } = harness();
    publisher.start();

    wall.advance(1_000);
    publisher.notify();
    vi.advanceTimersByTime(STATUS_DEBOUNCE_MS * 5);

    expect(published).toHaveLength(1);
    publisher.stop();
  });

  it("reports a raised watchdog on the next message", () => {
    const { heartbeat, published, publisher } = harness();
    publisher.start();

    heartbeat.noteDecisionError();
    heartbeat.noteDecisionError();
    heartbeat.noteDecisionError();
    publisher.notify();
    vi.advanceTimersByTime(STATUS_DEBOUNCE_MS);

    expect(published.at(-1)?.heartbeat).toEqual({
      telemetry_silent: false,
      decision_api_silent: true,
    });
    expect(published.at(-1)?.decision).toMatchObject({ failed: 3, consecutive_errors: 3 });
    publisher.stop();
  });

  it("publishes nothing before start and nothing after stop", () => {
    const { counts, published, publisher } = harness();
    counts.episodes = 2;
    publisher.notify();
    vi.advanceTimersByTime(STATUS_INTERVAL_MS);
    expect(published).toEqual([]);

    publisher.start();
    counts.episodes = 3;
    publisher.notify();
    publisher.stop();
    vi.advanceTimersByTime(3 * STATUS_INTERVAL_MS);
    expect(published).toHaveLength(1);
  });

  it("builds messages that validate against status-backend", () => {
    const { counts, heartbeat, published, publisher } = harness();
    publisher.start();
    heartbeat.noteDecisionError();
    counts.tickets = 4;
    publisher.notify();
    vi.advanceTimersByTime(STATUS_INTERVAL_MS);
    publisher.stop();

    for (const message of [...published, publisher.current()]) {
      const result = validate("status-backend", message);
      expect(result.ok ? [] : result.errors.map((issue) => issue.text)).toEqual([]);
    }
    expect(published[0]).toEqual({
      schema: "urn:fdp:schema:status-backend:v1",
      unit_id: "cau-7",
      wall_ts: "2026-09-22T10:00:00.000Z",
      backend: { name: "von", model: "von-1.13.0" },
      decision: {
        total: 0,
        ok: 0,
        failed: 0,
        consecutive_errors: 0,
        last_ok_wall_ts: null,
        last_error_wall_ts: null,
      },
      heartbeat: { telemetry_silent: false, decision_api_silent: false },
      episodes_open: 0,
      tickets_open: 0,
      version: "1.0.0",
    });
  });

  it("refuses to build a message a source made off-contract", () => {
    const { heartbeat } = harness();
    const sources = {
      heartbeat: () => heartbeat.snapshot(),
      episodesOpen: () => -1,
      ticketsOpen: () => 0,
    };

    expect(() => buildStatusBackend(INFO, sources, "2026-09-22T10:00:00.000Z")).toThrow(
      /status-backend/,
    );
  });
});

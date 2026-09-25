// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Overlay messages and overlay test doubles.
 *
 * The messages come from `@fdp/contracts`' own fixture folders rather than
 * from literals written here: the contract is the file, and a schema change
 * that the fixtures follow must reach these tests too.
 *
 * The two doubles are the ports the overlay takes. {@link fakeOpsClient} is a
 * broker with no socket — a test publishes into it with `deliver` — and
 * {@link fakeOverlayRepo} is the overlay schema with no database, keeping the
 * two unique keys of the `gt` schema so that a redelivered message behaves
 * the way PostgreSQL would.
 */

import { fixturesFor } from "@fdp/contracts/testing";
import type {
  ActiveFaultInjections,
  ControlAck,
  FaultInjectionEvent,
  GroundTruthCatalog,
  ReplayMarker,
  SchemaName,
} from "@fdp/contracts";

import type { MessageHandler } from "../../src/mqtt/client.ts";
import { topicMatches } from "../../src/mqtt/client.ts";
import type { OpsClient } from "../../src/mqtt/ops-client.ts";
import type { InjectionWindow, Marker, OverlayRepo, SimRange } from "../../src/overlay/repo.ts";

/** One `valid-*.json` fixture of a schema, by file name. */
export function contractFixture<T>(schema: string, file: string): T {
  const found = fixturesFor(schema).valid.find((fixture) => fixture.file === file);
  if (found === undefined) throw new Error(`@fdp/contracts has no ${schema}/${file}`);
  // A fresh copy per call: the tests mutate envelopes to build variants.
  return structuredClone(found.data) as T;
}

export const gtCatalog = (): GroundTruthCatalog =>
  contractFixture<GroundTruthCatalog>("gt-catalog", "valid-full.json");

export const gtInjectionStart = (): FaultInjectionEvent =>
  contractFixture<FaultInjectionEvent>("gt-injection", "valid-start.json");

export const gtInjectionStop = (): FaultInjectionEvent =>
  contractFixture<FaultInjectionEvent>("gt-injection", "valid-stop-cleared.json");

export const gtActive = (): ActiveFaultInjections =>
  contractFixture<ActiveFaultInjections>("gt-injection-active", "valid-one-running.json");

export const gtMarker = (): ReplayMarker =>
  contractFixture<ReplayMarker>("gt-marker", "valid-jump-preset.json");

/** The acknowledgement the simulator would send for one command. */
export function controlAckFor(cmdId: string, cmd: ControlAck["cmd"] = "jump"): ControlAck {
  const ack = contractFixture<ControlAck>("control-ack", "valid-ok.json");
  return { ...ack, cmd_id: cmdId, cmd };
}

/** One publication the double recorded. */
export interface PublishedMessage {
  readonly schema: SchemaName;
  readonly topic: string;
  readonly payload: unknown;
  readonly retain: boolean;
}

export interface FakeOpsClient extends OpsClient {
  /** Hand a payload to every handler whose filter matches `topic`. */
  deliver(topic: string, payload: unknown): Promise<void>;
  /** What the code under test published, in order. */
  readonly published: PublishedMessage[];
  /** The filters it subscribed to, in order. */
  readonly subscribed: string[];
  /** Make the next publication fail, the way a closed broker connection does. */
  failNextPublish(error?: Error): void;
  /** Report the connection as down. */
  setConnected(value: boolean): void;
}

/** A broker client with no socket. Publications are recorded, not sent. */
export function fakeOpsClient(): FakeOpsClient {
  const handlers = new Map<string, MessageHandler>();
  const published: PublishedMessage[] = [];
  const subscribed: string[] = [];
  let connected = true;
  let nextPublishError: Error | null = null;

  return {
    published,
    subscribed,
    connected: () => connected,

    setConnected(value) {
      connected = value;
    },

    failNextPublish(error = new Error("the broker connection is closed")) {
      nextPublishError = error;
    },

    subscribeValidated(filter, handler) {
      handlers.set(filter, handler);
      subscribed.push(filter);
      return Promise.resolve();
    },

    publishJson(schema, topic, payload, options) {
      if (nextPublishError !== null) {
        const error = nextPublishError;
        nextPublishError = null;
        return Promise.reject(error);
      }
      published.push({ schema, topic, payload, retain: options?.retain ?? false });
      return Promise.resolve();
    },

    async deliver(topic, payload) {
      for (const [filter, handler] of handlers) {
        if (topicMatches(filter, topic)) await handler({ topic, payload });
      }
    },

    close: () => Promise.resolve(),
  };
}

export interface FakeOverlayRepo extends OverlayRepo {
  /** The catalogs stored, by the digest they were deduplicated on. */
  readonly catalogs: Map<string, GroundTruthCatalog>;
  /** The injection events stored, keyed `unit_id/instance_id/event`. */
  readonly injections: Map<string, FaultInjectionEvent>;
  readonly markerRows: ReplayMarker[];
  /** Make every following write throw, the way a lost pool does. */
  failWrites(error?: Error): void;
}

/**
 * The overlay schema in memory, with its two unique keys.
 *
 * The dedupe digest mirrors `catalogDigest`, but is spelled out here rather
 * than imported: a double that shared the production rule would agree with it
 * by construction, and then the recorder's dedupe test would prove nothing.
 */
export function fakeOverlayRepo(): FakeOverlayRepo {
  const catalogs = new Map<string, GroundTruthCatalog>();
  const injections = new Map<string, FaultInjectionEvent>();
  const markerRows: ReplayMarker[] = [];
  let writeError: Error | null = null;

  const guard = (): void => {
    if (writeError !== null) throw writeError;
  };

  return {
    catalogs,
    injections,
    markerRows,

    failWrites(error = new Error("the overlay pool is gone")) {
      writeError = error;
    },

    recordCatalog(message) {
      guard();
      const key = message.source_sha256 ?? JSON.stringify(message);
      if (catalogs.has(key)) return Promise.resolve(false);
      catalogs.set(key, message);
      return Promise.resolve(true);
    },

    recordInjection(message) {
      guard();
      const key = `${message.unit_id}/${message.instance_id}/${message.event}`;
      if (injections.has(key)) return Promise.resolve(false);
      injections.set(key, message);
      return Promise.resolve(true);
    },

    recordMarker(message) {
      guard();
      markerRows.push(message);
      return Promise.resolve();
    },

    injectionWindows(unitId, range = {}) {
      const windows: InjectionWindow[] = [];
      for (const start of injections.values()) {
        if (start.unit_id !== unitId || start.event !== "start") continue;
        const stop = injections.get(`${unitId}/${start.instance_id}/stop`);
        const end = stop?.sim_ts ?? start.ends_sim_ts;
        if (!overlaps(start.sim_ts, end, range)) continue;
        windows.push({
          unit_id: start.unit_id,
          instance_id: start.instance_id,
          injection_id: start.injection_id,
          fault_id: start.fault_id,
          start_sim_ts: start.sim_ts,
          end_sim_ts: end,
          reason: stop?.reason ?? null,
          params: { ...start.params },
        });
      }
      windows.sort((left, right) => left.start_sim_ts.localeCompare(right.start_sim_ts));
      return Promise.resolve(windows);
    },

    markers(unitId, range = {}) {
      const rows: Marker[] = markerRows
        .filter((row) => row.unit_id === unitId && overlaps(row.sim_ts_from, row.sim_ts_to, range))
        .map((row) => ({
          unit_id: row.unit_id,
          kind: row.kind,
          preset_id: row.preset_id ?? null,
          sim_ts_from: row.sim_ts_from,
          sim_ts_to: row.sim_ts_to,
          wall_ts: row.wall_ts,
        }));
      return Promise.resolve(rows);
    },
  };
}

/** The same overlap test the two read statements run, on `iso_ts` strings. */
function overlaps(from: string, to: string | null, range: SimRange): boolean {
  if (range.from != null && to !== null && to < range.from) return false;
  if (range.to != null && from > range.to) return false;
  return true;
}

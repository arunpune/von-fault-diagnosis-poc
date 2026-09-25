// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ground-truth recorder.
 *
 * It subscribes the four overlay topics on the privileged broker client,
 * validates every payload against the schema its topic declares, keeps the two
 * retained messages in memory for the read routes, writes the durable ones
 * through {@link OverlayRepo} and forwards a frame to the WebSocket hub so the
 * user interface can draw the overlay live.
 *
 * Three properties the callers rely on:
 *
 *   * **it never throws into the broker adapter.** A payload that does not
 *     validate is counted and dropped with one warning line, and so is a
 *     failing write: an overlay that cannot record is a degraded overlay, not a
 *     dead connection. The live view is served first for the same reason — a
 *     database hiccup must not blank the operator's screen — so a frame goes
 *     out and the counters say what was not stored.
 *   * **a redelivery is not a second row.** The retained catalog and active
 *     list arrive again on every reconnect, and the simulator may repeat an
 *     injection event; the repository's keys absorb both and the counters say
 *     how often it happened.
 *   * **the hub is optional.** Without one the recorder runs with the port
 *     left out and the frames are simply not sent.
 */

import {
  validate,
  type ActiveFaultInjections,
  type FaultInjectionEvent,
  type GroundTruthCatalog,
  type ReplayMarker,
  type SchemaName,
  type SchemaType,
} from "@fdp/contracts";

import type { Logger } from "../log.ts";
import type { MessageHandler } from "../mqtt/client.ts";
import { opsTopics, type OpsClient } from "../mqtt/ops-client.ts";
import type { OverlayRepo } from "./repo.ts";

/** The four frames the hub sends to the user interface. */
export type OverlayFrame =
  | { readonly type: "overlay.catalog"; readonly payload: GroundTruthCatalog }
  | { readonly type: "overlay.injection"; readonly payload: FaultInjectionEvent }
  | { readonly type: "overlay.injection_active"; readonly payload: ActiveFaultInjections }
  | { readonly type: "overlay.marker"; readonly payload: ReplayMarker };

/** The hub port the WebSocket hub implements; the recorder only ever pushes into it. */
export interface OverlayHub {
  publish(frame: OverlayFrame): void;
}

/** How many messages of one kind the recorder saw, stored and had to drop. */
export interface RecorderCounters {
  /** Payloads that validated and were handled. */
  readonly received: number;
  /** Rows written. */
  readonly stored: number;
  /** Messages the database already held. */
  readonly duplicates: number;
  /** Payloads that did not match their schema. */
  readonly invalid: number;
  /** Handled messages whose write failed. */
  readonly failed: number;
}

/** The counter keys, one per subscribed topic. */
export const RECORDER_KINDS = ["catalog", "injection", "injection_active", "marker"] as const;

export type RecorderKind = (typeof RECORDER_KINDS)[number];

export interface RecorderPorts {
  readonly ops: OpsClient;
  readonly repo: OverlayRepo;
  readonly logger: Logger;
  /** The WebSocket hub; the recorder runs without one. */
  readonly hub?: OverlayHub;
  /** The unit whose overlay this process records; the contracts' default otherwise. */
  readonly unitId?: string;
}

export interface OverlayRecorder {
  /** Subscribe the four topics. The retained two arrive right after SUBACK. */
  start(): Promise<void>;
  /** The newest catalog, or null before the simulator published one. */
  catalog(): GroundTruthCatalog | null;
  /** The newest active list, or null before the simulator published one. */
  active(): ActiveFaultInjections | null;
  /** Counters per kind, for `/api/health` and for the tests. */
  counters(): Readonly<Record<RecorderKind, RecorderCounters>>;
}

interface MutableCounters {
  received: number;
  stored: number;
  duplicates: number;
  invalid: number;
  failed: number;
}

function emptyCounters(): MutableCounters {
  return { received: 0, stored: 0, duplicates: 0, invalid: 0, failed: 0 };
}

export function createRecorder(ports: RecorderPorts): OverlayRecorder {
  const topics = opsTopics(ports.unitId);
  const logger = ports.logger.child({ module: "overlay-recorder" });
  const counters: Record<RecorderKind, MutableCounters> = {
    catalog: emptyCounters(),
    injection: emptyCounters(),
    injection_active: emptyCounters(),
    marker: emptyCounters(),
  };

  let latestCatalog: GroundTruthCatalog | null = null;
  let latestActive: ActiveFaultInjections | null = null;

  /**
   * Validate one payload, count it, and hand it to `handle`.
   *
   * The broker adapter validates against the topic's schema before a handler
   * sees anything; this second pass is what makes the recorder safe to drive
   * from a test double, and it is what types the payload for the handler.
   */
  function on<N extends SchemaName>(
    kind: RecorderKind,
    schema: N,
    handle: (message: SchemaType<N>) => void | Promise<void>,
  ): MessageHandler {
    return async ({ payload }) => {
      const tally = counters[kind];
      const result = validate(schema, payload);
      if (!result.ok) {
        tally.invalid += 1;
        logger.warn(
          { kind, issue: result.errors[0]?.text ?? "invalid", invalid_total: tally.invalid },
          "dropped an invalid overlay message",
        );
        return;
      }
      tally.received += 1;
      try {
        await handle(result.value);
      } catch (error) {
        tally.failed += 1;
        logger.error({ kind, err: error, failed_total: tally.failed }, "an overlay write failed");
      }
    };
  }

  /** Count a write, and say once when the database already held the row. */
  function tally(kind: RecorderKind, inserted: boolean, key: string): void {
    const counter = counters[kind];
    if (inserted) {
      counter.stored += 1;
      return;
    }
    counter.duplicates += 1;
    logger.debug(
      { kind, key, duplicates_total: counter.duplicates },
      "the overlay already holds this message",
    );
  }

  const publish = (frame: OverlayFrame): void => {
    ports.hub?.publish(frame);
  };

  return {
    async start() {
      await ports.ops.subscribeValidated(
        topics.catalog,
        on("catalog", "gt-catalog", async (message) => {
          latestCatalog = message;
          publish({ type: "overlay.catalog", payload: message });
          tally("catalog", await ports.repo.recordCatalog(message), message.unit_id);
        }),
      );

      await ports.ops.subscribeValidated(
        topics.injection,
        on("injection", "gt-injection", async (message) => {
          publish({ type: "overlay.injection", payload: message });
          const inserted = await ports.repo.recordInjection(message);
          tally("injection", inserted, `${message.instance_id}/${message.event}`);
        }),
      );

      await ports.ops.subscribeValidated(
        topics.injectionActive,
        on("injection_active", "gt-injection-active", (message) => {
          latestActive = message;
          publish({ type: "overlay.injection_active", payload: message });
        }),
      );

      await ports.ops.subscribeValidated(
        topics.marker,
        // A marker has no natural key, so every message that arrives is a row.
        on("marker", "gt-marker", async (message) => {
          publish({ type: "overlay.marker", payload: message });
          await ports.repo.recordMarker(message);
          tally("marker", true, message.kind);
        }),
      );

      logger.info({ unit_id: ports.unitId ?? null }, "recording the overlay");
    },

    catalog: () => latestCatalog,
    active: () => latestActive,

    counters() {
      return {
        catalog: { ...counters.catalog },
        injection: { ...counters.injection },
        injection_active: { ...counters.injection_active },
        marker: { ...counters.marker },
      };
    },
  };
}

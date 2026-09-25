// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The telemetry path of the running service.
 *
 * One batch off the broker is, in order: noted by the telemetry watchdog (the
 * broker is delivering, whatever the batch holds), pushed through the pipeline
 * (ingest, detection, retrieval, the decision, the gate, episodes and
 * tickets), handed to the WebSocket hub for the charts, and its outputs
 * written, published and broadcast by the sinks. Batches are processed one
 * after the other in arrival order, and so is a technician's ticket close,
 * which rides the same queue: the rows the sinks write reference each other,
 * so a close must never overtake the decision that opened its ticket.
 *
 * The pipeline awaits every decision before it looks at the next sample, so a
 * slow decision service makes the queue grow rather than the history skip
 * ahead; the queue length is on `/api/health`.
 *
 * A one-second timer drives what runs on wall time: the heartbeat's tick, the
 * aggregate write when ingest's policy says it is due (five seconds or five
 * hundred rows) and the retention run every ten minutes.
 */

import type { Sample, TelemetrySamples, Ticket } from "@fdp/contracts";

import type { Heartbeat } from "../heartbeat/index.ts";
import type { Logger } from "../log.ts";
import type { Pipeline } from "../pipeline/types.ts";
import type { TicketVerdict } from "../tickets/index.ts";
import type { Hub } from "../ws/hub.ts";
import { createSerialQueue } from "./serial.ts";
import type { OutputSink } from "./sinks.ts";

/** How often the wall-time work runs: the heartbeat's one second. */
export const TICK_INTERVAL_MS = 1_000;

export interface TelemetryRuntimePorts {
  readonly pipeline: Pick<Pipeline, "push" | "closeTicket" | "ingest">;
  readonly sink: Pick<OutputSink, "write">;
  readonly hub: Pick<Hub, "pushSamples">;
  readonly watchdog: Pick<Heartbeat, "noteSample" | "tick">;
  readonly logger: Logger;
  /** Defaults to {@link TICK_INTERVAL_MS}. */
  readonly tickIntervalMs?: number;
}

/** What the telemetry path has done, for `/api/health`. */
export interface TelemetryCounters {
  /** Batches the pipeline took. */
  readonly batches: number;
  /** Samples handed to the hub, repeats excluded. */
  readonly samples: number;
  /** Batches the pipeline rejected with an error. */
  readonly failed: number;
  /** Batches that arrived after `stop` and were not processed. */
  readonly refused: number;
  /** Batches and closes waiting in the queue right now. */
  readonly queued: number;
  /** Aggregate writes and retention runs that failed. */
  readonly storageErrors: number;
}

export interface TelemetryRuntime {
  /** One validated batch off the broker; resolves once it has been fully handled. */
  onBatch(batch: TelemetrySamples): Promise<void>;
  /**
   * A technician's verdict, queued behind the telemetry before it.
   *
   * @throws UnknownTicketError, TicketClosedError — the pipeline's own.
   */
  closeTicket(ticketId: string, verdict: TicketVerdict): Promise<Ticket>;
  /** The wall-time work: heartbeat tick, aggregate write when due, retention when due. */
  tick(): Promise<void>;
  /** Start the one-second timer; a second call does nothing. */
  start(): void;
  /** Stop the timer, refuse new batches, finish the queued work and write the open minute. */
  stop(): Promise<void>;
  counters(): TelemetryCounters;
}

/**
 * The samples of `batch` ingest takes, given the last `seq` it took before.
 *
 * The rule is ingest's own: a sample whose `seq` is not past
 * the last accepted one is a re-delivery, unless it carries the
 * discontinuity flag, which is how a restarted simulator counting from 1 again
 * is told from a repeat. The hub is fed the same samples detection saw, so a
 * redelivered batch does not draw a line backwards on the chart.
 */
export function freshSamples(samples: readonly Sample[], lastSeq: number | undefined): Sample[] {
  const fresh: Sample[] = [];
  let last = lastSeq;
  for (const sample of samples) {
    if (!sample.flags.discontinuity && last !== undefined && sample.seq <= last) continue;
    fresh.push(sample);
    last = sample.seq;
  }
  return fresh;
}

export function createTelemetryRuntime(ports: TelemetryRuntimePorts): TelemetryRuntime {
  const { pipeline, sink, hub, watchdog } = ports;
  const logger = ports.logger.child({ module: "telemetry" });
  const queue = createSerialQueue();

  let batches = 0;
  let samples = 0;
  let failed = 0;
  let refused = 0;
  let storageErrors = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The aggregate write or retention run in progress; at most one at a time. */
  let storing: Promise<void> | undefined;

  async function handle(batch: TelemetrySamples): Promise<void> {
    const lastSeq = pipeline.ingest.latest()?.seq;
    let outputs;
    try {
      outputs = await pipeline.push(batch);
    } catch (error: unknown) {
      // A rejected push changed no episode and no ticket, so there is nothing
      // of it to write: dropping it keeps the tables
      // and the pipeline's store in step. A failed retrieval or decision call
      // does not land here; it is a failed decision among the outputs.
      failed += 1;
      logger.error({ err: error, failed }, "the pipeline rejected a telemetry batch");
      return;
    }
    batches += 1;
    const fresh = freshSamples(batch.samples, lastSeq);
    if (fresh.length > 0) {
      samples += fresh.length;
      hub.pushSamples(fresh);
    }
    await sink.write(outputs);
  }

  /** Write the folded minutes and, every ten minutes, drop the expired ones. */
  async function store(final: boolean): Promise<void> {
    const ingest = pipeline.ingest;
    try {
      if (final || ingest.flushDue()) await ingest.flush({ final });
      if (!final && ingest.pruneDue()) {
        const removed = await ingest.prune();
        if (removed > 0) logger.info({ removed }, "pruned expired telemetry aggregates");
      }
    } catch (error: unknown) {
      storageErrors += 1;
      logger.error({ err: error, storage_errors: storageErrors }, "could not store aggregates");
    }
  }

  /** The write in progress, or a new one; a slow database never stacks them up. */
  function storeOnce(final: boolean): Promise<void> {
    storing ??= store(final).finally(() => {
      storing = undefined;
    });
    return storing;
  }

  const runtime: TelemetryRuntime = {
    async onBatch(batch) {
      if (stopped) {
        refused += 1;
        return;
      }
      watchdog.noteSample();
      await queue.run(() => handle(batch));
    },

    closeTicket(ticketId, verdict) {
      return queue.run(async () => {
        const outputs = await pipeline.closeTicket(ticketId, verdict);
        await sink.write(outputs);
        const [closed] = outputs;
        if (closed?.type !== "ticket") {
          throw new Error(`closing ticket ${ticketId} produced no ticket message`);
        }
        return closed.ticket;
      });
    },

    async tick() {
      watchdog.tick();
      await storeOnce(false);
    },

    start() {
      if (timer !== undefined || stopped) return;
      timer = setInterval(() => {
        void runtime.tick();
      }, ports.tickIntervalMs ?? TICK_INTERVAL_MS);
      timer.unref();
    },

    async stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await queue.idle();
      if (storing !== undefined) await storing;
      await store(true);
    },

    counters: () => ({
      batches,
      samples,
      failed,
      refused,
      queued: queue.pending(),
      storageErrors,
    }),
  };
  return runtime;
}

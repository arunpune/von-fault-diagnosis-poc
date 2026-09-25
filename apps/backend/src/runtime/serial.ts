// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-at-a-time execution for the runtime's writers.
 *
 * The broker hands the runtime its messages without waiting for the previous
 * handler to finish, and the rows the sinks write reference each other — a
 * decision its episode and its event, a ticket its latest decision — so the
 * work of one batch must be finished before the next one starts. A queue does
 * that without a lock: every task starts when the one before it settled.
 */

/** Runs tasks in the order they were queued, each after the previous one settled. */
export interface SerialQueue {
  /** Queue `task`; the returned promise settles as the task does. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves once every task queued so far has settled. */
  idle(): Promise<void>;
  /** Tasks queued and not yet settled. */
  pending(): number;
}

/**
 * A fresh queue.
 *
 * A task that fails rejects its own caller and leaves the queue running, so
 * one malformed batch does not stall the batches behind it.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      pending += 1;
      const result = tail.then(task).finally(() => {
        pending -= 1;
      });
      tail = result.catch(() => undefined);
      return result;
    },

    async idle(): Promise<void> {
      await tail;
    },

    pending: () => pending,
  };
}

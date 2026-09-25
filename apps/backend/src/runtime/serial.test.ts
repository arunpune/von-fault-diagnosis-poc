// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSerialQueue } from "./serial.ts";

/** A promise the test settles by hand. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("createSerialQueue", () => {
  it("starts each task only after the one before it settled", async () => {
    const queue = createSerialQueue();
    const first = deferred();
    const order: string[] = [];

    const a = queue.run(async () => {
      order.push("a start");
      await first.promise;
      order.push("a end");
    });
    const b = queue.run(async () => {
      order.push("b");
      return 2;
    });

    await Promise.resolve();
    expect(order).toEqual(["a start"]);
    expect(queue.pending()).toBe(2);

    first.resolve();
    await expect(b).resolves.toBe(2);
    await a;
    expect(order).toEqual(["a start", "a end", "b"]);
    expect(queue.pending()).toBe(0);
  });

  it("rejects the failing task's caller and keeps running the rest", async () => {
    const queue = createSerialQueue();
    const failing = queue.run(() => Promise.reject(new Error("bad batch")));
    const next = queue.run(() => Promise.resolve("next"));

    await expect(failing).rejects.toThrow("bad batch");
    await expect(next).resolves.toBe("next");
  });

  it("resolves idle once everything queued so far has settled", async () => {
    const queue = createSerialQueue();
    const gate = deferred();
    let done = false;
    void queue.run(async () => {
      await gate.promise;
      done = true;
    });

    const idle = queue.idle();
    gate.resolve();
    await idle;
    expect(done).toBe(true);
  });

  it("is idle at once when nothing was queued", async () => {
    await expect(createSerialQueue().idle()).resolves.toBeUndefined();
  });
});

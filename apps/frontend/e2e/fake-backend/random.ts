// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Deterministic randomness for the fake backend: every id and every noise value follows from a
// seed, so two runs of the same scenario produce the same frames, byte for byte, except for the
// wall-clock stamps.

/** A 32-bit integer hash of three integers (a Murmur3-style finaliser over an FNV-1a mix). */
export function hash32(a: number, b: number, c: number): number {
  let h = (a ^ 0x811c9dc5) >>> 0;
  for (const value of [b, c]) {
    h = Math.imul(h ^ (value >>> 0), 0x01000193) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** A value in [-1, 1) that depends only on the seed, the instant and the channel. */
export function unitNoise(seed: number, instantMs: number, channel: number): number {
  const seconds = Math.floor(instantMs / 1000);
  return (hash32(seed, seconds, channel) / 0x1_0000_0000) * 2 - 1;
}

/** Hands out lowercase version-4 UUIDs, deterministic for a seed. */
export interface IdSource {
  uuid(): string;
}

/** The low `digits` hex digits of a 32-bit value. */
function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).padStart(8, "0").slice(-digits);
}

export function createIdSource(seed: number): IdSource {
  let counter = 0;
  return {
    uuid(): string {
      counter += 1;
      const high = hash32(seed, counter, 1);
      const middle = hash32(seed, counter, 2);
      const low = hash32(seed, counter, 3);
      const variant = (8 + (middle & 0x3)).toString(16);
      return [
        hex(high, 8),
        hex(middle >>> 16, 4),
        `4${hex(middle, 3)}`,
        `${variant}${hex(low >>> 20, 3)}`,
        `${hex(low, 5)}${hex(hash32(seed, counter, 4), 7)}`,
      ].join("-");
    },
  };
}

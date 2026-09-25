// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The seeded generator behind the `noise` primitive.
//
// The simulator draws its noise from Go's `math/rand/v2`: a PCG generator
// seeded with an FNV-1a 64 hash and `NormFloat64`, which is a ziggurat with
// 128 precomputed table entries (`services/modbus/internal/injection/
// primitives.go`). Reproducing that bit for bit in TypeScript would mean
// porting the ziggurat tables and trusting two independent implementations of
// the same rejection loop, so the port goes the other way: it uses a
// documented generator of its own and the parity test compares the noise
// **statistically** — mean and standard deviation over a run — instead of
// sample by sample. Every other primitive is exact.
//
// What is shared with the simulator is the seeding rule, which is what makes
// the draws reproducible:
//
//   seed  = FNV-1a 64 of `${instance_id}|${simTsMs}|${transformIndex}`
//   state = splitmix64(seed) twice, giving the four 32-bit words
//   draw  = Box–Muller over xoshiro128**
//
// The transform index is part of the seed for the same reason it is part of
// the simulator's: a definition may carry two `noise` transforms, and two tags
// that always drew the same number would not be two noisy tags. The draw does
// not depend on `sigma`, which is what makes the deviation scale linearly with
// it, and it does not depend on the wall clock, the replay speed or the order
// the rows are visited in — only on the instance, the simulated instant and
// the position of the transform.
//
// The FNV hash runs on `BigInt` because a 64-bit fold has no exact `number`
// form. It costs about a microsecond per draw, which only a replay with an
// active `noise` injection pays, and only once per row per noise transform.

/** FNV-1a 64 offset basis (the constant of `hash/fnv`). */
const FNV_OFFSET_64 = 0xcbf2_9ce4_8422_2325n;

/** FNV-1a 64 prime. */
const FNV_PRIME_64 = 0x0000_0100_0000_01b3n;

/** The 64-bit window every fold and every multiplication is cut back to. */
const MASK_64 = 0xffff_ffff_ffff_ffffn;

/** The golden-ratio increment of splitmix64. */
const SPLITMIX_GAMMA = 0x9e37_79b9_7f4a_7c15n;

/** The two mixing constants of splitmix64. */
const SPLITMIX_MIX_1 = 0xbf58_476d_1ce4_e5b9n;
const SPLITMIX_MIX_2 = 0x94d0_49bb_1331_11ebn;

/** 2^32, the divisor that turns a `uint32` into a unit interval value. */
const TWO_POW_32 = 4_294_967_296;

const encoder = new TextEncoder();

/**
 * FNV-1a over 64 bits of the UTF-8 bytes of `text`.
 *
 * It is the algorithm of Go's `hash/fnv` `New64a`, so a seed string folded here and the same
 * string folded in `services/modbus/internal/injection/primitives.go` produce the same
 * number — the generators differ, the seeding does not.
 */
export function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET_64;
  for (const byte of encoder.encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME_64) & MASK_64;
  }
  return hash;
}

/** One step of splitmix64: the next state and the value it mixes out of it. */
function splitmix64(state: bigint): { readonly state: bigint; readonly value: bigint } {
  const next = (state + SPLITMIX_GAMMA) & MASK_64;
  let x = next;
  x = ((x ^ (x >> 30n)) * SPLITMIX_MIX_1) & MASK_64;
  x = ((x ^ (x >> 27n)) * SPLITMIX_MIX_2) & MASK_64;
  x = (x ^ (x >> 31n)) & MASK_64;
  return { state: next, value: x };
}

/** A seeded generator; each method advances it. */
export interface Prng {
  /** The next 32-bit word. */
  nextUint32(): number;
  /** The next value in `(0, 1]`; never zero, so `Math.log` of it is finite. */
  nextUnit(): number;
  /** The next draw from the standard normal distribution. */
  nextNormal(): number;
}

/** `x` rotated left by `bits`, as a `uint32`. */
function rotl32(x: number, bits: number): number {
  return ((x << bits) | (x >>> (32 - bits))) >>> 0;
}

/**
 * A xoshiro128** generator seeded from a 64-bit number.
 *
 * The four words come from two splitmix64 steps, which is the seeding the xoshiro authors
 * recommend: the hash alone would leave half the state zero for a small seed, and a state
 * that is all zero is the generator's one fixed point.
 */
export function createPrng(seed: bigint): Prng {
  const first = splitmix64(seed & MASK_64);
  const second = splitmix64(first.state);

  let s0 = Number(first.value & 0xffff_ffffn);
  let s1 = Number(first.value >> 32n);
  let s2 = Number(second.value & 0xffff_ffffn);
  let s3 = Number(second.value >> 32n);
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl32(s3, 11);
    return result;
  };

  const nextUnit = (): number => (nextUint32() + 1) / TWO_POW_32;

  return {
    nextUint32,
    nextUnit,
    nextNormal: () => {
      const u1 = nextUnit();
      const u2 = nextUnit();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

/**
 * The seed string one noise draw is folded from.
 *
 * It is written down here rather than inlined because the golden recordings and the parity
 * test describe the port's noise by it: a change to this string changes every draw.
 */
export function noiseSeed(instanceId: string, simTsMs: number, transformIndex: number): string {
  return `${instanceId}|${simTsMs}|${transformIndex}`;
}

/**
 * The standard-normal draw one `noise` transform of one instance makes at one simulated
 * instant.
 *
 * The same three arguments always yield the same number, whatever the replay speed and
 * however often the row is visited, which is what lets a scenario be replayed twice and
 * scored once.
 */
export function normalDraw(instanceId: string, simTsMs: number, transformIndex: number): number {
  return createPrng(fnv1a64(noiseSeed(instanceId, simTsMs, transformIndex))).nextNormal();
}

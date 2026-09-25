// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * A value that must never be printed: secrets reach the process through the
 * environment only and never appear in logs (docs/security.md).
 *
 * The wrapper exists because the two API keys travel through code that logs,
 * serialises and inspects objects: pino's redaction list catches the field
 * names it knows, and this class catches everything else — string
 * interpolation, `JSON.stringify`, `console.log` and Node's `util.inspect` all
 * go through one of the three methods below and all of them answer
 * {@link REDACTED}.
 *
 * The plain value is reachable only through {@link Secret.reveal}, which is
 * greppable, so a review can see every place a key leaves the boundary.
 */
export const REDACTED = "[redacted]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The plain value. The only way out of the wrapper; call it at the SDK boundary. */
  reveal(): string {
    return this.#value;
  }

  /** True when the wrapped value is the empty string. */
  get isEmpty(): boolean {
    return this.#value === "";
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

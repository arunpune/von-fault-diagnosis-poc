// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// When a live smoke test may call an API.
//
// Two conditions, checked in this order. Without the key a live test is
// skipped: the suite stays green offline and in CI. With the key, it still
// refuses to call anything unless the run was started with `--confirm-live`,
// the same consent `fdp-eval record` and every live mode of `fdp-eval run`
// ask for. Vitest rejects a flag it does not know, so the flag is read by the
// `test:live` launcher (`launch.ts`), which hands the consent to the test
// workers as `EVAL_CONFIRM_LIVE=1`; the launcher sets that variable itself,
// so only the flag turns it on.

/** The consent a live call needs. */
export const CONFIRM_LIVE_FLAG = "--confirm-live";

/** How the launcher tells the test workers the flag was given. */
export const CONSENT_ENV = "EVAL_CONFIRM_LIVE";

/** True when `name` is set to something; the value itself is never read here. */
export function hasKey(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[name];
  return value !== undefined && value !== "";
}

/**
 * Refuses to go on unless the run was started with `--confirm-live`.
 *
 * @throws Error naming the flag and the command that gives it.
 */
export function requireConsent(api: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env[CONSENT_ENV] === "1") return;
  throw new Error(
    `refusing to call the ${api} API without ${CONFIRM_LIVE_FLAG}: a live call is paid, so ` +
      `it runs only when the suite is started as pnpm --filter @fdp/eval test:live -- ` +
      CONFIRM_LIVE_FLAG,
  );
}

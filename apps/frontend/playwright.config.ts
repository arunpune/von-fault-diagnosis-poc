// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Playwright 1.63 configuration of @fdp/frontend.
// Chromium only; traces on the first retry; the HTML report goes to playwright-report/.
//
// Projects:
//   * `mock`  — every spec under e2e/ except perf.spec.ts, against the fake backend;
//   * `perf`  — perf.spec.ts only, against the same servers; empty when `PERF=0`;
//   * `stack` — tour.spec.ts against the Compose stack at `E2E_BASE_URL`
//               (default http://localhost:8080), after the `stack-setup` project
//               (e2e/stack.setup.ts).
//
// The mock projects share one web server, e2e/launch.ts, which starts the fake backend and
// `vite preview` on ports the system picks and prints them on one ready line; `webServer.wait`
// captures the two named groups into `E2E_MOCK_BASE_URL` and `FAKE_BACKEND_URL`. The runner sets
// them before it forks the workers, which re-read this file, so the workers see the base URL.
// With `E2E_MODE=stack` (the `e2e:stack` script) no web server starts at all.
//
// The fake backend holds one scenario for the whole run, so the tests run one at a time.

import { defineConfig, devices } from "@playwright/test";

import type { E2EOptions } from "./e2e/helpers.ts";

const CI = (process.env.CI ?? "") !== "";
const STACK_ONLY = process.env.E2E_MODE === "stack";
const PERF_DISABLED = process.env.PERF === "0";

/** Captured from e2e/launch.ts's ready line; undefined while the runner loads this file. */
const MOCK_BASE_URL = process.env.E2E_MOCK_BASE_URL;
const STACK_BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";

/** e2e/launch.ts prints `E2E_READY base=<app url> backend=<fake backend url>`. */
const READY_LINE = /E2E_READY base=(?<E2E_MOCK_BASE_URL>\S+) backend=(?<FAKE_BACKEND_URL>\S+)/;

export default defineConfig<E2EOptions>({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
  },
  webServer: STACK_ONLY
    ? undefined
    : {
        name: "fake-backend",
        command: "node e2e/launch.ts",
        wait: { stdout: READY_LINE },
        timeout: 180_000,
        stderr: "pipe",
        gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      },
  projects: [
    {
      name: "mock",
      testMatch: /.*\.spec\.ts$/,
      testIgnore: /perf\.spec\.ts$/,
      timeout: 90_000,
      use: { mode: "mock", baseURL: MOCK_BASE_URL },
    },
    {
      name: "perf",
      testMatch: PERF_DISABLED ? [] : /perf\.spec\.ts$/,
      timeout: 120_000,
      use: { mode: "mock", baseURL: MOCK_BASE_URL },
    },
    {
      name: "stack-setup",
      testMatch: /stack\.setup\.ts$/,
      use: { mode: "stack", baseURL: STACK_BASE_URL },
    },
    {
      name: "stack",
      testMatch: /tour\.spec\.ts$/,
      dependencies: ["stack-setup"],
      timeout: 600_000,
      use: { mode: "stack", baseURL: STACK_BASE_URL },
    },
  ],
});

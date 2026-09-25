// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The web server of the `mock` and `perf` Playwright projects. Playwright runs
// `node e2e/launch.ts`; this script
//
//   1. starts the fake backend on a free port,
//   2. builds the app (skipped with `E2E_SKIP_BUILD=1`, for a CI job that has just built it),
//   3. serves `dist/` with `vite preview` on another free port, its `/api` and `/ws` proxy pointed
//      at the fake through `FDP_BACKEND_URL` (vite.config.ts), exactly as nginx proxies the real
//      backend in the container,
//   4. prints one ready line, `E2E_READY base=<app url> backend=<fake backend url>`.
//
// playwright.config.ts waits for that line and turns its two named groups into the environment
// variables `E2E_MOCK_BASE_URL` (the tests' `baseURL`) and `FAKE_BACKEND_URL` (the control API of
// e2e/helpers.ts). Both ports are chosen by the system, so several worktrees can run the suite at
// the same time. SIGTERM or SIGINT stops both servers.

import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { build, preview } from "vite";

import { startFakeBackend } from "./fake-backend/server.ts";

const FRONTEND_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = "127.0.0.1";

async function main(): Promise<void> {
  const backend = await startFakeBackend({ host: HOST, port: 0 });
  // Read by vite.config.ts when `preview()` loads it below.
  process.env.FDP_BACKEND_URL = backend.url;

  if (process.env.E2E_SKIP_BUILD !== "1") {
    await build({ root: FRONTEND_ROOT, logLevel: "warn" });
  }
  const server = await preview({
    root: FRONTEND_ROOT,
    logLevel: "warn",
    preview: { host: HOST, port: 0, strictPort: true, open: false },
  });
  const { port } = server.httpServer.address() as AddressInfo;

  process.stdout.write(`E2E_READY base=http://${HOST}:${port} backend=${backend.url}\n`);

  const stop = (): void => {
    void Promise.allSettled([server.close(), backend.close()]).then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

await main();

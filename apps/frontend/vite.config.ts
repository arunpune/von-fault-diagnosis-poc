// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Vite and Vitest configuration of @fdp/frontend.
//
// The browser only ever talks to its own origin: `/api` and `/ws` are proxied to the backend by
// the dev server and by `vite preview` alike, so `vite preview` against the fake backend of the
// E2E suite behaves like the nginx container. `FDP_BACKEND_URL` is read here, at dev time only;
// no `VITE_*` variable reaches the bundle.
//
// `build.manifest` writes dist/.vite/manifest.json, which test/bundle-budget.test.ts reads to
// hold the initial JavaScript under its budget.
//
// The workspace's `@fdp/source` condition comes first so that a test importing
// `@fdp/contracts/testing` resolves to the TypeScript sources without a contracts build; the
// application itself imports contracts as types only, so the condition changes nothing in the
// bundle.

import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, type ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

const SOURCE_CONDITION = "@fdp/source";
const DEFAULT_BACKEND_URL = "http://localhost:3000";

/** The same-origin paths the UI reaches the backend through. */
function backendProxy(): Record<string, ProxyOptions> {
  const target = process.env.FDP_BACKEND_URL ?? DEFAULT_BACKEND_URL;
  return {
    "/api": { target },
    "/ws": { target, ws: true },
  };
}

/** Line coverage the shared modules must keep; features are reported only. */
const COVERED_LINES = { lines: 85 };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  server: { proxy: backendProxy() },
  preview: { proxy: backendProxy() },
  build: { manifest: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    restoreMocks: true,
    // Room for several 3 s findBy waits (src/test/setup.ts) on a loaded runner.
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/components/ui/**"],
      thresholds: {
        "src/lib/**": COVERED_LINES,
        "src/store/**": COVERED_LINES,
        "src/api/**": COVERED_LINES,
      },
    },
  },
});

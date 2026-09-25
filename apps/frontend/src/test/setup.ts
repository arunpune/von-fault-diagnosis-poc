// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Vitest setup for every test file: the jest-dom matchers, unmounting after each test, the two
// browser APIs jsdom lacks that Radix and Recharts call, and the msw server that answers every
// REST route from the fixtures; a request no handler answers fails the test that made it. The
// build-output tests under test/ run in the node environment: there is no window to patch, and
// they reach a real `vite preview`, so the mock backend stays out of their way.
//
// `make test` runs the workspace suites side by side, and on a loaded runner a lazy tab's chunk
// or an msw answer can take longer than Testing Library's 1 s default for findBy/waitFor. The
// async utilities wait up to 3 s instead, inside the 10 s per-test budget of vite.config.ts;
// a real hang still fails.

import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "@/test/msw/server";

/** `matchMedia` that matches nothing; a test that needs a match spies on it. */
function matchNothing(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {
      // Nothing ever changes, so there is nothing to notify.
    },
    removeEventListener() {
      // See addEventListener.
    },
    addListener() {
      // The deprecated spelling of addEventListener.
    },
    removeListener() {
      // The deprecated spelling of removeEventListener.
    },
    dispatchEvent: () => false,
  };
}

class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // jsdom has no layout, so no element ever resizes.
  }
  unobserve(): void {
    // See observe.
  }
  disconnect(): void {
    // See observe.
  }
}

const inBrowserEnvironment = typeof window !== "undefined";

if (inBrowserEnvironment) {
  window.matchMedia ??= matchNothing;
  globalThis.ResizeObserver ??= ResizeObserverStub;
}

/** How long findBy/waitFor wait before failing (Testing Library's default is 1 s). */
const ASYNC_UTIL_TIMEOUT_MS = 3_000;

configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });

/** The mock backend, for the tests that render the UI; none for the node tests. */
const mockBackend = inBrowserEnvironment ? server : null;

beforeAll(() => {
  mockBackend?.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  mockBackend?.resetHandlers();
});

afterAll(() => {
  mockBackend?.close();
});

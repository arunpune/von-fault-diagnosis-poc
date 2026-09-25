// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Hash routes: `#/decisions/<id>` opens the decision sheet and `#/tickets/<id>` the ticket
// sheet; closing a sheet clears the hash. Nothing else is routed — a thirty-line router instead
// of react-router — and the E2E tour uses these as deep links.

import { useMemo, useSyncExternalStore } from "react";

export type HashRouteKind = "decision" | "ticket";

export type HashRoute = { kind: null; id: null } | { kind: HashRouteKind; id: string };

export const NO_ROUTE: HashRoute = Object.freeze({ kind: null, id: null });

const SEGMENT_KIND: Readonly<Record<string, HashRouteKind>> = {
  decisions: "decision",
  tickets: "ticket",
};

const KIND_SEGMENT: Readonly<Record<HashRouteKind, string>> = {
  decision: "decisions",
  ticket: "tickets",
};

const ROUTE_PATTERN = /^#\/([a-z]+)\/([^/]+)\/?$/;

function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Reads a `location.hash` value; anything that is not a sheet route is no route. */
export function parseHashRoute(hash: string): HashRoute {
  const match = ROUTE_PATTERN.exec(hash);
  const kind = match?.[1] === undefined ? undefined : SEGMENT_KIND[match[1]];
  const id = match?.[2] === undefined ? null : decodeId(match[2]);
  if (kind === undefined || id === null || id === "") {
    return NO_ROUTE;
  }
  return { kind, id };
}

/** The hash that opens a sheet, for links and for `openHashRoute`. */
export function hashRouteHref(kind: HashRouteKind, id: string): string {
  return `#/${KIND_SEGMENT[kind]}/${encodeURIComponent(id)}`;
}

export function openHashRoute(kind: HashRouteKind, id: string): void {
  window.location.hash = hashRouteHref(kind, id);
}

/**
 * Closes whichever sheet is open. The new history entry has no hash at all (not a bare `#`), so
 * Back reopens the sheet the way it would after any other navigation.
 */
export function clearHashRoute(): void {
  if (window.location.hash === "") {
    return;
  }
  window.history.pushState(null, "", window.location.pathname + window.location.search);
  // pushState fires no event of its own; subscribers listen for hashchange only.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function currentHash(): string {
  return window.location.hash;
}

export function useHashRoute(): HashRoute {
  const hash = useSyncExternalStore(subscribeHash, currentHash);
  return useMemo(() => parseHashRoute(hash), [hash]);
}

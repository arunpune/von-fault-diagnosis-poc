// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NO_ROUTE,
  clearHashRoute,
  hashRouteHref,
  openHashRoute,
  parseHashRoute,
  useHashRoute,
} from "@/lib/hash-route";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

/** Sets the hash the way a link does and delivers the event jsdom would queue for it. */
function navigateToHash(hash: string): void {
  act(() => {
    window.history.pushState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("parseHashRoute", () => {
  it.each([
    ["#/decisions/dec-7f3a91", { kind: "decision", id: "dec-7f3a91" }],
    ["#/tickets/tkt-000012", { kind: "ticket", id: "tkt-000012" }],
    ["#/tickets/tkt-000012/", { kind: "ticket", id: "tkt-000012" }],
    ["#/decisions/a%20b%2Fc", { kind: "decision", id: "a b/c" }],
  ])("reads %s", (hash, route) => {
    expect(parseHashRoute(hash)).toEqual(route);
  });

  it.each([
    "",
    "#",
    "#/",
    "#/decisions",
    "#/decisions/",
    "#/events/e-1",
    "#/tickets/a/b",
    "#/tickets/%E0%A4%A",
  ])("treats %j as no route", (hash) => {
    expect(parseHashRoute(hash)).toBe(NO_ROUTE);
  });
});

describe("hashRouteHref", () => {
  it("builds the hash that parses back to the same route", () => {
    const href = hashRouteHref("ticket", "tkt 12/a");

    expect(href).toBe("#/tickets/tkt%2012%2Fa");
    expect(parseHashRoute(href)).toEqual({ kind: "ticket", id: "tkt 12/a" });
  });
});

describe("useHashRoute", () => {
  it("follows the hash", () => {
    const { result } = renderHook(() => useHashRoute());
    expect(result.current).toBe(NO_ROUTE);

    navigateToHash("#/decisions/dec-1");
    expect(result.current).toEqual({ kind: "decision", id: "dec-1" });

    navigateToHash("#/tickets/tkt-2");
    expect(result.current).toEqual({ kind: "ticket", id: "tkt-2" });
  });

  it("keeps the same route object while the hash is unchanged", () => {
    navigateToHash("#/decisions/dec-1");
    const { result, rerender } = renderHook(() => useHashRoute());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});

describe("openHashRoute and clearHashRoute", () => {
  it("opens a route by setting the hash", () => {
    openHashRoute("decision", "dec-9");

    expect(window.location.hash).toBe("#/decisions/dec-9");
  });

  it("clears the hash entirely and tells subscribers", () => {
    navigateToHash("#/tickets/tkt-2");
    const { result } = renderHook(() => useHashRoute());

    act(() => clearHashRoute());

    expect(window.location.href).not.toContain("#");
    expect(result.current).toBe(NO_ROUTE);
  });

  it("does nothing when no route is open", () => {
    const pushState = vi.spyOn(window.history, "pushState");

    clearHashRoute();

    expect(pushState).not.toHaveBeenCalled();
  });
});

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_UI_PREFS,
  UI_PREFS_KEY,
  getUiPrefs,
  parseUiPrefs,
  reloadUiPrefs,
  setUiPref,
  subscribeUiPrefs,
  useUiPref,
} from "@/store/ui-prefs";

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
});

describe("parseUiPrefs", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(parseUiPrefs(null)).toEqual({
      theme: "system",
      windowMs: 21_600_000,
      overlays: true,
      showAllSignals: false,
    });
  });

  it("reads every valid field", () => {
    const stored = { theme: "dark", windowMs: 3_600_000, overlays: false, showAllSignals: true };
    expect(parseUiPrefs(JSON.stringify(stored))).toEqual(stored);
  });

  it("replaces an invalid field by its default and keeps the others", () => {
    const stored = { theme: "sepia", windowMs: 60_000, overlays: "yes", showAllSignals: true };
    expect(parseUiPrefs(JSON.stringify(stored))).toEqual({
      ...DEFAULT_UI_PREFS,
      showAllSignals: true,
    });
  });

  it("drops fields it does not know", () => {
    expect(parseUiPrefs(JSON.stringify({ theme: "light", legacy: 1 }))).toEqual({
      ...DEFAULT_UI_PREFS,
      theme: "light",
    });
  });

  it.each(["{not json", "42", "null", '"dark"'])("falls back to the defaults for %s", (raw) => {
    expect(parseUiPrefs(raw)).toEqual(DEFAULT_UI_PREFS);
  });
});

describe("the preference store", () => {
  it("persists a change under the versioned key", () => {
    setUiPref("theme", "dark");

    expect(getUiPrefs().theme).toBe("dark");
    expect(UI_PREFS_KEY).toBe("fdp.ui:v1");
    expect(JSON.parse(window.localStorage.getItem(UI_PREFS_KEY) ?? "null")).toEqual({
      ...DEFAULT_UI_PREFS,
      theme: "dark",
    });
  });

  it("notifies subscribers of a change but not of a repeated value", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUiPrefs(listener);

    setUiPref("overlays", false);
    setUiPref("overlays", false);
    unsubscribe();
    setUiPref("overlays", true);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reads storage once and then serves the cached value", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    reloadUiPrefs();
    getItem.mockClear();

    getUiPrefs();
    getUiPrefs();

    expect(getItem).not.toHaveBeenCalled();
  });

  it("uses the defaults when storage cannot be read", () => {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ theme: "dark" }));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    reloadUiPrefs();

    expect(getUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it("keeps a change for the page when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    setUiPref("windowMs", 86_400_000);

    expect(getUiPrefs().windowMs).toBe(86_400_000);
  });

  it("reloads when another tab writes the key", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUiPrefs(listener);
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ theme: "light" }));

    window.dispatchEvent(new StorageEvent("storage", { key: "another:key" }));
    expect(listener).not.toHaveBeenCalled();

    window.dispatchEvent(new StorageEvent("storage", { key: UI_PREFS_KEY }));
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getUiPrefs().theme).toBe("light");
  });

  it("serves one field to React and re-renders when it changes", () => {
    const { result } = renderHook(() => useUiPref("windowMs"));
    expect(result.current).toBe(21_600_000);

    act(() => setUiPref("windowMs", 3_600_000));

    expect(result.current).toBe(3_600_000);
  });
});

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// UI preferences: the theme, the recorder's time window, the reference-window overlays and the
// "show all signals" switch, kept under one versioned localStorage key.
//
// Storage can throw (private browsing, a full quota, storage disabled) and can hold anything,
// so every access is wrapped and every field is validated on its own: one bad field falls back
// to its default without discarding the others. The parsed value is cached in memory and served
// to React through useSyncExternalStore; a `storage` event from another tab reloads it.
// index.html reads the same key before the first paint to set the theme class.

import { useSyncExternalStore } from "react";

export const UI_PREFS_KEY = "fdp.ui:v1";

export const THEME_PREFS = ["system", "light", "dark"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

/** The recorder windows of sim time, in milliseconds: 1 h, 6 h and 24 h. */
export const WINDOW_MS_CHOICES = [3_600_000, 21_600_000, 86_400_000] as const;
export type WindowMs = (typeof WINDOW_MS_CHOICES)[number];

export interface UiPrefs {
  theme: ThemePref;
  windowMs: WindowMs;
  overlays: boolean;
  showAllSignals: boolean;
}

export const DEFAULT_UI_PREFS: Readonly<UiPrefs> = Object.freeze({
  theme: "system",
  windowMs: 21_600_000,
  overlays: true,
  showAllSignals: false,
});

function isThemePref(value: unknown): value is ThemePref {
  return THEME_PREFS.some((theme) => theme === value);
}

function isWindowMs(value: unknown): value is WindowMs {
  return WINDOW_MS_CHOICES.some((windowMs) => windowMs === value);
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Parses a stored value: unknown fields are dropped and invalid ones take their default. */
export function parseUiPrefs(raw: string | null): UiPrefs {
  const stored = raw === null ? null : parseJson(raw);
  if (typeof stored !== "object" || stored === null) {
    return { ...DEFAULT_UI_PREFS };
  }
  const fields = stored as Record<string, unknown>;
  return {
    theme: isThemePref(fields.theme) ? fields.theme : DEFAULT_UI_PREFS.theme,
    windowMs: isWindowMs(fields.windowMs) ? fields.windowMs : DEFAULT_UI_PREFS.windowMs,
    overlays: booleanOr(fields.overlays, DEFAULT_UI_PREFS.overlays),
    showAllSignals: booleanOr(fields.showAllSignals, DEFAULT_UI_PREFS.showAllSignals),
  };
}

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(UI_PREFS_KEY);
  } catch {
    return null;
  }
}

function writeStorage(prefs: UiPrefs): void {
  try {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage is unavailable: the preference still holds for this page, just not across reloads.
  }
}

let current: UiPrefs | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** The current preferences, read from storage once and then served from memory. */
export function getUiPrefs(): UiPrefs {
  current ??= parseUiPrefs(readStorage());
  return current;
}

/** Changes one preference, persists all of them and notifies every subscriber. */
export function setUiPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void {
  const prefs = getUiPrefs();
  if (Object.is(prefs[key], value)) {
    return;
  }
  current = { ...prefs, [key]: value };
  writeStorage(current);
  notify();
}

/** Drops the in-memory copy and re-reads storage, e.g. after another tab wrote the key. */
export function reloadUiPrefs(): void {
  current = parseUiPrefs(readStorage());
  notify();
}

function onStorage(event: StorageEvent): void {
  // A null key means another tab cleared the whole storage area.
  if (event.key === null || event.key === UI_PREFS_KEY) {
    reloadUiPrefs();
  }
}

export function subscribeUiPrefs(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** One preference as React state; the component re-renders only when that field changes. */
export function useUiPref<K extends keyof UiPrefs>(key: K): UiPrefs[K] {
  return useSyncExternalStore(subscribeUiPrefs, () => getUiPrefs()[key]);
}

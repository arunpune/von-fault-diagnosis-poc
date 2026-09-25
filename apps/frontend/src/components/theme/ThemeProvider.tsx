// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The app's own theme provider (no next-themes). The chosen theme is a UI preference
// (store/ui-prefs.ts); "system" follows `prefers-color-scheme` live. The provider keeps
// `class="dark"` and `color-scheme` on <html> in step with it after index.html's boot script
// has set them before the first paint. The generated sonner component reads `useTheme` from
// this module.

import {
  createContext,
  use,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { setUiPref, useUiPref, type ThemePref } from "@/store/ui-prefs";

export type ResolvedTheme = "light" | "dark";

export interface ThemeState {
  /** The preference: "system", "light" or "dark". */
  theme: ThemePref;
  /** What is on screen once "system" is resolved. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePref) => void;
}

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function subscribeSystemScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_SCHEME_QUERY).matches;
}

function setTheme(theme: ThemePref): void {
  setUiPref("theme", theme);
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useUiPref("theme");
  const systemDark = useSyncExternalStore(subscribeSystemScheme, systemPrefersDark);
  const resolvedTheme: ResolvedTheme =
    theme === "dark" || (theme === "system" && systemDark) ? "dark" : "light";

  // Before paint, so a toggle never shows one frame of the previous theme.
  useLayoutEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const state = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme]);
  return <ThemeContext value={state}>{children}</ThemeContext>;
}

export function useTheme(): ThemeState {
  const state = use(ThemeContext);
  if (state === null) {
    throw new Error("useTheme() is called outside <ThemeProvider>");
  }
  return state;
}

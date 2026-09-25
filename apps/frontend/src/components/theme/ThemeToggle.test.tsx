// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { UI_PREFS_KEY, reloadUiPrefs } from "@/store/ui-prefs";
import { renderWithProviders } from "@/test/render";

const root = document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
  root.classList.remove("dark");
  root.style.colorScheme = "";
});

function storedTheme(): unknown {
  const stored: unknown = JSON.parse(window.localStorage.getItem(UI_PREFS_KEY) ?? "{}");
  return typeof stored === "object" && stored !== null && "theme" in stored
    ? stored.theme
    : undefined;
}

/** Makes `prefers-color-scheme: dark` match, as on a system set to dark. */
function preferDarkSystem(): void {
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query),
    matches: query === "(prefers-color-scheme: dark)",
  }));
}

describe("ThemeToggle", () => {
  it("names the current theme and the next one", () => {
    renderWithProviders(<ThemeToggle />);

    expect(
      screen.getByRole("button", { name: "Theme: system. Switch to light." }),
    ).toBeInTheDocument();
  });

  it("cycles system, light, dark and back, persisting each choice", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: /Switch to light/ }));
    expect(storedTheme()).toBe("light");
    expect(root).not.toHaveClass("dark");
    expect(root.style.colorScheme).toBe("light");

    await user.click(screen.getByRole("button", { name: "Theme: light. Switch to dark." }));
    expect(storedTheme()).toBe("dark");
    expect(root).toHaveClass("dark");
    expect(root.style.colorScheme).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Theme: dark. Switch to system." }));
    expect(storedTheme()).toBe("system");
    expect(root).not.toHaveClass("dark");
  });

  it("follows a dark system while the preference is system", () => {
    preferDarkSystem();

    renderWithProviders(<ThemeToggle />);

    expect(root).toHaveClass("dark");
  });

  it("starts from the stored preference", () => {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ theme: "dark" }));
    reloadUiPrefs();

    renderWithProviders(<ThemeToggle />);

    expect(screen.getByRole("button", { name: /^Theme: dark\./ })).toBeInTheDocument();
    expect(root).toHaveClass("dark");
  });

  it("passes extra props such as a test id to the button", () => {
    renderWithProviders(<ThemeToggle data-testid="status-theme" />);

    expect(screen.getByTestId("status-theme")).toHaveAccessibleName(/^Theme: system\./);
  });
});

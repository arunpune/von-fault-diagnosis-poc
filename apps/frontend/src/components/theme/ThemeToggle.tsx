// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Icon button that cycles the theme preference system → light → dark. The icon shows the
// current preference; the accessible name says both where it is and where it goes. Extra props
// reach the button, so the status bar can add its test id.

import MonitorIcon from "lucide-react/dist/esm/icons/monitor";
import MoonIcon from "lucide-react/dist/esm/icons/moon";
import SunIcon from "lucide-react/dist/esm/icons/sun";
import type { ComponentProps, ReactElement } from "react";

import { useTheme } from "@/components/theme/ThemeProvider";
import { Button } from "@/components/ui/button";
import type { ThemePref } from "@/store/ui-prefs";

const NEXT_THEME: Record<ThemePref, ThemePref> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_ICON: Record<ThemePref, ReactElement> = {
  system: <MonitorIcon aria-hidden="true" />,
  light: <SunIcon aria-hidden="true" />,
  dark: <MoonIcon aria-hidden="true" />,
};

export type ThemeToggleProps = Omit<ComponentProps<typeof Button>, "onClick" | "children">;

export function ThemeToggle(props: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const next = NEXT_THEME[theme];
  const label = `Theme: ${theme}. Switch to ${next}.`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => setTheme(next)}
      {...props}
    >
      {THEME_ICON[theme]}
    </Button>
  );
}

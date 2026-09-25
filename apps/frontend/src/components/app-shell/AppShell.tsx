// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The page grid: a 48 px status bar, a main row with the recorder (1fr) beside a 360 px right
// rail, and the bottom tabs (at least 240 px). From 1024 px down the rail moves under the
// recorder and the tabs follow; the page then scrolls instead of each region. Regions are
// separated by 1 px borders on the surface colour, never by card shadows.

import type { ReactNode } from "react";

export interface AppShellProps {
  statusBar: ReactNode;
  recorder: ReactNode;
  /** The right rail's panels, top to bottom; the last one takes the remaining height. */
  rail: ReactNode;
  bottom: ReactNode;
}

export function AppShell({ statusBar, recorder, rail, bottom }: AppShellProps) {
  return (
    <div className="grid min-h-dvh grid-cols-1 grid-rows-[3rem_auto_auto_minmax(15rem,auto)] bg-background lg:h-dvh lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:grid-rows-[3rem_minmax(0,1fr)_minmax(15rem,34%)]">
      <header className="col-span-full min-w-0 border-b bg-card">{statusBar}</header>
      <main className="flex min-h-0 min-w-0 flex-col border-b bg-card lg:border-r">{recorder}</main>
      <aside
        aria-label="Simulation and alerts"
        className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-b bg-card"
      >
        {rail}
      </aside>
      <section aria-label="Records" className="col-span-full flex min-h-0 min-w-0 flex-col bg-card">
        {bottom}
      </section>
    </div>
  );
}

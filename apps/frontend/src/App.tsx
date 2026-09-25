// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The page. Every region comes from a fixed path, so a feature changes the files inside its own
// folder and never this one. The tickets tab is the one open on load; the Review, Events and
// Cost tabs and the two sheets are separate chunks that load on first use and preload when their
// trigger is hovered or focused. The sheets follow the hash route.

import { Suspense, type ReactElement } from "react";

import { AppShell } from "@/components/app-shell/AppShell";
import {
  LazyCostTab,
  LazyDecisionSheet,
  LazyEventsTab,
  LazyReviewTab,
  LazyTicketSheet,
} from "@/components/app-shell/lazy-panels";
import { useTabCounts, type BottomTab } from "@/components/app-shell/tab-counts";
import StatusBar from "@/components/status-bar/StatusBar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AlertsPanel from "@/features/alerts/AlertsPanel";
import RecorderPanel from "@/features/recorder/RecorderPanel";
import SimulationPanel from "@/features/simulation/SimulationPanel";
import TicketsTab from "@/features/tickets/TicketsTab";
import { clearHashRoute, useHashRoute } from "@/lib/hash-route";
import { useMountedOnceOpened } from "@/lib/lazy";

interface TabDef {
  value: BottomTab;
  label: string;
  content: ReactElement;
  /** Starts loading a lazy tab's chunk; absent for the tab that is part of the first paint. */
  preload?: () => void;
}

/**
 * An inactive tab's label is secondary text, so it takes the muted token in both themes. The
 * shadcn default, 60 % of the ink, reads 4.3:1 on the light surface, under the 4.5:1 that text
 * needs.
 */
const TAB_TRIGGER_CLASS = "text-muted-foreground";

const TAB_FALLBACK = (
  <div role="status" className="space-y-2 px-4 py-3">
    <span className="sr-only">Loading</span>
    <Skeleton className="h-4 w-1/3" />
    <Skeleton className="h-4 w-2/3" />
    <Skeleton className="h-4 w-1/2" />
  </div>
);

const SHEET_FALLBACK = (
  <div
    role="status"
    className="fixed inset-y-0 right-0 z-50 w-full space-y-3 border-l bg-popover p-4 sm:max-w-[35rem]"
  >
    <span className="sr-only">Loading</span>
    <Skeleton className="h-7 w-2/3" />
    <Skeleton className="h-4 w-1/3" />
    <Skeleton className="h-24 w-full" />
  </div>
);

function preloadReview(): void {
  void LazyReviewTab.preload();
}

function preloadEvents(): void {
  void LazyEventsTab.preload();
}

function preloadCost(): void {
  void LazyCostTab.preload();
}

const TABS: readonly TabDef[] = [
  { value: "tickets", label: "Tickets", content: <TicketsTab /> },
  {
    value: "review",
    label: "Review",
    content: (
      <Suspense fallback={TAB_FALLBACK}>
        <LazyReviewTab />
      </Suspense>
    ),
    preload: preloadReview,
  },
  {
    value: "events",
    label: "Events",
    content: (
      <Suspense fallback={TAB_FALLBACK}>
        <LazyEventsTab />
      </Suspense>
    ),
    preload: preloadEvents,
  },
  {
    value: "cost",
    label: "Cost",
    content: (
      <Suspense fallback={TAB_FALLBACK}>
        <LazyCostTab />
      </Suspense>
    ),
    preload: preloadCost,
  },
];

function BottomTabs() {
  const counts = useTabCounts();
  return (
    <Tabs defaultValue="tickets" className="min-h-0 flex-1 gap-0">
      <TabsList variant="line" aria-label="Records" className="mx-2 mt-1">
        {TABS.map((tab) => {
          const count = counts[tab.value];
          return (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className={TAB_TRIGGER_CLASS}
              data-testid={`tab-${tab.value}`}
              onPointerEnter={tab.preload}
              onFocus={tab.preload}
            >
              {tab.label}
              {count === null ? null : (
                <Badge variant="secondary" className="tabular-nums">
                  {count}
                </Badge>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
      {TABS.map((tab) => (
        <TabsContent key={tab.value} value={tab.value} className="min-h-0 overflow-auto">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function SheetRoutes() {
  const route = useHashRoute();
  const decisionId = route.kind === "decision" ? route.id : null;
  const ticketId = route.kind === "ticket" ? route.id : null;
  const decisionSheetMounted = useMountedOnceOpened(decisionId !== null);
  const ticketSheetMounted = useMountedOnceOpened(ticketId !== null);

  return (
    <>
      <Suspense fallback={SHEET_FALLBACK}>
        {decisionSheetMounted ? (
          <LazyDecisionSheet decisionId={decisionId} onClose={clearHashRoute} />
        ) : null}
      </Suspense>
      <Suspense fallback={SHEET_FALLBACK}>
        {ticketSheetMounted ? (
          <LazyTicketSheet ticketId={ticketId} onClose={clearHashRoute} />
        ) : null}
      </Suspense>
    </>
  );
}

const SHELL = (
  <AppShell
    statusBar={<StatusBar />}
    recorder={<RecorderPanel />}
    rail={
      <>
        <SimulationPanel />
        <AlertsPanel />
      </>
    }
    bottom={<BottomTabs />}
  />
);

export default function App() {
  return (
    <>
      {SHELL}
      <SheetRoutes />
    </>
  );
}

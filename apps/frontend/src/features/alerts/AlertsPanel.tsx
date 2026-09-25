// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The alerts feed. App.tsx imports this default export from this fixed path and gives it the
// rail's remaining height. The feed is derived, never stored: `buildFeed` runs over the suspect
// events, the decisions and every ticket the query cache holds — the same caches the WebSocket
// reducers patch — and is memoised on those three arrays, so a pushed decision re-renders the
// list once. When rows arrive while the reader is scrolled down, the header counts them in an
// "N new" pill that scrolls back to the top.
//
// Above the list, one banner per raised backend watchdog alarm, from the live store. Arriving
// decisions and ticket changes are announced through a polite live region of their own; suspect
// events are not, since they arrive too often. A separate region, rather than a live list, keeps
// every row reachable for assistive technology and keeps the first load from being read out.

import ArrowUpIcon from "lucide-react/dist/esm/icons/arrow-up";
import { useMemo, useRef, useState } from "react";

import type { Decision, SuspectEvent, Ticket } from "@/api/types";
import { useDecisions, useEvents, useTickets } from "@/api/queries";
import { Panel } from "@/components/app-shell/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertItem } from "@/features/alerts/AlertItem";
import { buildFeed, describeArrivals, newArrivals, type FeedItem } from "@/features/alerts/feed";
import { SystemAlertBanner } from "@/features/alerts/SystemAlertBanner";
import { raisedAlerts } from "@/features/alerts/system-alerts";
import { useScrollTop } from "@/features/alerts/use-scroll-top";
import { tid } from "@/lib/testids";
import { useActiveAlerts } from "@/store/live-store";

const NO_EVENTS: readonly SuspectEvent[] = [];
const NO_DECISIONS: readonly Decision[] = [];
const NO_TICKETS: readonly Ticket[] = [];

const LOADING_ROWS = (
  <div role="status" className="space-y-3 px-4 py-3">
    <span className="sr-only">Loading alerts</span>
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-1/2" />
    <Skeleton className="h-4 w-2/3" />
  </div>
);

const EMPTY_FEED = <EmptyState>No alerts yet. Press Play, or jump to a known failure.</EmptyState>;

const ARROW_UP = <ArrowUpIcon aria-hidden="true" />;

/**
 * How many rows arrived since the reader last saw the top of the list. The rows seen are taken
 * again on every render at the top, so the count starts from zero each time the reader returns.
 */
function useUnseenCount(items: readonly FeedItem[], atTop: boolean): number {
  const [seen, setSeen] = useState(items);
  if (atTop && seen !== items) {
    // State derived from props during render: the documented alternative to an effect.
    setSeen(items);
  }
  return useMemo(() => (atTop ? 0 : newArrivals(items, seen).length), [atTop, items, seen]);
}

/**
 * The sentence the live region holds: the decisions and ticket changes that arrived since the
 * previous render. The feed as first loaded is the baseline and is never announced, so opening
 * the page does not read out the whole history.
 */
function useArrivalAnnouncement(items: readonly FeedItem[], loaded: boolean): string {
  const [baseline, setBaseline] = useState<readonly FeedItem[] | null>(null);
  const [message, setMessage] = useState("");
  if (loaded && baseline !== items) {
    // State derived from props during render: the documented alternative to an effect.
    setBaseline(items);
    const sentence = baseline === null ? null : describeArrivals(newArrivals(items, baseline));
    if (sentence !== null) {
      setMessage(sentence);
    }
  }
  return message;
}

function SystemAlertBanners() {
  const alerts = useActiveAlerts();
  const raised = useMemo(() => raisedAlerts(alerts), [alerts]);
  if (raised.length === 0) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 pb-2">
      {raised.map((alert) => (
        <SystemAlertBanner key={alert.alert_id} alert={alert} />
      ))}
    </div>
  );
}

interface NewPillProps {
  count: number;
  onClick: () => void;
}

function NewPill({ count, onClick }: NewPillProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      data-testid={tid.alerts.newPill}
      onClick={onClick}
      className="rounded-full tabular-nums motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      {ARROW_UP}
      {count} new <span className="sr-only">alerts, scroll to the newest</span>
    </Button>
  );
}

export default function AlertsPanel() {
  const events = useEvents();
  const decisions = useDecisions();
  const tickets = useTickets("all");
  const eventItems = events.data?.items;
  const decisionItems = decisions.data?.items;
  const ticketItems = tickets.data?.items;
  const items = useMemo(
    () =>
      buildFeed(eventItems ?? NO_EVENTS, decisionItems ?? NO_DECISIONS, ticketItems ?? NO_TICKETS),
    [eventItems, decisionItems, ticketItems],
  );

  const listRef = useRef<HTMLDivElement>(null);
  const { atTop, scrollToTop } = useScrollTop(listRef);
  const unseen = useUnseenCount(items, atTop);

  const sources = [events, decisions, tickets];
  const failed = sources.filter((query) => query.isError);
  const loading = sources.every((query) => query.isPending);
  const announcement = useArrivalAnnouncement(
    items,
    sources.every((query) => query.isSuccess),
  );
  const retry = () => {
    for (const query of failed) {
      void query.refetch();
    }
  };

  let body;
  if (loading) {
    body = LOADING_ROWS;
  } else if (items.length === 0) {
    body = failed.length === 0 ? EMPTY_FEED : null;
  } else {
    body = (
      <ul aria-label="Alert feed" data-testid={tid.alerts.list}>
        {items.map((item) => (
          <AlertItem key={item.key} item={item} />
        ))}
      </ul>
    );
  }

  return (
    <Panel
      title="Alerts"
      actions={unseen > 0 ? <NewPill count={unseen} onClick={scrollToTop} /> : undefined}
    >
      <div className="flex h-full min-h-0 flex-col">
        <SystemAlertBanners />
        {failed.length === 0 ? null : (
          <ErrorState
            message="Couldn't load alerts."
            detail={failed[0]?.error?.message}
            onRetry={retry}
          />
        )}
        <ScrollArea ref={listRef} className="min-h-0 flex-1 max-lg:h-96 max-lg:flex-none">
          {body}
        </ScrollArea>
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </p>
      </div>
    </Panel>
  );
}

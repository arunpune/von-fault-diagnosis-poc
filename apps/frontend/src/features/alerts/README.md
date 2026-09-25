<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Alerts

`App.tsx` renders the default export of `AlertsPanel.tsx` from this fixed path below the simulation controls, where it takes the rest of the rail's height: the feed of suspect events, decisions and ticket changes and the system alert banners.

- `feed.ts` — `buildFeed(events, decisions, tickets)`, a pure function over the three query caches (`useEvents()`, `useDecisions()`, `useTickets("all")`): newest first by sim time, capped at `FEED_CAP` (300). Item keys are `suspect-<event_id>`, `decision-<decision_id>` and `ticket-<ticket_id>`, so a row's test id is `tid.alerts.item(key)`. A suspect event links to the decision that answered it, or to nothing yet. `newArrivals` and `describeArrivals` drive the "N new" pill and the live announcements.
- `AlertItem.tsx` — one row: kind icon, `SeverityBadge`, title, facts; a link to `#/decisions/<id>` or `#/tickets/<id>` that preloads the sheet's chunk on hover or focus (`LazyDecisionSheet.preload()` / `LazyTicketSheet.preload()`).
- `SystemAlertBanner.tsx`, `system-alerts.ts` — one destructive banner per raised alert of the live store (`useActiveAlerts()` of `@/store/live-store`), worded from `kind` and `details`.
- `use-scroll-top.ts` — whether the list is at its top, and the scroll back used by the pill.

Arriving decisions and ticket changes are announced through a polite live region of their own; suspect events are not, and the feed as first loaded is never read out. `alerts-flow.test.tsx` renders `<App/>`, dispatches the `event.suspect`, `decision` and `ticket` frames and follows the feed into the decision sheet and on to the ticket. The frames go through the page's own cache reducers (`installWsCache` of `@/api/ws-cache`), as the live feed installs them.

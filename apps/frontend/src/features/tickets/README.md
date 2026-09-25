<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Tickets

`App.tsx` renders the default export of `TicketsTab.tsx`, the bottom tab open on load, and loads the default export of `TicketSheet.tsx` lazily, both from these fixed paths; the sheet follows the `#/tickets/<id>` hash route with the props `{ ticketId: string | null; onClose(): void }`. Rows that open the sheet call `LazyTicketSheet.preload()` on hover or focus.

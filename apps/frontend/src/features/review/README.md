<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Review

`App.tsx` loads the default export of `ReviewTab.tsx` lazily from this fixed path as the Review tab, preloading it when the tab trigger is hovered or focused: the tickets whose latest decision landed in the review band, read from `GET /api/tickets?status=review`.

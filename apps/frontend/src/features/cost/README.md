<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Cost

`App.tsx` loads the default export of `CostTab.tsx` lazily from this fixed path as the Cost tab, preloading it when the tab trigger is hovered or focused: the running total, prices with their as-of date, the per-backend split and the per-decision ledger.

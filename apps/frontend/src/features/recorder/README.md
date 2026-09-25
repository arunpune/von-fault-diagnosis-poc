<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Recorder

`App.tsx` renders the default export of `RecorderPanel.tsx` from this fixed path; the panel is part of the first paint, so it stays a static import. Its Recharts-drawn charts are not: `RecorderCharts.tsx` is a chunk of its own that the panel starts loading when it mounts, which keeps Recharts out of the initial bundle.

| File | What it does |
| --- | --- |
| `RecorderPanel.tsx` | The panel: window toggle, "Reference windows" switch, "Re-anchoring…", empty and error states; `data-sim-now` on the root; the charts behind Suspense |
| `RecorderCharts.tsx` | The lazily loaded charts: the lanes with their readouts, the rows, the time axis and the legend |
| `lanes.ts` | The lane table by recording column, resolved against `GET /api/signals`; what the registry lacks is named in a muted note |
| `Lane.tsx`, `LaneHeader.tsx` | One memoised Recharts lane inside the shadcn chart container, and its readouts, memoised apart |
| `StateStrip.tsx` | The machine-state, LPS, Towers and alarm rows as ReferenceArea segments |
| `overlay-model.ts`, `OverlayBands.tsx` | The reference windows: failure, excluded and injection bands and marker lines, their hatch patterns and legend |
| `TimeAxis.tsx` | The one visible time axis under the rows |

The data comes from `src/store/telemetry-store.ts` (flush scheduler and hooks) over `src/store/telemetry-buffer.ts` (rings and transition lists), with `src/lib/downsample.ts` and `src/lib/machine-state.ts`. Frames never reach React one by one: the store publishes at most four versions a second, and each lane re-renders only when its own slice moved.

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The chart recorder, the one bold element of the page: stacked lanes of the key signals on one
// shared sim-time axis, the machine-state and alarm rows under them and the reference windows
// across them. App.tsx renders this default export from this fixed path.
//
// Only the panel root follows the store's clock (for `data-sim-now`); everything under it is
// memoised and reads its own slice from the telemetry store, so a flush re-renders the lanes
// whose data moved and nothing else. A window change is deferred, so the toggle answers at once
// and the lanes follow when React has time (vercel rerender-use-deferred-value). The charts
// themselves (RecorderCharts.tsx) are a separate chunk that the panel starts loading when it
// mounts, so Recharts stays out of the first paint (vercel bundle-dynamic-imports). The lanes
// and rows are taller than the panel on most screens and hold nothing focusable, so the body is
// a named tab stop the keyboard can scroll.

import { memo, Suspense, useDeferredValue, useEffect, useId, useMemo } from "react";

import { useSignals } from "@/api/queries";
import { Panel } from "@/components/app-shell/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { RecorderChartsProps } from "@/features/recorder/RecorderCharts";
import { resolveLayout } from "@/features/recorder/lanes";
import { lazyWithPreload } from "@/lib/lazy";
import { tid } from "@/lib/testids";
import { setUiPref, useUiPref, WINDOW_MS_CHOICES, type WindowMs } from "@/store/ui-prefs";
import { configureRecorder, useReanchoring, useRecorderNow } from "@/store/telemetry-store";

/** The charts draw with Recharts, which stays out of the first paint. */
const LazyRecorderCharts = lazyWithPreload<RecorderChartsProps>(
  () => import("@/features/recorder/RecorderCharts"),
);

function preloadCharts(): void {
  void LazyRecorderCharts.preload();
}

const WINDOW_LABELS: Readonly<Record<WindowMs, { short: string; long: string }>> = {
  3_600_000: { short: "1 h", long: "Last hour" },
  21_600_000: { short: "6 h", long: "Last 6 hours" },
  86_400_000: { short: "24 h", long: "Last 24 hours" },
};

const EMPTY = (
  <div data-testid={tid.recorder.empty}>
    <EmptyState>Press Play to start the replay.</EmptyState>
  </div>
);

const LOADING = (
  <div role="status" className="space-y-3 px-4 py-3">
    <span className="sr-only">Loading the signal map</span>
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-20 w-full" />
  </div>
);

function onWindowChange(value: string): void {
  const windowMs = WINDOW_MS_CHOICES.find((choice) => String(choice) === value);
  if (windowMs !== undefined) {
    setUiPref("windowMs", windowMs);
  }
}

function onOverlaysChange(checked: boolean): void {
  setUiPref("overlays", checked);
}

interface RecorderActionsProps {
  windowMs: WindowMs;
  overlays: boolean;
  reanchoring: boolean;
}

/** The header controls; memoised, since the panel root re-renders with every new point. */
const RecorderActions = memo(function RecorderActions({
  windowMs,
  overlays,
  reanchoring,
}: RecorderActionsProps) {
  const switchId = useId();
  return (
    <>
      {reanchoring ? (
        <span role="status" className="text-xs text-muted-foreground">
          Re-anchoring…
        </span>
      ) : null}
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        spacing={0}
        value={String(windowMs)}
        onValueChange={onWindowChange}
        aria-label="Time window"
        data-testid={tid.recorder.window}
      >
        {WINDOW_MS_CHOICES.map((choice) => (
          <ToggleGroupItem
            key={choice}
            value={String(choice)}
            aria-label={WINDOW_LABELS[choice].long}
            className="tabular-nums"
          >
            {WINDOW_LABELS[choice].short}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex items-center gap-2">
        <Switch
          id={switchId}
          checked={overlays}
          onCheckedChange={onOverlaysChange}
          data-testid={tid.recorder.overlays}
        />
        <label htmlFor={switchId} className="text-sm">
          Reference windows
        </label>
      </div>
    </>
  );
});

function MissingNote({ missing }: { missing: readonly string[] }) {
  if (missing.length === 0) {
    return null;
  }
  return (
    <p className="px-4 pb-3 text-xs text-muted-foreground">
      Not available in this signal map: {missing.join(", ")}.
    </p>
  );
}

interface RecorderContentProps {
  windowMs: WindowMs;
  overlays: boolean;
  hasData: boolean;
}

const RecorderContent = memo(function RecorderContent({
  windowMs,
  overlays,
  hasData,
}: RecorderContentProps) {
  const signals = useSignals();
  const layout = useMemo(
    () => (signals.data === undefined ? null : resolveLayout(signals.data.signals)),
    [signals.data],
  );
  useEffect(() => {
    if (layout !== null) {
      configureRecorder(layout.config);
    }
  }, [layout]);
  const deferredWindow = useDeferredValue(windowMs);

  if (signals.isError) {
    return (
      <ErrorState
        message="Couldn't load the signal map."
        detail={signals.error.message}
        onRetry={() => void signals.refetch()}
      />
    );
  }
  let body = EMPTY;
  if (hasData) {
    body =
      layout === null ? (
        LOADING
      ) : (
        <Suspense fallback={LOADING}>
          <LazyRecorderCharts layout={layout} windowMs={deferredWindow} overlays={overlays} />
        </Suspense>
      );
  }
  return (
    <>
      {body}
      <MissingNote missing={layout?.missing ?? []} />
    </>
  );
});

export default function RecorderPanel() {
  const windowMs = useUiPref("windowMs");
  const overlays = useUiPref("overlays");
  const now = useRecorderNow();
  const reanchoring = useReanchoring();
  // After the first paint, and long before the first telemetry frame needs the charts.
  useEffect(preloadCharts, []);
  return (
    <Panel
      title="Recorder"
      focusableBody
      className="flex-1"
      data-testid={tid.recorder.root}
      data-sim-now={now === null ? undefined : String(now)}
      actions={
        <RecorderActions windowMs={windowMs} overlays={overlays} reanchoring={reanchoring} />
      }
    >
      <RecorderContent windowMs={windowMs} overlays={overlays} hasData={now !== null} />
    </Panel>
  );
}

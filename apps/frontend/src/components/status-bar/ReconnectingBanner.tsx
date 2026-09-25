// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The banner under the status bar while the live link is down: it appears once the link has been
// reconnecting for 5 s, so a blip never flashes it, and goes as soon as the link is back. The
// countdown lives in a child mounted for each outage, so every new outage starts it afresh.

import WifiOffIcon from "lucide-react/dist/esm/icons/wifi-off";
import { useEffect, useState } from "react";

import {
  RECONNECT_BANNER_DELAY_MS,
  selectReconnecting,
} from "@/components/status-bar/status-words";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useLiveValue } from "@/store/live-store";

function OverdueReconnectAlert() {
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setOverdue(true);
    }, RECONNECT_BANNER_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  if (!overdue) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 top-full z-40 px-4 pt-2">
      <Alert className="pointer-events-auto max-w-md border-accent-signal shadow-sm">
        <WifiOffIcon aria-hidden="true" />
        <AlertTitle>Reconnecting to the backend…</AlertTitle>
        <AlertDescription>
          The view keeps the last values it received and catches up once the link is back.
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function ReconnectingBanner() {
  const reconnecting = useLiveValue(selectReconnecting);
  return reconnecting ? <OverdueReconnectAlert /> : null;
}

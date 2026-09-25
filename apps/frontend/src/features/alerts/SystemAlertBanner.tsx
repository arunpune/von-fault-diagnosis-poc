// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One backend watchdog alarm as a banner above the alerts feed: the destructive shadcn Alert,
// worded from the alert's kind and details. There is no dismiss button: the backend clears the
// alert itself when telemetry or the decision API comes back, and the banner goes with it. As an
// alert role, it is announced the moment it appears.

import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { memo } from "react";

import type { AlertSystem } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { systemAlertDetail, systemAlertTitle } from "@/features/alerts/system-alerts";
import { tid } from "@/lib/testids";

const ICON = <TriangleAlertIcon aria-hidden="true" />;

export interface SystemAlertBannerProps {
  alert: AlertSystem;
}

export const SystemAlertBanner = memo(function SystemAlertBanner({
  alert,
}: SystemAlertBannerProps) {
  const detail = systemAlertDetail(alert);
  return (
    <Alert variant="destructive" data-testid={tid.alerts.banner(alert.kind)}>
      {ICON}
      <AlertTitle>{systemAlertTitle(alert)}</AlertTitle>
      {detail === null ? null : <AlertDescription>{detail}</AlertDescription>}
    </Alert>
  );
});

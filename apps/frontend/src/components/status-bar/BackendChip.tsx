// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The decision backend as a chip: "Von · von-1.13.0", "Claude · <model>" or "Rules".
// `BackendChip` shows any backend and model — the decision sheet passes the decision's own — and
// `LiveBackendChip` the one answering now: the backend status's, else the one the `hello` frame
// announced.

import type { ComponentProps } from "react";

import { backendLabel } from "@/components/status-bar/status-words";
import { Badge } from "@/components/ui/badge";
import { tid } from "@/lib/testids";
import { useDecisionBackend, type BackendIdentity } from "@/store/live-store";

export interface BackendChipProps extends Omit<ComponentProps<typeof Badge>, "children"> {
  /** The backend and its model; null while not known. */
  backend: BackendIdentity | null;
}

export function BackendChip({ backend, ...props }: BackendChipProps) {
  const label = backendLabel(backend);
  return (
    <Badge
      variant="outline"
      title={
        backend === null ? "The decision backend is not known yet" : `Decision backend: ${label}`
      }
      {...props}
    >
      {label}
    </Badge>
  );
}

export function LiveBackendChip() {
  const backend = useDecisionBackend();
  return <BackendChip backend={backend} data-testid={tid.status.backend} />;
}

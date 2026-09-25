// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Signal tag ids as the manual names them, for the evidence table and the expected signal moves
// of the decision sheet. The registry comes from `GET /api/signals` once per page; until it
// arrives every id reads as its humanised self.

import { useMemo } from "react";

import { useSignals } from "@/api/queries";
import type { SignalLabelLookup } from "@/features/decisions/signal-moves";

export function useSignalLabels(): SignalLabelLookup {
  const registry = useSignals().data;
  return useMemo(() => {
    const labels = new Map(
      registry?.signals.map((signal): [string, string] => [signal.signal_id, signal.label]),
    );
    return (signalId: string) => labels.get(signalId);
  }, [registry]);
}

// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Cost tab. App.tsx loads this default export lazily from this fixed path. The running
// total and the per-backend split sit beside the per-decision ledger (one column under
// 1024 px). It renders from the `['cost']` and decisions caches alone: the `cost.update`
// reducer patches the totals in place and invalidates the key, and `decision` frames land in
// the decisions cache, so a pushed decision moves the numbers and grows the ledger without
// this tab doing anything.

import { useCost } from "@/api/queries";
import { ErrorState } from "@/components/common/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { CostLedger } from "@/features/cost/CostLedger";
import { CostSummary } from "@/features/cost/CostSummary";

const LOADING = (
  <div role="status" className="space-y-2 px-4 py-3">
    <span className="sr-only">Loading the cost</span>
    <Skeleton className="h-4 w-1/4" />
    <Skeleton className="h-4 w-1/3" />
    <Skeleton className="h-4 w-1/2" />
  </div>
);

export default function CostTab() {
  const cost = useCost();

  if (cost.isPending) {
    return LOADING;
  }
  if (cost.isError) {
    return (
      <ErrorState
        message="Couldn't load the cost."
        detail={cost.error.message}
        onRetry={() => void cost.refetch()}
      />
    );
  }
  return (
    <div className="grid gap-x-8 gap-y-6 px-4 py-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <CostSummary cost={cost.data} />
      <CostLedger recent={cost.data.recent} totalUsd={cost.data.totals.usd} />
    </div>
  );
}

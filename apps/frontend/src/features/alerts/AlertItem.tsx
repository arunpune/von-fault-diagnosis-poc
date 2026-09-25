// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One row of the alerts feed: the kind's icon, the severity badge with its word, the title and
// the facts under it. A row that has a sheet to open is a link to its hash route, so a click,
// Enter or a middle click all work the way links do, and hovering or focusing it starts loading
// the sheet's chunk. Rows skip layout and paint while they are scrolled out of view
// (`content-visibility: auto`, the rendering-content-visibility rule).

import type { LucideIcon } from "lucide-react";
import ActivityIcon from "lucide-react/dist/esm/icons/activity";
import CircleXIcon from "lucide-react/dist/esm/icons/circle-x";
import StethoscopeIcon from "lucide-react/dist/esm/icons/stethoscope";
import TicketIcon from "lucide-react/dist/esm/icons/ticket";
import { memo } from "react";

import { LazyDecisionSheet, LazyTicketSheet } from "@/components/app-shell/lazy-panels";
import { SeverityBadge } from "@/components/common/SeverityBadge";
import type { FeedItem, FeedKind } from "@/features/alerts/feed";
import { hashRouteHref, type HashRouteKind } from "@/lib/hash-route";
import { tid } from "@/lib/testids";
import { cn } from "@/lib/utils";

interface KindStyle {
  readonly Icon: LucideIcon;
  /** The icon's tint: amber for attention, steel for an answer, red for a failure. */
  readonly tone: string;
  /** Said before the title when the title alone does not name the kind. */
  readonly spokenKind: string | null;
}

const KIND_STYLES: Readonly<Record<FeedKind, KindStyle>> = {
  suspect: { Icon: ActivityIcon, tone: "text-accent-signal", spokenKind: null },
  decision: { Icon: StethoscopeIcon, tone: "text-primary", spokenKind: "Decision" },
  decision_failed: { Icon: CircleXIcon, tone: "text-destructive", spokenKind: null },
  ticket: { Icon: TicketIcon, tone: "text-foreground", spokenKind: null },
};

const PRELOADERS: Readonly<Record<HashRouteKind, () => void>> = {
  decision: () => void LazyDecisionSheet.preload(),
  ticket: () => void LazyTicketSheet.preload(),
};

const ROW_CLASS =
  "grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 px-4 py-2 text-left";

/**
 * The row's content. It is read in source order — title, severity, facts — with hidden commas
 * between the parts, so a link is named "Decision: Oil cooler fouled, severity high, 91 %,
 * Ticket, …" instead of running the words together; the badge still shows before the title.
 * The spaces sit in text nodes of their own, outside the hidden spans, because name
 * computation trims each element's text; where they would show, they lead a line and collapse.
 */
function ItemBody({ item }: { item: FeedItem }) {
  const { Icon, tone, spokenKind } = KIND_STYLES[item.kind];
  return (
    <>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4", tone)} />
      <span className="flex min-w-0 items-center gap-2">
        <span className="order-2 truncate font-medium" title={item.title}>
          {spokenKind === null ? null : <span className="sr-only">{spokenKind}:</span>} {item.title}
        </span>
        {item.severity === undefined ? null : (
          <span className="order-1 flex">
            <span className="sr-only">, severity</span> <SeverityBadge level={item.severity} />
          </span>
        )}
      </span>
      <span className="col-start-2 flex flex-wrap gap-x-3 text-meta text-muted-foreground tabular-nums">
        {item.meta.map((fact) => (
          <span key={fact}>
            <span className="sr-only">,</span> {fact}
          </span>
        ))}
      </span>
    </>
  );
}

export interface AlertItemProps {
  item: FeedItem;
}

export const AlertItem = memo(function AlertItem({ item }: AlertItemProps) {
  const { ref } = item;
  return (
    <li
      data-testid={tid.alerts.item(item.key)}
      data-kind={item.kind}
      className="border-b [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto] last:border-b-0"
    >
      {ref === null ? (
        <div className={ROW_CLASS}>
          <ItemBody item={item} />
        </div>
      ) : (
        <a
          href={hashRouteHref(ref.kind, ref.id)}
          onPointerEnter={PRELOADERS[ref.kind]}
          onFocus={PRELOADERS[ref.kind]}
          className={cn(
            ROW_CLASS,
            "outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          )}
        >
          <ItemBody item={item} />
        </a>
      )}
    </li>
  );
});

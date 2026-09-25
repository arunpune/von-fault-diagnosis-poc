// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// An identifier that is a code — fault id, alarm code, rule id, ticket or decision id — in IBM
// Plex Mono, the only place the mono face appears. With `short`, a long id shows its last six
// characters and keeps the full id in the title.

import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface CodeProps {
  value: string;
  /** Show `shortId(value)`; the full value goes to the tooltip. */
  short?: boolean;
  className?: string;
}

export function Code({ value, short = false, className }: CodeProps) {
  const shown = short ? shortId(value) : value;
  return (
    <code
      title={shown === value ? undefined : value}
      className={cn("font-mono text-[0.8125rem] break-all", className)}
    >
      {shown}
    </code>
  );
}

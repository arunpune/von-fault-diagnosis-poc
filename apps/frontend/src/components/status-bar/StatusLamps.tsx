// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The three lamps of the status bar and the gateway's dropped-sample count. Each subscribes to the
// one word it shows, so a new simulator status re-renders none of them and a backend status
// re-renders only the lamp whose word it changed.

import {
  LAMP_VARIANT,
  selectDecisionsWord,
  selectDroppedFrames,
  selectDroppedSamples,
  selectLinkNote,
  selectLinkWord,
  selectTelemetryWord,
  type DecisionsWord,
  type HeartbeatWord,
  type LinkWord,
} from "@/components/status-bar/status-words";
import { Lamp } from "@/components/status-bar/Lamp";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtNumber } from "@/lib/format";
import { tid } from "@/lib/testids";
import { useLiveValue } from "@/store/live-store";

const LINK_TOOLTIP: Readonly<Record<LinkWord, string>> = {
  open: "Live updates are streaming from the backend.",
  connecting: "Opening the live connection to the backend.",
  reconnecting: "The live connection dropped; retrying with a growing pause.",
  closed: "The live connection is closed.",
  incompatible: "The backend speaks another message version.",
};

const TELEMETRY_TOOLTIP: Readonly<Record<HeartbeatWord, string>> = {
  ok: "The backend is receiving telemetry, or the replay is not playing.",
  silent: "No telemetry reached the backend within its timeout while the replay is playing.",
  unknown: "Waiting for the backend's status.",
};

const DECISIONS_TOOLTIP: Readonly<Record<DecisionsWord, string>> = {
  ok: "The decision model is answering.",
  silent: "The decision model keeps failing; no call has succeeded since.",
  unknown: "Waiting for the backend's status.",
  "no model": "The rules backend decides without calling a model.",
};

function droppedSentence(count: number): string | null {
  if (count === 0) {
    return null;
  }
  return count === 1
    ? "1 malformed message was ignored."
    : `${fmtNumber(count, 0)} malformed messages were ignored.`;
}

export function LinkLamp() {
  const word = useLiveValue(selectLinkWord);
  const note = useLiveValue(selectLinkNote);
  const dropped = useLiveValue(selectDroppedFrames);
  const explanation = word === "incompatible" && note !== null ? note : LINK_TOOLTIP[word];
  const tooltip = [explanation, droppedSentence(dropped)].filter(Boolean).join(" ");
  return (
    <Lamp
      data-testid={tid.status.link}
      variant={LAMP_VARIANT[word]}
      label="Link"
      state={word}
      tooltip={tooltip}
    />
  );
}

export function TelemetryLamp() {
  const word = useLiveValue(selectTelemetryWord);
  return (
    <Lamp
      data-testid={tid.status.telemetry}
      variant={LAMP_VARIANT[word]}
      label="Telemetry"
      state={word}
      tooltip={TELEMETRY_TOOLTIP[word]}
    />
  );
}

export function DecisionsLamp() {
  const word = useLiveValue(selectDecisionsWord);
  return (
    <Lamp
      data-testid={tid.status.decisions}
      variant={LAMP_VARIANT[word]}
      label="Decisions"
      state={word}
      tooltip={DECISIONS_TOOLTIP[word]}
    />
  );
}

/** "dropped N", muted, beside the telemetry lamp while the gateway has missed samples. */
export function GatewayDropped() {
  const dropped = useLiveValue(selectDroppedSamples);
  if (dropped <= 0) {
    return null;
  }
  const count = fmtNumber(dropped, 0);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 text-meta whitespace-nowrap text-muted-foreground tabular-nums">
          dropped {count}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        The gateway missed {count} {dropped === 1 ? "sample" : "samples"}: the simulator overwrote
        them before they were read.
      </TooltipContent>
    </Tooltip>
  );
}

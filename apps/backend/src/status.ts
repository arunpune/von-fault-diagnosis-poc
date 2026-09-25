// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The retained `status-backend` message.
 *
 * The backend says who it is and how it is doing on
 * `plant/{unit}/status/backend`: which decision backend and model answer, the
 * counters of the decision calls, the two watchdogs, how many episodes and
 * tickets are open, and the version that publishes. The message is retained,
 * so a UI or a broker client that connects late sees the current picture at
 * once, and it is published every five seconds and on every change — with a
 * 200 ms window that folds a burst of changes, such as a decision that also
 * opened a ticket, into one message.
 *
 * The field names are the contract's (`backend { name, model }`, `decision`,
 * `heartbeat`, `episodes_open`, `tickets_open`, `version`), and the schema is
 * binding.
 *
 * The publisher owns its two timers and nothing else. What it reports comes
 * through {@link StatusSources}, read at the moment a message is built, so the
 * numbers are never older than the message; where it goes is the `publish`
 * port, which the runtime points at the broker (retained) and the WebSocket
 * hub (`status.backend`). A "change" is a difference in content: a message
 * that would say what the last one said is not sent early.
 */

import { assertValid, toIsoMs } from "@fdp/contracts";
import type { StatusBackend } from "@fdp/contracts";

import type { WallClock } from "./clock.ts";
import type { DecisionBackendName } from "./decision/types.ts";
import type { HeartbeatSnapshot } from "./heartbeat/index.ts";

/** The schema id every status-backend message repeats. */
export const STATUS_BACKEND_SCHEMA = "urn:fdp:schema:status-backend:v1";

/** The retained refresh interval. */
export const STATUS_INTERVAL_MS = 5_000;

/** How long a change waits for the changes that come with it. */
export const STATUS_DEBOUNCE_MS = 200;

/** What does not change while the process runs. */
export interface StatusInfo {
  readonly unitId: string;
  readonly backend: DecisionBackendName;
  /** The pinned model of the selected backend; `rules-v1` for the rules twin. */
  readonly model: string;
  /** The backend's own version (`pipeline/index.ts` `VERSION`). */
  readonly version: string;
}

/** Where the changing numbers come from; each is read when a message is built. */
export interface StatusSources {
  heartbeat(): HeartbeatSnapshot;
  episodesOpen(): number;
  ticketsOpen(): number;
}

/** What {@link createStatusPublisher} is composed of. */
export interface StatusPublisherPorts {
  /**
   * Where each message goes. It is called from a timer, so it must not throw:
   * the runtime's implementation reports its own broker or socket failures.
   */
  readonly publish: (message: StatusBackend) => void;
  readonly wall: WallClock;
  readonly info: StatusInfo;
  readonly sources: StatusSources;
  /** Defaults to {@link STATUS_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /** Defaults to {@link STATUS_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
}

/** The status publisher of one backend process. */
export interface StatusPublisher {
  /** Publish now and every interval from here on; a second call does nothing. */
  start(): void;
  /** Stop both timers; nothing is published after it returns. */
  stop(): void;
  /** Something the message reports may have changed; publish within the debounce window. */
  notify(): void;
  /** The message as it would be built now, for `GET /api/status` (`api-status.backend`). */
  current(): StatusBackend;
}

/**
 * Build one `status-backend` message.
 *
 * @throws SchemaValidationError when a source reports something off-contract.
 */
export function buildStatusBackend(
  info: StatusInfo,
  sources: StatusSources,
  wallTs: string,
): StatusBackend {
  const heartbeat = sources.heartbeat();
  return assertValid("status-backend", {
    schema: STATUS_BACKEND_SCHEMA,
    unit_id: info.unitId,
    wall_ts: wallTs,
    backend: { name: info.backend, model: info.model },
    decision: { ...heartbeat.decision },
    heartbeat: {
      telemetry_silent: heartbeat.telemetry_silent,
      decision_api_silent: heartbeat.decision_api_silent,
    },
    episodes_open: sources.episodesOpen(),
    tickets_open: sources.ticketsOpen(),
    version: info.version,
  });
}

/** A message's content without the instant it was built at, for the change test. */
function contentOf(message: StatusBackend): string {
  // `JSON.stringify` drops a property whose value is `undefined`.
  return JSON.stringify({ ...message, wall_ts: undefined });
}

/** The publisher: retained every interval, and on change. */
export function createStatusPublisher(ports: StatusPublisherPorts): StatusPublisher {
  const { publish, wall, info, sources } = ports;
  const intervalMs = ports.intervalMs ?? STATUS_INTERVAL_MS;
  const debounceMs = ports.debounceMs ?? STATUS_DEBOUNCE_MS;

  let interval: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastContent: string | undefined;

  function current(): StatusBackend {
    return buildStatusBackend(info, sources, toIsoMs(wall.now()));
  }

  function send(message: StatusBackend): void {
    lastContent = contentOf(message);
    publish(message);
  }

  function publishIfChanged(): void {
    pending = undefined;
    const message = current();
    if (contentOf(message) !== lastContent) send(message);
  }

  return {
    start() {
      if (interval !== undefined) return;
      send(current());
      interval = setInterval(() => send(current()), intervalMs);
    },

    stop() {
      if (interval !== undefined) clearInterval(interval);
      if (pending !== undefined) clearTimeout(pending);
      interval = undefined;
      pending = undefined;
    },

    notify() {
      if (interval === undefined || pending !== undefined) return;
      pending = setTimeout(publishIfChanged, debounceMs);
    },

    current,
  };
}

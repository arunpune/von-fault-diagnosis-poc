// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/signals` (contracts `api-signals`).
 *
 * The signal registry the recorder resolves its lanes with, so the frontend
 * needs no register map of its own. The registry is the contracts' generated
 * one (`SIGNALS`, in register order); the manual's normal bands are folded in
 * from `app.catalog_signals` once init has ingested it, and are simply absent
 * before.
 *
 * The register map names a signal twice: `name` is the manual's English name
 * and `label` the short tag printed on the panel (`P1`, `D6`). The contract's
 * `label` is the English name and its `panel_label` the short one. A digital
 * state has no unit (`""`), as in `api-telemetry-series`, and a tag the
 * recording has no column for is `synthetic`.
 */

import { assertValid, SIGNALS, type ApiSignals, type Signal, type SignalDef } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import { signalKind } from "../ingest/types.ts";
import type { CatalogReader } from "./deps.ts";

/** One registry signal as the user interface reads it. */
export function toSignalDef(
  signal: Signal,
  band: Readonly<Record<string, unknown>> | undefined,
): SignalDef {
  const kind = signalKind(signal);
  return {
    signal_id: signal.tag,
    label: signal.name,
    panel_label: signal.label,
    unit: kind === "digital" ? "" : signal.unit,
    kind,
    metropt_column: signal.metropt_column,
    source: signal.metropt_column === null ? "synthetic" : "recorded",
    scale: signal.scale,
    ...(band === undefined ? {} : { normal_bands: { ...band } }),
  };
}

export function signalsRoutes(catalog: Pick<CatalogReader, "normalBands">): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/signals", async (): Promise<ApiSignals> => {
      const bands = await catalog.normalBands();
      return assertValid("api-signals", {
        signals: SIGNALS.map((signal) => toSignalDef(signal, bands.get(signal.tag))),
      });
    });
  };
}

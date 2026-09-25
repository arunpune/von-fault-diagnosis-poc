// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { DecisionBackend, StatusBackend, StatusSim } from "@/api/types";
import {
  backendLabel,
  datasetFraction,
  LAMP_VARIANT,
  selectDatasetPermille,
  selectDatasetRange,
  selectDecisionsWord,
  selectDroppedSamples,
  selectLinkWord,
  selectReconnecting,
  selectSimSpeed,
  selectSimState,
  selectTelemetryWord,
} from "@/components/status-bar/status-words";
import { getLiveState, type LiveState } from "@/store/live-store";
import { fixtures } from "@/test/msw/fixtures";

const initial: LiveState = getLiveState();

function simStatus(): StatusSim {
  if (fixtures.status.sim === null) {
    throw new Error("status.json carries a sim status");
  }
  return fixtures.status.sim;
}

function backend(
  heartbeat: StatusBackend["heartbeat"],
  name: DecisionBackend = "jev",
): StatusBackend {
  return {
    ...fixtures.status.backend,
    backend: { name, model: name === "rules" ? "rules-v1" : "jev-1.13.0" },
    heartbeat,
  };
}

function live(patch: Partial<LiveState>): LiveState {
  const merged = { ...initial, link: "open" as const, ...patch };
  const identity = merged.backend === null ? merged.hello : merged.backend.backend;
  return { ...merged, decisionBackend: identity };
}

const QUIET = { telemetry_silent: false, decision_api_silent: false };

describe("the lamp words", () => {
  it("say what the link does, and incompatible when hello was refused", () => {
    expect(selectLinkWord(live({ link: "connecting" }))).toBe("connecting");
    expect(selectLinkWord(live({ link: "open" }))).toBe("open");
    expect(selectLinkWord(live({ link: "open", linkNote: "v2" }))).toBe("incompatible");
    expect(selectLinkWord(live({ link: "reconnecting", linkNote: "v2" }))).toBe("reconnecting");
    expect(selectReconnecting(live({ link: "reconnecting" }))).toBe(true);
    expect(selectReconnecting(live({ link: "connecting" }))).toBe(false);
  });

  it("read the telemetry watchdog, unknown without a status or an open link", () => {
    expect(selectTelemetryWord(live({ backend: backend(QUIET) }))).toBe("ok");
    expect(
      selectTelemetryWord(live({ backend: backend({ ...QUIET, telemetry_silent: true }) })),
    ).toBe("silent");
    expect(selectTelemetryWord(live({ backend: null }))).toBe("unknown");
    expect(selectTelemetryWord(live({ backend: backend(QUIET), link: "reconnecting" }))).toBe(
      "unknown",
    );
  });

  it("read the decision watchdog, and no model for the rules backend", () => {
    const failing = { ...QUIET, decision_api_silent: true };
    expect(selectDecisionsWord(live({ backend: backend(QUIET) }))).toBe("ok");
    expect(selectDecisionsWord(live({ backend: backend(failing) }))).toBe("silent");
    expect(selectDecisionsWord(live({ backend: backend(failing, "rules") }))).toBe("no model");
    expect(selectDecisionsWord(live({ hello: { name: "rules", model: "rules-v1" } }))).toBe(
      "no model",
    );
    expect(selectDecisionsWord(live({ hello: { name: "jev", model: "jev-1.13.0" } }))).toBe(
      "unknown",
    );
    expect(selectDecisionsWord(live({ backend: backend(QUIET), link: "closed" }))).toBe("unknown");
  });

  it("map every word to a dot", () => {
    expect(LAMP_VARIANT).toEqual({
      open: "ok",
      connecting: "off",
      reconnecting: "warn",
      closed: "off",
      incompatible: "warn",
      ok: "ok",
      silent: "warn",
      unknown: "off",
      "no model": "off",
    });
  });
});

describe("the replay readings", () => {
  it("take the state, the speed and the gateway's dropped samples", () => {
    const gateway = fixtures.status.gateway;
    expect(selectSimState(live({ sim: simStatus() }))).toBe("playing");
    expect(selectSimSpeed(live({ sim: simStatus() }))).toBe(600);
    expect(selectSimState(live({}))).toBeNull();
    expect(selectSimSpeed(live({}))).toBeNull();
    expect(selectDroppedSamples(live({}))).toBe(0);
    expect(
      selectDroppedSamples(
        live({ gateway: gateway === null ? null : { ...gateway, dropped_total: 12 } }),
      ),
    ).toBe(12);
  });
});

describe("the dataset position", () => {
  it("places the sim clock between the dataset's first and last row", () => {
    const sim = simStatus();
    expect(datasetFraction({ ...sim, sim_ts: sim.dataset.first_ts })).toBe(0);
    expect(datasetFraction({ ...sim, sim_ts: sim.dataset.last_ts })).toBe(1);
    // 5 Jun 2020 09:48:20 is 10,835,300 s into a dataset of 18,417,590 s.
    expect(datasetFraction(sim)).toBeCloseTo(10_835_300 / 18_417_590, 12);
    expect(selectDatasetPermille(live({ sim }))).toBe(588);
  });

  it("stays inside 0–1 and is null for unreadable instants or an empty span", () => {
    const sim = simStatus();
    expect(datasetFraction({ ...sim, sim_ts: "2019-01-01T00:00:00.000Z" })).toBe(0);
    expect(datasetFraction({ ...sim, sim_ts: "2021-01-01T00:00:00.000Z" })).toBe(1);
    expect(datasetFraction({ ...sim, sim_ts: "soon" })).toBeNull();
    expect(
      datasetFraction({ ...sim, dataset: { ...sim.dataset, last_ts: sim.dataset.first_ts } }),
    ).toBeNull();
    expect(
      selectDatasetPermille(
        live({ sim: { ...sim, dataset: { ...sim.dataset, first_ts: "not a time" } } }),
      ),
    ).toBeNull();
    expect(selectDatasetPermille(live({}))).toBeNull();
  });

  it("names the dataset's extent in UTC", () => {
    expect(selectDatasetRange(live({ sim: simStatus() }))).toBe(
      "2020-02-01 00:00:00 → 2020-09-01 03:59:50 UTC",
    );
    expect(selectDatasetRange(live({}))).toBeNull();
  });
});

describe("backendLabel", () => {
  it("names each backend with its model, the rules backend alone", () => {
    expect(backendLabel({ name: "jev", model: "jev-1.13.0" })).toBe("Jev · jev-1.13.0");
    expect(backendLabel({ name: "llm", model: "claude-opus-5" })).toBe("Claude · claude-opus-5");
    expect(backendLabel({ name: "rules", model: "rules-v1" })).toBe("Rules");
    expect(backendLabel(null)).toBe("No backend yet");
  });

  it("humanises a backend a newer server may add", () => {
    const future = { name: "hybrid_rank", model: "hr-2" } as unknown as {
      name: DecisionBackend;
      model: string;
    };
    expect(backendLabel(future)).toBe("Hybrid rank · hr-2");
  });
});

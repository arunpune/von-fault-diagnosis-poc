// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The mock backend answers every REST route the UI calls and behaves like the real routes where
// a component test would notice.

import { describe, expect, it } from "vitest";

import { fetchJson } from "@/api/client";
import type {
  ApiSimCommandResult,
  ApiTickets,
  DecisionDetail,
  Ticket,
  TicketDetail,
} from "@/api/types";
import { fixtures } from "@/test/msw/fixtures";

/** Every GET route as the endpoints call it. */
const READ_ROUTES = [
  "/api/health",
  "/api/status",
  "/api/signals",
  "/api/telemetry/series?from=2020-06-05T09:40:00.000Z&to=2020-06-05T09:41:12.000Z",
  "/api/events/suspect",
  "/api/decisions",
  `/api/decisions/${fixtures.decision.decision_id}`,
  "/api/tickets?status=all",
  `/api/tickets/${fixtures.ticket.ticket_id}`,
  "/api/cost",
  "/api/alerts/system?active=true",
  `/api/catalog/faults/${fixtures.catalogFault.fault_id}`,
  "/api/overlay/catalog",
  "/api/overlay/active",
  "/api/overlay/injections?from=2020-06-05T00:00:00.000Z",
  "/api/overlay/markers",
] as const;

const SIM_SEGMENTS = ["play", "pause", "speed", "jump", "inject", "clear", "reset"] as const;

function post<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, { method: "POST", body });
}

describe("the msw handlers", () => {
  it.each(READ_ROUTES)("answer GET %s", async (path) => {
    await expect(fetchJson(path)).resolves.toBeTruthy();
  });

  it.each(SIM_SEGMENTS)(
    "answer POST /api/sim/%s with an acknowledgement of its command",
    async (segment) => {
      const args =
        segment === "speed"
          ? { speed: 1200 }
          : segment === "jump"
            ? { preset_id: "f3_air_leak_jun05" }
            : segment === "inject"
              ? { injection_id: "oil_cooler_fouling" }
              : {};
      const result = await post<ApiSimCommandResult>(`/api/sim/${segment}`, { args });

      expect(result.accepted).toBe(true);
      expect(result.ack).toMatchObject({ ok: true, error: null });
    },
  );

  it("echo the effect of play, pause and speed in the acknowledged status", async () => {
    const play = await post<ApiSimCommandResult>("/api/sim/play", { args: {} });
    const pause = await post<ApiSimCommandResult>("/api/sim/pause", { args: {} });
    const speed = await post<ApiSimCommandResult>("/api/sim/speed", { args: { speed: 60 } });
    const noSpeed = await post<ApiSimCommandResult>("/api/sim/speed", { args: {} });

    expect(play.ack?.status.state).toBe("playing");
    expect(pause.ack).toMatchObject({ cmd: "pause", status: { state: "paused" } });
    expect(speed.ack).toMatchObject({ cmd: "set_speed", status: { speed: 60 } });
    expect(noSpeed.ack?.status.speed).toBe(fixtures.simCommandResult.ack?.status.speed);
  });

  it("refuse an unknown preset or injection in the acknowledgement", async () => {
    const jump = await post<ApiSimCommandResult>("/api/sim/jump", {
      args: { preset_id: "nowhere" },
    });
    const inject = await post<ApiSimCommandResult>("/api/sim/inject", {});

    expect(jump.ack).toMatchObject({ ok: false, error: { code: "unknown_preset" } });
    expect(inject.ack).toMatchObject({ ok: false, error: { code: "unknown_injection" } });
  });

  it("answer 404 for an unknown simulator command", async () => {
    await expect(post("/api/sim/fast-forward", { args: {} })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("filter tickets by status and refuse an unknown one", async () => {
    const closed = await fetchJson<ApiTickets>("/api/tickets?status=closed");
    const all = await fetchJson<ApiTickets>("/api/tickets");

    expect(closed.items.map((ticket) => ticket.status)).toEqual(["closed"]);
    expect(all.items).toHaveLength(4);
    await expect(fetchJson("/api/tickets?status=pending")).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
    });
  });

  it("serve any listed ticket with its episode's decisions", async () => {
    const review = fixtures.tickets.items.find((ticket) => ticket.status === "review");
    const detail = await fetchJson<TicketDetail>(`/api/tickets/${review?.ticket_id ?? ""}`);

    expect(detail.decisions.map((decision) => decision.episode_id)).toEqual([review?.episode_id]);
  });

  it("serve the failed decision and every listed one, and 404 an unknown id", async () => {
    const failed = await fetchJson<DecisionDetail>(
      `/api/decisions/${fixtures.decisionFailed.decision_id}`,
    );
    const listed = fixtures.decisions.items.at(-1);
    const fromList = await fetchJson<DecisionDetail>(`/api/decisions/${listed?.decision_id ?? ""}`);

    expect(failed.error).not.toBeNull();
    expect(fromList.decision_id).toBe(listed?.decision_id);
    await expect(fetchJson("/api/decisions/unknown")).rejects.toMatchObject({ status: 404 });
    await expect(fetchJson("/api/tickets/unknown")).rejects.toMatchObject({ status: 404 });
    await expect(fetchJson("/api/catalog/faults/unknown")).rejects.toMatchObject({ status: 404 });
  });

  it("close a ticket with a verdict and answer the closed ticket", async () => {
    const closed = await post<Ticket>(`/api/tickets/${fixtures.ticket.ticket_id}/close`, {
      verdict: "correct",
      note: "Replaced the purge valve kit.",
    });

    expect(closed).toMatchObject({
      ticket_id: fixtures.ticket.ticket_id,
      status: "closed",
      action: "closed",
      closure: { verdict: "correct", note: "Replaced the purge valve kit." },
    });
    expect(closed).not.toHaveProperty("decisions");
  });

  it("refuse a close without a verdict, for an unknown ticket, or for one already closed", async () => {
    const alreadyClosed = fixtures.tickets.items.find((ticket) => ticket.closure !== null);

    await expect(
      post(`/api/tickets/${fixtures.ticket.ticket_id}/close`, { outcome: "correct" }),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(post("/api/tickets/unknown/close", { verdict: "wrong" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      post(`/api/tickets/${alreadyClosed?.ticket_id ?? ""}/close`, { verdict: "wrong" }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("filter the system alerts by whether they are raised", async () => {
    const raised = await fetchJson<{ items: unknown[] }>("/api/alerts/system?active=true");
    const cleared = await fetchJson<{ items: unknown[] }>("/api/alerts/system?active=false");
    const every = await fetchJson<{ items: unknown[] }>("/api/alerts/system");

    expect(raised.items).toHaveLength(1);
    expect(cleared.items).toHaveLength(0);
    expect(every.items).toHaveLength(1);
  });
});

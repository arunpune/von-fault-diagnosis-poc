// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeSocket, FakeWebSocket } from "@/test/fake-websocket";
import { frames } from "@/test/msw/fixtures";

afterEach(() => {
  FakeWebSocket.reset();
});

describe("FakeWebSocket", () => {
  it("is created through createSocket and remembered", () => {
    const socket = createFakeSocket("ws://localhost:3000/ws");

    expect(socket).toBeInstanceOf(FakeWebSocket);
    expect(socket.url).toBe("ws://localhost:3000/ws");
    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    expect(FakeWebSocket.latest()).toBe(socket);
  });

  it("opens, delivers frames and closes through both the on-handlers and the listeners", () => {
    const socket = new FakeWebSocket("ws://localhost:3000/ws");
    // The client side sees a WebSocket, with the typed events of one.
    const client: WebSocket = socket;
    const events: string[] = [];
    client.onopen = () => events.push("onopen");
    client.addEventListener("open", () => events.push("open"));
    client.onmessage = (event) => events.push(`onmessage ${String(event.data)}`);
    client.onclose = (event) => events.push(`onclose ${event.code}`);
    client.addEventListener("close", (event) => events.push(`close ${event.code} ${event.reason}`));

    socket.open();
    socket.message(frames.heartbeat);
    socket.message("not json");
    socket.close(1006, "gone");
    socket.close(1000);

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(events).toEqual([
      "onopen",
      "open",
      `onmessage ${JSON.stringify(frames.heartbeat)}`,
      "onmessage not json",
      "onclose 1006",
      "close 1006 gone",
    ]);
  });

  it("fires an error", () => {
    const socket = new FakeWebSocket("ws://localhost:3000/ws");
    const onError = vi.fn();
    socket.onerror = onError;

    socket.error();

    expect(onError).toHaveBeenCalledOnce();
  });

  it("records what the client sends and refuses to send before it opens", () => {
    const socket = new FakeWebSocket("ws://localhost:3000/ws");
    expect(() => {
      socket.send("early");
    }).toThrow(DOMException);

    socket.open();
    socket.send('{"type":"ping"}');
    socket.send(new Uint8Array([1]));

    expect(socket.sent).toEqual(['{"type":"ping"}', "[binary]"]);
  });

  it("says when no socket was created", () => {
    expect(() => FakeWebSocket.latest()).toThrow("no FakeWebSocket has been created");
  });
});

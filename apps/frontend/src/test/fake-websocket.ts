// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A WebSocket the test drives by hand: pass `createFakeSocket` as the WsClient's `createSocket`,
// then play the server — `open()` accepts the connection, `message()` pushes a frame,
// `close(code)` drops it, `error()` fails it. Every socket created is kept in
// `FakeWebSocket.instances`, so a test can reach the one a reconnect opened. Events fire
// synchronously, which keeps fake-timer tests deterministic.

type Handler<E extends Event> = ((this: WebSocket, event: E) => unknown) | null;

export class FakeWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket created since the last `reset()`, oldest first. */
  static readonly instances: FakeWebSocket[] = [];

  /** The socket created last; throws when none was. */
  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (socket === undefined) {
      throw new Error("no FakeWebSocket has been created");
    }
    return socket;
  }

  /** Forgets every socket created so far. */
  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState: number = FakeWebSocket.CONNECTING;

  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onclose: Handler<CloseEvent> = null;
  onerror: Handler<Event> = null;

  /** What the client sent, in order. The UI never sends, so tests expect this to stay empty. */
  readonly sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new DOMException("the socket is not open", "InvalidStateError");
    }
    this.sent.push(typeof data === "string" ? data : "[binary]");
  }

  /** The server accepts the connection. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire(new Event("open"), this.onopen);
  }

  /** The server pushes a frame: an object is sent as JSON, a string as it is (malformed frames). */
  message(frame: unknown): void {
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.fire(new MessageEvent("message", { data }), this.onmessage);
  }

  /** The connection fails; a real browser follows an error with a close. */
  error(): void {
    this.fire(new Event("error"), this.onerror);
  }

  /** The connection ends, from either side; only the first close fires. */
  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.fire(new CloseEvent("close", { code, reason, wasClean: code === 1000 }), this.onclose);
  }

  private fire<E extends Event>(event: E, handler: Handler<E>): void {
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

/** A `createSocket` for WsClient that hands out FakeWebSockets. */
export function createFakeSocket(url: string): WebSocket {
  return new FakeWebSocket(url);
}

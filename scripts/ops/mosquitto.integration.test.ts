// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The broker integration test: it builds `infra/mosquitto/Dockerfile` with
// testcontainers and proves what the committed configuration actually does.
//
// It is the reference for the assertion style every other area's isolation test
// reuses, because Mosquitto's ACL file behaves differently from what one might
// assume (all verified here):
//
//   * the rules before the first `user` line apply to ANONYMOUS clients only;
//   * a denied SUBSCRIBE is GRANTED — the file is checked at delivery time — so
//     isolation is proven by non-delivery within a window, with a positive
//     control in the same test, never by a SUBACK reason code;
//   * a denied PUBLISH is refused, with PUBACK reason 135 on MQTT 5.
//
// Run it with `pnpm run test:integration` or `make test-integration`; Docker is
// required. Every container takes a random host port and carries the label
// `fdp.worktree`, so parallel worktrees never collide.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import mqtt, { type IClientOptions, type ISubscriptionGrant, type MqttClient } from "mqtt";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const MOSQUITTO_DIR = join(REPO_ROOT, "infra", "mosquitto");
const BASE_IMAGE = "eclipse-mosquitto:2.0.22";
const UNIT_ID = "cau-7";

/** MQTT 5 reason code 0x87: the broker refused the CONNECT or the PUBLISH. */
const NOT_AUTHORIZED = 135;

/** How long a subscriber that IS allowed to read gets to receive. */
const DELIVERY_WINDOW_MS = 2_000;

/** How long a `sim` subscriber gets to prove a denied publish never arrived. */
const SHORT_WINDOW_MS = 500;

/** The committed defaults of infra/mosquitto/passwd.txt. */
const CREDENTIALS = {
  gateway: "gateway",
  sim: "sim",
  "backend-diag": "backend-diag",
  "backend-ops": "backend-ops",
  eval: "eval",
} as const;

type Credential = keyof typeof CREDENTIALS;

/** The one label every container of this file carries, so a worktree can find its own. */
const LABELS = { "fdp.worktree": basename(process.cwd()) };

/** Docker tags are lower case; a per-worktree, per-process name keeps parallel runs apart. */
const IMAGE_NAME = `fdp-mqtt-test:${basename(process.cwd())
  .toLowerCase()
  .replaceAll(/[^a-z0-9._-]/g, "-")}-${process.pid}`;

let clientCounter = 0;

interface ReceivedMessage {
  readonly topic: string;
  readonly payload: string;
}

/**
 * Everything one client received, with a wait that resolves as soon as a topic
 * arrives and returns null when the window closes.
 *
 * The listener is attached when the client connects, before any subscribe, so a
 * retained message delivered immediately after SUBACK cannot be missed.
 */
class Inbox {
  private readonly received: ReceivedMessage[] = [];
  private wake: (() => void) | undefined;

  constructor(client: MqttClient) {
    client.on("message", (topic: string, payload: Buffer) => {
      this.received.push({ topic, payload: payload.toString("utf8") });
      this.wake?.();
    });
  }

  get messages(): readonly ReceivedMessage[] {
    return this.received;
  }

  async waitFor(topic: string, timeoutMs: number): Promise<ReceivedMessage | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find((message) => message.topic === topic);
      if (found !== undefined) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((settle) => {
        const timer = setTimeout(() => {
          this.wake = undefined;
          settle();
        }, remaining);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          settle();
        };
      });
    }
  }
}

interface Session {
  readonly client: MqttClient;
  readonly inbox: Inbox;
}

const openSessions: MqttClient[] = [];

function clientOptions(overrides: IClientOptions): IClientOptions {
  clientCounter += 1;
  return {
    protocolVersion: 5,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    clean: true,
    clientId: `fdp-test-${process.pid}-${clientCounter}`,
    ...overrides,
  };
}

/** Connect and keep the session for teardown; rejects when the broker refuses. */
async function connect(url: string, overrides: IClientOptions = {}): Promise<Session> {
  const client = mqtt.connect(url, clientOptions(overrides));
  const inbox = new Inbox(client);
  await new Promise<void>((settle, fail) => {
    client.once("connect", () => settle());
    client.once("error", (error: Error) => {
      client.end(true);
      fail(error);
    });
  });
  openSessions.push(client);
  return { client, inbox };
}

/** Connect as `credential` with its committed default password. */
function connectAs(
  url: string,
  credential: Credential,
  overrides: IClientOptions = {},
): Promise<Session> {
  return connect(url, { username: credential, password: CREDENTIALS[credential], ...overrides });
}

/** The MQTT 5 reason code carried by a CONNACK error, a PUBACK or a publish error. */
function reasonCodeOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { reasonCode?: unknown; code?: unknown };
  if (typeof record.reasonCode === "number") return record.reasonCode;
  if (typeof record.code === "number") return record.code;
  return undefined;
}

/** The reason code the broker answered a refused CONNECT with. */
async function connectRefused(url: string, overrides: IClientOptions): Promise<number> {
  try {
    const { client } = await connect(url, overrides);
    client.end(true);
    throw new Error("the broker accepted a connection it should have refused");
  } catch (error) {
    const code = reasonCodeOf(error);
    if (code === undefined) throw error;
    return code;
  }
}

interface PublishOutcome {
  /** 0 when the broker accepted the message, otherwise the MQTT 5 reason code. */
  readonly reasonCode: number;
  readonly detail: string;
}

/** Publish at QoS 1 and report the PUBACK reason code, however MQTT.js surfaces it. */
function publish(
  session: Session,
  topic: string,
  payload: string,
  retain = false,
): Promise<PublishOutcome> {
  return new Promise((settle) => {
    session.client.publish(topic, payload, { qos: 1, retain }, (error, packet) => {
      const code = reasonCodeOf(packet) ?? reasonCodeOf(error) ?? 0;
      settle({
        reasonCode: code,
        detail: error === undefined || error === null ? "accepted" : error.message,
      });
    });
  });
}

/** Subscribe at QoS 1 and report the granted QoS, which is never a refusal. */
function subscribe(session: Session, filter: string): Promise<ISubscriptionGrant[]> {
  return new Promise((settle, fail) => {
    session.client.subscribe(filter, { qos: 1 }, (error, granted) => {
      if (error !== undefined && error !== null) fail(error);
      else settle(granted ?? []);
    });
  });
}

/** Everything the container has written to stdout and stderr so far. */
async function containerLogs(container: StartedTestContainer): Promise<string> {
  const stream: Readable = await container.logs();
  return await new Promise<string>((settle) => {
    let text = "";
    const finish = (): void => {
      stream.destroy();
      settle(text);
    };
    stream.on("data", (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
    setTimeout(finish, 2_000);
  });
}

function brokerUrl(container: StartedTestContainer): string {
  return `mqtt://${container.getHost()}:${String(container.getMappedPort(1883))}`;
}

/**
 * A build context holding only `infra/mosquitto/**`.
 *
 * The Dockerfile's COPY paths are repository-relative, so the context must keep
 * that prefix; copying just this directory keeps the build independent of
 * whatever the repository root happens to contain.
 */
function makeBuildContext(): string {
  const context = mkdtempSync(join(tmpdir(), "fdp-mosquitto-ctx-"));
  mkdirSync(join(context, "infra"), { recursive: true });
  cpSync(MOSQUITTO_DIR, join(context, "infra", "mosquitto"), { recursive: true });
  return context;
}

let buildContext = "";

beforeAll(async () => {
  buildContext = makeBuildContext();
  // `withBuildkit` is required, not a preference: `COPY --chmod` is a BuildKit
  // instruction and the legacy builder testcontainers defaults to refuses it
  // with "the --chmod option requires BuildKit".
  await GenericContainer.fromDockerfile(buildContext, "infra/mosquitto/Dockerfile")
    .withBuildkit()
    .build(IMAGE_NAME, { deleteOnExit: true });
}, 300_000);

afterAll(() => {
  if (buildContext !== "") rmSync(buildContext, { recursive: true, force: true });
});

afterEach(() => {
  while (openSessions.length > 0) openSessions.pop()?.end(true);
});

describe("the built broker image", () => {
  let broker: StartedTestContainer;
  let url = "";

  beforeAll(async () => {
    broker = await new GenericContainer(IMAGE_NAME)
      .withExposedPorts(1883)
      .withLabels(LABELS)
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    url = brokerUrl(broker);
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
  });

  it("renders the password file with mode 0600 owned by mosquitto", async () => {
    const stat = await broker.exec([
      "stat",
      "-c",
      "%n %a %U",
      "/mosquitto/config/passwd",
      "/mosquitto/config/acl",
    ]);
    expect(stat.exitCode).toBe(0);
    expect(stat.output).toContain("/mosquitto/config/passwd 600 mosquitto");
    expect(stat.output).toContain("/mosquitto/config/acl 600 mosquitto");
  });

  it("passes its own healthcheck command from inside the container", async () => {
    const probe = await broker.exec([
      "mosquitto_sub",
      "-h",
      "127.0.0.1",
      "-t",
      "$SYS/broker/uptime",
      "-C",
      "1",
      "-W",
      "3",
      "-i",
      "hc-exec",
    ]);
    expect(probe.exitCode, probe.output).toBe(0);
    expect(probe.output).toMatch(/seconds/);
  });

  it("accepts every committed credential with its default password", async () => {
    for (const credential of Object.keys(CREDENTIALS) as Credential[]) {
      const { client } = await connectAs(url, credential);
      expect(client.connected, `${credential} did not connect`).toBe(true);
    }
  });

  it("refuses a wrong password with reason 135", async () => {
    const code = await connectRefused(url, { username: "gateway", password: "not-the-password" });
    expect(code).toBe(NOT_AUTHORIZED);
  });

  it("lets an anonymous client read the plant topics and $SYS", async () => {
    const anonymous = await connect(url);
    const gateway = await connectAs(url, "gateway");

    await subscribe(anonymous, `plant/${UNIT_ID}/#`);
    await subscribe(anonymous, "$SYS/#");

    const telemetry = `plant/${UNIT_ID}/telemetry/samples`;
    expect((await publish(gateway, telemetry, "sample")).reasonCode).toBe(0);

    expect(await anonymous.inbox.waitFor(telemetry, DELIVERY_WINDOW_MS)).toBeDefined();
    expect(await anonymous.inbox.waitFor("$SYS/broker/uptime", DELIVERY_WINDOW_MS)).toBeDefined();
  });

  describe("ground-truth isolation, proven by non-delivery", () => {
    const catalogTopic = `gt/${UNIT_ID}/catalog`;
    const catalogPayload = '{"probe":"gt-catalog"}';

    beforeAll(async () => {
      const sim = await connect(url, { username: "sim", password: CREDENTIALS.sim });
      expect((await publish(sim, catalogTopic, catalogPayload, true)).reasonCode).toBe(0);
      sim.client.end(true);
    });

    it("delivers the retained catalog to backend-ops but never to backend-diag", async () => {
      const ops = await connectAs(url, "backend-ops");
      const diag = await connectAs(url, "backend-diag");

      const opsGrant = await subscribe(ops, "gt/#");
      const diagGrant = await subscribe(diag, "gt/#");

      // The ACL file is checked at delivery time, so the denied
      // subscription is granted like any other. The granted QoS is recorded
      // here rather than asserted as a refusal.
      expect(
        diagGrant.map((grant) => grant.qos),
        `backend-diag's SUBACK for gt/# granted ${JSON.stringify(diagGrant)}; Mosquitto's ACL` +
          " file does not refuse subscriptions",
      ).toEqual([1]);
      expect(opsGrant.map((grant) => grant.qos)).toEqual([1]);

      const delivered = await ops.inbox.waitFor(catalogTopic, DELIVERY_WINDOW_MS);
      expect(delivered?.payload, "positive control: backend-ops may read gt/#").toBe(
        catalogPayload,
      );

      expect(await diag.inbox.waitFor(catalogTopic, DELIVERY_WINDOW_MS)).toBeUndefined();
      expect(diag.inbox.messages).toEqual([]);
    });

    it("delivers it to eval but never to an anonymous client", async () => {
      const anonymous = await connect(url);
      const evaluator = await connectAs(url, "eval");

      await subscribe(anonymous, "gt/#");
      await subscribe(evaluator, "gt/#");

      const delivered = await evaluator.inbox.waitFor(catalogTopic, DELIVERY_WINDOW_MS);
      expect(delivered?.payload, "positive control: eval may read gt/#").toBe(catalogPayload);

      expect(await anonymous.inbox.waitFor(catalogTopic, DELIVERY_WINDOW_MS)).toBeUndefined();
      expect(anonymous.inbox.messages).toEqual([]);
    });
  });

  describe("denied publishes are refused with PUBACK 135", () => {
    it("refuses gateway on gt/", async () => {
      const gateway = await connectAs(url, "gateway");
      const outcome = await publish(gateway, `gt/${UNIT_ID}/marker`, "marker");
      expect(outcome.reasonCode, outcome.detail).toBe(NOT_AUTHORIZED);
    });

    it("refuses an anonymous publish", async () => {
      const anonymous = await connect(url);
      const outcome = await publish(anonymous, `plant/${UNIT_ID}/telemetry/samples`, "sample");
      expect(outcome.reasonCode, outcome.detail).toBe(NOT_AUTHORIZED);
    });

    it("refuses eval everywhere, so the read-only credential stays read-only", async () => {
      const evaluator = await connectAs(url, "eval");
      for (const topic of [
        `plant/${UNIT_ID}/telemetry/samples`,
        `plant/${UNIT_ID}/control/cmd`,
        `gt/${UNIT_ID}/marker`,
      ]) {
        const outcome = await publish(evaluator, topic, "payload");
        expect(outcome.reasonCode, `${topic}: ${outcome.detail}`).toBe(NOT_AUTHORIZED);
      }
    });

    it("refuses backend-diag on control/cmd while backend-ops reaches sim", async () => {
      const commandTopic = `plant/${UNIT_ID}/control/cmd`;
      const sim = await connectAs(url, "sim");
      await subscribe(sim, commandTopic);

      const diag = await connectAs(url, "backend-diag");
      const refused = await publish(diag, commandTopic, "from-backend-diag");
      expect(refused.reasonCode, refused.detail).toBe(NOT_AUTHORIZED);
      expect(await sim.inbox.waitFor(commandTopic, SHORT_WINDOW_MS)).toBeUndefined();

      const ops = await connectAs(url, "backend-ops");
      const accepted = await publish(ops, commandTopic, "from-backend-ops");
      expect(accepted.reasonCode, accepted.detail).toBe(0);

      const delivered = await sim.inbox.waitFor(commandTopic, DELIVERY_WINDOW_MS);
      expect(delivered?.payload, "positive control: backend-ops may write control/cmd").toBe(
        "from-backend-ops",
      );
    });
  });
});

describe("a password overridden through the environment", () => {
  // A value that appears nowhere else in the repository, so finding it in the
  // container log would prove the entrypoint leaked it.
  const OVERRIDE = "override-token-9c1f4a";
  let broker: StartedTestContainer;
  let url = "";

  beforeAll(async () => {
    broker = await new GenericContainer(IMAGE_NAME)
      .withExposedPorts(1883)
      .withLabels(LABELS)
      .withEnvironment({ MQTT_GATEWAY_PASSWORD: OVERRIDE })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    url = brokerUrl(broker);
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
  });

  it("accepts the overridden password", async () => {
    const { client } = await connect(url, { username: "gateway", password: OVERRIDE });
    expect(client.connected).toBe(true);
  });

  it("refuses the committed default the override replaced", async () => {
    const code = await connectRefused(url, {
      username: "gateway",
      password: CREDENTIALS.gateway,
    });
    expect(code).toBe(NOT_AUTHORIZED);
  });

  it("leaves the other credentials on their defaults", async () => {
    const { client } = await connectAs(url, "backend-ops");
    expect(client.connected).toBe(true);
  });

  it("never prints a password value", async () => {
    const logs = await containerLogs(broker);
    expect(logs).not.toContain(OVERRIDE);
    for (const [user, password] of Object.entries(CREDENTIALS)) {
      expect(logs, `${user}'s credential pair must not appear in the log`).not.toContain(
        `${user}:${password}`,
      );
    }
    expect(logs).toContain("rendered 5 credentials");
  });
});

describe("the stock image with the three committed files copied in", () => {
  // Exactly what the testcontainers helpers of the backend, the simulator and init
  // do instead of building an image; the hashed `passwd` exists for them.
  let broker: StartedTestContainer;
  let url = "";

  beforeAll(async () => {
    broker = await new GenericContainer(BASE_IMAGE)
      .withExposedPorts(1883)
      .withLabels(LABELS)
      .withCopyFilesToContainer([
        {
          source: join(MOSQUITTO_DIR, "mosquitto.conf"),
          target: "/mosquitto/config/mosquitto.conf",
          mode: 0o644,
        },
        { source: join(MOSQUITTO_DIR, "acl"), target: "/mosquitto/config/acl", mode: 0o600 },
        { source: join(MOSQUITTO_DIR, "passwd"), target: "/mosquitto/config/passwd", mode: 0o600 },
      ])
      // The stock image has no healthcheck, and `mosquitto.conf` logs only
      // error, warning and notice, so there is no "running" line to wait for.
      // The single quotes keep `$SYS` literal inside the container's shell.
      .withWaitStrategy(
        Wait.forSuccessfulCommand(
          "mosquitto_sub -h 127.0.0.1 -t '$SYS/broker/uptime' -C 1 -W 3 -i hc-wait",
        ),
      )
      .start();
    url = brokerUrl(broker);
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
  });

  it("accepts every credential of the committed hashed passwd", async () => {
    for (const credential of Object.keys(CREDENTIALS) as Credential[]) {
      const { client } = await connectAs(url, credential);
      expect(client.connected, `${credential} did not connect`).toBe(true);
    }
  });

  it("refuses a wrong password with reason 135", async () => {
    const code = await connectRefused(url, { username: "sim", password: "not-the-password" });
    expect(code).toBe(NOT_AUTHORIZED);
  });

  it("enforces the same ACL as the built image", async () => {
    const diag = await connectAs(url, "backend-diag");
    const outcome = await publish(diag, `gt/${UNIT_ID}/marker`, "marker");
    expect(outcome.reasonCode, outcome.detail).toBe(NOT_AUTHORIZED);
  });

  it("copies the credential files without a comment line", () => {
    // The helper copies the file as committed; a `#` header would have become a
    // credential when `mosquitto_passwd -U` hashed it.
    const passwd = readFileSync(join(MOSQUITTO_DIR, "passwd"), "utf8");
    expect(passwd.split("\n").filter((line) => line.startsWith("#"))).toEqual([]);
  });
});

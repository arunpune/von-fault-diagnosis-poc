// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The frontend image against a fake backend on a private network.
 *
 * The suite builds apps/frontend/Dockerfile from the repository root, the context Compose
 * uses, and runs it the way Compose does, with BACKEND_UPSTREAM naming a fake backend: a
 * node container whose inline script answers `GET /api/health` with `{"status":"ok"}` and
 * sends one `hello` frame on `/ws`. Both sit on a network created with `--internal`, so
 * nothing in them can reach anything outside it, and the image is proved to serve, proxy and
 * pass its own HEALTHCHECK with no Internet at all.
 *
 * Docker publishes no port of a container whose networks are all internal, so the test
 * reaches nginx through a relay: a third container, on an ordinary network with a random
 * loopback port published (`-p 127.0.0.1::8080`, read back with `docker port`) and also
 * attached to the private network, that pipes every TCP connection to the frontend. A
 * WebSocket upgrade passes through it untouched.
 *
 * It needs Docker and, on a cold cache, a minute of image build, so it runs only with
 * CONTAINER_TESTS=1:
 *
 *   CONTAINER_TESTS=1 pnpm --filter @fdp/frontend test -- test/container
 *
 * Every name carries a random suffix, so parallel runs do not collide, and `afterAll`
 * removes the containers, both networks and the image.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const DOCKERFILE = "apps/frontend/Dockerfile";

/** The runtime base of the image and the image of the fake backend and the relay. */
const NGINX_IMAGE = "nginx:1.30.5-alpine-slim";
const NODE_IMAGE = "node:24.21.0-trixie-slim";

/** Acceptance bound on the runtime image, in bytes as Docker reports them (1 MB = 10^6). */
const IMAGE_SIZE_LIMIT = 60_000_000;

/** A cold build installs every dependency; a warm one takes seconds. */
const BUILD_TIMEOUT_MS = 900_000;
const COMMAND_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

const ONE_YEAR_S = 365 * 24 * 60 * 60;

const suffix = randomBytes(4).toString("hex");
const names = {
  image: `fdp-frontend-test:${suffix}`,
  privateNetwork: `fdp-fe-container-${suffix}-private`,
  edgeNetwork: `fdp-fe-container-${suffix}-edge`,
  backend: `fdp-fe-container-${suffix}-backend`,
  frontend: `fdp-fe-container-${suffix}-frontend`,
  relay: `fdp-fe-container-${suffix}-relay`,
} as const;

/** Printed by the two helper scripts once they accept connections. */
const LISTENING = "listening";

/**
 * The fake backend, run with `node --input-type=module -e`. It speaks just enough of RFC 6455
 * to accept an upgrade, send one unmasked text frame whose payload is under 126 bytes, and
 * answer the client's close frame.
 */
const FAKE_BACKEND_SCRIPT = String.raw`
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HELLO = Buffer.from(JSON.stringify({ type: "hello" }));

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404).end();
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (request.url !== "/ws" || typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n",
  );
  socket.write(Buffer.concat([Buffer.from([0x81, HELLO.length]), HELLO]));
  socket.on("data", (frame) => {
    if ((frame[0] & 0x0f) === 0x08) socket.end(Buffer.from([0x88, 0x00]));
  });
  socket.on("error", () => socket.destroy());
});

server.listen(3000, "0.0.0.0", () => console.log("${LISTENING}"));
`;

/** The relay, run with `node --input-type=module -e`: every connection piped to the frontend. */
const RELAY_SCRIPT = String.raw`
import { connect, createServer } from "node:net";

const target = process.env.RELAY_TARGET;

createServer((client) => {
  const upstream = connect(8080, target);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.pipe(upstream).pipe(client);
}).listen(8080, "0.0.0.0", () => console.log("${LISTENING}"));
`;

const execFileAsync = promisify(execFile);

function stderrOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const { stderr } = error;
    if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/** Run the Docker CLI from the repository root and return its trimmed standard output. */
async function docker(args: readonly string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, {
      cwd: REPO_ROOT,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${stderrOf(error)}`, {
      cause: error,
    });
  }
}

/** `docker inspect` of one object, decoded from the JSON a Go template renders. */
async function inspectJson(
  kind: "container" | "image" | "network",
  name: string,
  template: string,
): Promise<unknown> {
  return JSON.parse(
    await docker([kind, "inspect", "--format", `{{json ${template}}}`, name]),
  ) as unknown;
}

/** Pull `image` unless the local store already has it. */
async function ensureImage(image: string): Promise<void> {
  try {
    await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  } catch {
    await docker(["pull", "--quiet", image], BUILD_TIMEOUT_MS);
  }
}

async function logsOf(container: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", container]);
    return `${stdout}${stderr}`;
  } catch (error) {
    return `(no logs: ${stderrOf(error)})`;
  }
}

async function diagnostics(): Promise<string> {
  const containers = [names.backend, names.frontend, names.relay];
  const logs = await Promise.all(
    containers.map(async (name) => `--- ${name}\n${await logsOf(name)}`),
  );
  return logs.join("\n");
}

/** Poll `probe` until it holds; on time-out, fail with the containers' logs. */
async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `timed out after ${READY_TIMEOUT_MS} ms waiting for ${what}\n${await diagnostics()}`,
  );
}

function runNode(
  name: string,
  network: string,
  script: string,
  extra: readonly string[] = [],
): Promise<string> {
  return docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    ...extra,
    NODE_IMAGE,
    "node",
    "--input-type=module",
    "--eval",
    script,
  ]);
}

/** The loopback origin `docker port` reports for the relay's published 8080. */
async function relayOrigin(): Promise<string> {
  const mapping = await docker(["port", names.relay, "8080/tcp"]);
  const port = /:(\d+)$/m.exec(mapping)?.[1];
  if (port === undefined) throw new Error(`docker port printed no port: ${mapping}`);
  return `127.0.0.1:${port}`;
}

/** The first message a WebSocket at `url` receives. */
function firstMessage(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no message on ${url} within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(event.data));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`the WebSocket to ${url} failed`));
    });
  });
}

describe.runIf(process.env.CONTAINER_TESTS === "1")("the frontend image", () => {
  let origin = "";

  const get = (pathname: string, init?: RequestInit) => fetch(`http://${origin}${pathname}`, init);

  beforeAll(
    async () => {
      // Present before the build, so the build and the base-layer comparison below use one
      // digest of the base, and a warm cache needs no registry at all.
      await ensureImage(NGINX_IMAGE);
      await ensureImage(NODE_IMAGE);
      await docker(
        ["build", "--quiet", "-f", DOCKERFILE, "-t", names.image, "."],
        BUILD_TIMEOUT_MS,
      );

      await docker(["network", "create", "--internal", names.privateNetwork]);
      await docker(["network", "create", names.edgeNetwork]);

      await runNode(names.backend, names.privateNetwork, FAKE_BACKEND_SCRIPT);
      await waitFor("the fake backend to listen", async () =>
        (await logsOf(names.backend)).includes(LISTENING),
      );

      // The image's own HEALTHCHECK command, polled every second instead of every ten.
      await docker([
        "run",
        "--detach",
        "--name",
        names.frontend,
        "--network",
        names.privateNetwork,
        "--health-interval",
        "1s",
        "--env",
        `BACKEND_UPSTREAM=${names.backend}:3000`,
        names.image,
      ]);

      await runNode(names.relay, names.edgeNetwork, RELAY_SCRIPT, [
        "--publish",
        "127.0.0.1::8080",
        "--env",
        `RELAY_TARGET=${names.frontend}`,
      ]);
      await docker(["network", "connect", names.privateNetwork, names.relay]);
      origin = await relayOrigin();

      await waitFor(
        "GET /healthz to answer through the relay",
        async () => (await get("/healthz")).ok,
      );
    },
    BUILD_TIMEOUT_MS + 3 * READY_TIMEOUT_MS,
  );

  afterAll(async () => {
    const quietly = (args: readonly string[]) => docker(args).catch(() => "");
    await quietly(["rm", "--force", "--volumes", names.relay, names.frontend, names.backend]);
    await quietly(["network", "rm", names.privateNetwork, names.edgeNetwork]);
    await quietly(["image", "rm", "--force", names.image]);
  }, COMMAND_TIMEOUT_MS);

  it(`is built on ${NGINX_IMAGE} and stays under 60 MB`, async () => {
    const baseLayers = (await inspectJson("image", NGINX_IMAGE, ".RootFS.Layers")) as string[];
    const layers = (await inspectJson("image", names.image, ".RootFS.Layers")) as string[];
    const size = (await inspectJson("image", names.image, ".Size")) as number;

    expect(layers.slice(0, baseLayers.length)).toEqual(baseLayers);
    expect(size).toBeLessThan(IMAGE_SIZE_LIMIT);
  });

  it("contains no .env file anywhere in its file system", async () => {
    const found = await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "find",
      names.image,
      "/",
      "-xdev",
      "-name",
      ".env*",
    ]);

    expect(found).toBe("");
  });

  it("runs on an internal network only, so nothing it serves can come from outside", async () => {
    const internal = await inspectJson("network", names.privateNetwork, ".Internal");
    const networks = await inspectJson("container", names.frontend, ".NetworkSettings.Networks");

    expect(internal).toBe(true);
    expect(Object.keys(networks as Record<string, unknown>)).toEqual([names.privateNetwork]);
  });

  it("answers /healthz itself with 200 ok", async () => {
    const response = await get("/healthz");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("ok");
  });

  it(
    "turns healthy through its own HEALTHCHECK",
    async () => {
      await waitFor(
        "the container to turn healthy",
        async () =>
          (await inspectJson("container", names.frontend, ".State.Health.Status")) === "healthy",
      );
    },
    READY_TIMEOUT_MS + COMMAND_TIMEOUT_MS,
  );

  it("serves the app at / for revalidation on every load, linking nothing off its origin", async () => {
    const response = await get("/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(html).toContain("<title>CAU-7 fault diagnosis</title>");
    expect(html).not.toMatch(/https?:\/\//i);
  });

  it("answers a deep link with index.html", async () => {
    const response = await get("/some/deep/link");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toContain("<title>CAU-7 fault diagnosis</title>");
  });

  it("serves the hashed assets gzipped and immutable for a year", async () => {
    const html = await (await get("/")).text();
    const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(script, "index.html loads an entry chunk from /assets/").toBeDefined();

    const response = await get(script ?? "", { headers: { "accept-encoding": "gzip" } });
    const cacheControl = response.headers.get("cache-control") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(cacheControl).toContain("public, immutable");
    expect(cacheControl).toContain(`max-age=${ONE_YEAR_S}`);
  });

  it("answers a missing asset with 404, never with the page", async () => {
    const response = await get("/assets/missing-00000000.js");

    expect(response.status).toBe(404);
  });

  it("proxies /api/ to the backend", async () => {
    const response = await get("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("proxies the /ws upgrade to the backend", async () => {
    const message = await firstMessage(`ws://${origin}/ws`, 10_000);

    expect(JSON.parse(message)).toEqual({ type: "hello" });
  }, 15_000);

  it("names no nginx version in the Server header", async () => {
    for (const pathname of ["/", "/healthz", "/api/health", "/assets/missing-00000000.js"]) {
      const response = await get(pathname);

      expect(response.headers.get("server"), pathname).toBe("nginx");
    }
  });
});

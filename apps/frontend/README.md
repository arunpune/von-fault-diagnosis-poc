<!--
SPDX-FileCopyrightText: 2026 Meddle S.r.l.
SPDX-License-Identifier: CC-BY-4.0
-->

# `@fdp/frontend` — the operator dashboard

The browser UI of the CAU-7 unit: the chart recorder, the simulation controls, the alerts feed, the decision and ticket
sheets, and the review, events and cost tabs. It is a Vite + React single-page app that reaches the backend only through
its own origin, `/api` for REST and `/ws` for the live WebSocket, so it has no configuration and no key of its own. nginx
serves the static build, so the container runs no Node process; server state lives in a query cache that the one
WebSocket client keeps current, so an arriving decision or ticket needs no refetch; the recorder's charts redraw from a
buffer flushed at most four times a second rather than on every frame; and the end-to-end tests run in two modes, against
a fake backend without Docker and against the Compose stack. Where the dashboard sits in the stack is in
[`docs/architecture.md`](../../docs/architecture.md), and the routes and frames it reads are in
[`docs/api.md`](../../docs/api.md).

## Develop

```bash
make up-dev                        # the stack, with the backend published on localhost:3000
pnpm --filter @fdp/frontend dev    # Vite on http://localhost:5173
```

The dev server and `vite preview` proxy `/api` and `/ws` to `FDP_BACKEND_URL` (default `http://localhost:3000`), exactly as
nginx does in the container, so application code never names a backend host.

## Contract

[`src/api/types.ts`](src/api/types.ts) re-exports the generated types of `@fdp/contracts` with `import type`, so nothing
of that package reaches the bundle, and spells only the bodies the contracts leave without a schema: `ItemList<T>`,
`InjectionInterval`, `DecisionDetail`, `TicketDetail` and the `SeriesResponse` the recorder seeds from. These were checked
against the backend in the Compose stack:

- the series has one route and one spelling, `GET /api/telemetry/series` with `tag`, `from`, `to` and
  `discontinuities`, so the UI no longer asks the `/api/series` alias or reads the earlier `signal_id` spelling;
- `POST /api/tickets/:id/close` takes `{ verdict, note? }`, and a ticket is `review`, `open`, `resolved` or `closed`;
- the socket sends `hello`, then `snapshot`, then `heartbeat` every 10 s, and the UI depends on none of them;
- the overlay lists answer `{ items }`.

The fake backend of [`e2e/fake-backend/`](e2e/fake-backend) agrees with the stack on every field the UI reads. Where the
contract leaves a field optional, the two fill different ones: the fake's manual references carry `title` and `anchor`,
the stack's `page`, `page_start` and `page_end`, so the UI is exercised on both. When the contract changes, `types.ts`,
the fixtures under `src/test/fixtures/` and the fake change together. `fixtures.test.ts` validates the fixtures against
the schemas, and `tsc -b` type-checks `e2e/` against `types.ts`.

## Test and build

| Command                                     | What                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm --filter @fdp/frontend typecheck`     | `tsc -b` over the browser sources and the Node-side configuration and tests         |
| `pnpm --filter @fdp/frontend lint`          | ESLint, including the [import boundaries](../../docs/architecture.md#import-boundaries) |
| `pnpm --filter @fdp/frontend test`          | Vitest: unit and component tests in jsdom, and the checks on `dist/` once it exists |
| `pnpm --filter @fdp/frontend test:coverage` | the same with v8 coverage (85 % of lines in `src/lib`, `src/store`, `src/api`)      |
| `pnpm --filter @fdp/frontend build`         | `vite build` into `dist/`                                                           |

## Container

The `frontend` service of [`compose.yaml`](../../compose.yaml) runs this image; build it by hand from the repository root,
which is the build context:

```bash
docker build -f apps/frontend/Dockerfile -t fdp-frontend .
```

A `node:24.21.0-trixie-slim` stage installs the workspace from the frozen lockfile and runs `vite build`; the runtime is
`nginx:1.30.5-alpine-slim` (about 14 MB) serving `dist/` on port 8080 with
[`nginx/default.conf.template`](nginx/default.conf.template):

| Path          | Answer                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------- |
| `/healthz`    | `200 ok` from nginx itself, for the image and Compose healthchecks                            |
| `/api/…`      | proxied to `http://$BACKEND_UPSTREAM/api/…` over HTTP/1.1, 60 s read timeout                  |
| `/ws`         | the WebSocket upgrade, proxied to `http://$BACKEND_UPSTREAM/ws`, 3600 s read timeout          |
| `/assets/…`   | the content-hashed build output, `Cache-Control: public, immutable` for a year; 404 if absent |
| anything else | the file if there is one, else `index.html`, with `Cache-Control: no-cache`                   |

`BACKEND_UPSTREAM` (`host:port`, default `backend:3000`) is the image's only setting. The official image's entrypoint writes
it into the template at start-up, and only it: `NGINX_ENVSUBST_FILTER=^BACKEND_` keeps nginx's own `$uri` and
`$http_upgrade` intact. nginx resolves the host once, when it starts, so the backend must be resolvable by then; Compose
starts the frontend after the backend is healthy. To put the image in front of a backend running on the host:

```bash
docker run --rm -p 8080:8080 -e BACKEND_UPSTREAM=host.docker.internal:3000 \
  --add-host=host.docker.internal:host-gateway fdp-frontend
```

The build context is filtered by `Dockerfile.dockerignore`, a symlink to [`.dockerignore`](.dockerignore) here, which
BuildKit prefers to the root file: an allow-list of the workspace manifests, `packages/contracts` and this package, never
a `.env`.

### Container test

```bash
CONTAINER_TESTS=1 pnpm --filter @fdp/frontend test -- test/container         # the package suite, this test included
CONTAINER_TESTS=1 pnpm --filter @fdp/frontend exec vitest run test/container  # this test alone
```

[`test/container/container.test.ts`](test/container/container.test.ts) needs Docker. It builds the image, starts a fake
backend (a Node container that answers `GET /api/health` and sends one `hello` frame on `/ws`) and the frontend on a
network created with `--internal`, reaches nginx through a relay container that publishes a random loopback port, and
checks the table above, the HEALTHCHECK, the missing `Server` version, the image size and base, and that the image holds
no `.env`. Every name carries a random suffix and everything is removed afterwards. Without `CONTAINER_TESTS=1` the file is
skipped, so `pnpm test` never needs Docker. (Vitest ignores the path after `--`, which is why the first line runs the
whole package suite.)

## End-to-end tests

Playwright runs the suite under [`e2e/`](e2e) in Chromium ([`playwright.config.ts`](playwright.config.ts)). Install the
browser once per machine:

```bash
pnpm --filter @fdp/frontend exec playwright install chromium
```

| Command                                 | What                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm --filter @fdp/frontend e2e:mock`  | projects `mock` and `perf` against the fake backend: no Docker, no dataset            |
| `pnpm --filter @fdp/frontend e2e:perf`  | the `perf` project alone                                                              |
| `pnpm --filter @fdp/frontend e2e:stack` | project `stack` against the Compose stack at `E2E_BASE_URL` (`http://localhost:8080`) |

The mock projects start [`e2e/launch.ts`](e2e/launch.ts) as their web server. It starts the fake backend of
[`e2e/fake-backend/`](e2e/fake-backend) and, after a fresh `vite build` (`E2E_SKIP_BUILD=1` reuses `dist/`), serves the
app with `vite preview`, whose `/api` and `/ws` proxy points at the fake, both on ports the system picks, so several
checkouts can run the suite at the same time. A spec imports `test` and `expect` from [`e2e/helpers.ts`](e2e/helpers.ts):
its `profile` fixture carries the mode's timeouts and tolerances, and its `fakeBackend` fixture the fake's control API
(null against the stack):

| Control route             | Effect                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| `POST /__test/reset`      | a fresh scenario; `{ "backend": "rules" }` plays the rules backend           |
| `POST /__test/emit`       | push any `ws-server-message` frame to every socket                           |
| `POST /__test/stream`     | `{ samples_per_s, seconds }`: replay at that sample rate, whatever the speed |
| `POST /__test/restart-ws` | close every socket with 1012, so the page has to reconnect                   |

Against the Compose stack, the root Makefile runs the same tour (`make e2e-mock` and `make e2e-perf` wrap the mock
scripts):

```bash
make fixtures                                             # the CI slice the stack replays
scripts/smoke.sh --mode ci --keep --report reports/smoke  # jev against the mock TypeSafe server, left running
make e2e                                                  # E2E_BASE_URL, else reports/smoke/ui-url
docker compose -p "$(cat reports/smoke/project)" down -v --remove-orphans
```

The `stack` project first runs [`e2e/stack.setup.ts`](e2e/stack.setup.ts), which waits for `GET /api/health` to answer
ok, rewinds the replay with `POST /api/sim/reset` and sets 600×, so `make e2e` can run again on the same stack. The
stack keeps the records of earlier runs, so the tour follows the decisions that arrive after its own actions. The mock
TypeSafe server's `best-overlap` policy answers at 0.9, above the 0.85 ticket gate, so the stack's tickets open rather than
land in review; the rules backend and the review path are covered by the mock projects. The stack's fixture slice holds
06:00–14:00 of 5 June and six hours of February, so the tour injects the oil cooler fault on 1 February at full magnitude,
as `scripts/smoke.sh` does. There it closes the injected fault's ticket, since that jump resolves the air-leak ticket.

The fake replays a synthetic compressor waveform at 600× until told otherwise; 90 simulated minutes after a jump to
"Air leak – 5 Jun 2020" it emits a suspect event, a Jev decision, a ticket and the cost update, and 60 simulated minutes
after "Inject fault → Oil cooler fouling" the same for the injected fault. It also runs on its own:
`PORT=0 node e2e/fake-backend/server.ts` prints `FAKE_BACKEND_PORT=<n>`. `PERF=0` empties the `perf` project,
`FDP_TIMING_SLACK` widens every wall-clock bound (1 by default, 3 in CI), and reports land in `playwright-report/` with
traces of the first retry in `test-results/`.

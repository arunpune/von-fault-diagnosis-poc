# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The two images of the Go module (services/modbus/README.md, "Images"). One
# build stage compiles both binaries and two runtime stages ship one each:
#
#   docker build -f services/modbus/Dockerfile --target sim     -t fdp-modbus-sim .
#   docker build -f services/modbus/Dockerfile --target gateway -t fdp-modbus-gateway .
#
# The build context is the repository root for every image of this project, so
# every COPY path starts at the root and the root `.dockerignore` — not a file
# next to this one — decides what the daemon receives.
# services/modbus/README.md lists what that file must exclude.
#
# The runtime stage is distroless: no shell, no package manager and no curl, so
# the Compose healthcheck runs the binary's own `probe` subcommand
# (section 8.3). Both stages are pinned by digest, because `nonroot` is a
# floating tag and a digest is the only stable pin distroless offers.

FROM golang:1.27.1-trixie AS build
WORKDIR /src/services/modbus
# The manifest first, so a source-only change reuses the download layer.
COPY services/modbus/go.mod services/modbus/go.sum ./
RUN go mod download
COPY services/modbus/ ./
# CGO off makes the binaries static, which is what the `static` base expects;
# -trimpath and -s -w drop the build paths and the symbol table, which is most
# of the difference between a 10 MB and a 14 MB image.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/modbus-sim ./cmd/modbus-sim \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/gateway

# The machine. It also carries the ground truth the control plane forwards on
# `gt/#`; the COPY fails the build when packages/ground-truth/data is missing,
# which is intended — an image without presets.json cannot serve a jump target.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3 AS sim
COPY --from=build /out/modbus-sim /modbus-sim
COPY packages/ground-truth/data/ /gt/
USER nonroot
EXPOSE 5020 8081
ENTRYPOINT ["/modbus-sim"]

# The edge connector. No ground truth reaches this image (ground-truth
# isolation, docs/architecture.md#ground-truth-isolation): it carries one
# binary and nothing else.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3 AS gateway
COPY --from=build /out/gateway /gateway
USER nonroot
EXPOSE 8082
ENTRYPOINT ["/gateway"]

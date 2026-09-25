#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Assert the invariants the Compose stack relies on.

``scripts/ops/compose-check.sh`` renders each of the three file combinations
with ``docker compose --env-file /dev/null … config --format json`` and pipes
the result in here. The rendering is what the daemon would act on, so an
invariant proven against it holds for the real stack, and ``--env-file
/dev/null`` guarantees a developer's own ``.env`` is never read (the two API
keys come out empty).

Two groups of checks run:

* **rendered** — the service set, the ``depends_on`` conditions, a healthcheck
  on every service but ``init``, the restart policies, the database volume
  target PostgreSQL 18 expects, the read-only model cache, which services see
  an API key, the published ports and the pinned images;
* **sources** — what a rendering cannot show: that no compose file uses
  ``env_file`` or names a ground-truth path, that the three published ports are
  written as overridable variables, that the broker image is pinned, and that
  the root ``.dockerignore`` keeps ``.env`` out of every build context.

The source checks are cheap and variant-independent, so every invocation runs
them; the pseudo-variant ``sources`` runs them alone, which is what
``compose-check.sh`` falls back to on a machine without Docker.

Usage::

    docker compose --env-file /dev/null -f compose.yaml config --format json \\
      | python3 scripts/ops/compose-invariants.py base
    python3 scripts/ops/compose-invariants.py sources

Exit codes: 0 every invariant holds, 1 at least one does not, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Final

BASE_VARIANT: Final = "base"
DEV_VARIANT: Final = "dev"
CI_VARIANT: Final = "ci"
SOURCES_VARIANT: Final = "sources"
VARIANTS: Final = (BASE_VARIANT, DEV_VARIANT, CI_VARIANT, SOURCES_VARIANT)

EXIT_FAILURE: Final = 1
EXIT_USAGE: Final = 2

BASE_SERVICES: Final = frozenset(
    {"postgres", "mqtt", "init", "modbus-sim", "gateway", "backend", "frontend"}
)
"""Every service of compose.yaml."""

MOCK_SERVICE: Final = "typesafe-mock"
"""The mock decision service; compose.ci.yaml adds it and nothing else does."""

ONE_SHOT: Final = "init"
"""The only service that runs to completion instead of staying up."""

HEALTHY: Final = "service_healthy"
COMPLETED: Final = "service_completed_successfully"

DEPENDS_ON: Final[Mapping[str, Mapping[str, str]]] = {
    "postgres": {},
    "mqtt": {},
    "init": {"postgres": HEALTHY, "mqtt": HEALTHY},
    "modbus-sim": {"init": COMPLETED, "mqtt": HEALTHY},
    "gateway": {"modbus-sim": HEALTHY, "mqtt": HEALTHY},
    "backend": {"init": COMPLETED, "postgres": HEALTHY, "mqtt": HEALTHY},
    "frontend": {"backend": HEALTHY},
    MOCK_SERVICE: {},
}
"""The start order of the stack; the ci variant adds the mock to backend."""

POSTGRES_IMAGE: Final = "pgvector/pgvector:0.8.6-pg18-trixie"
"""The pinned database image. The PG18 layout is why PGDATA_TARGET is what it is."""

MOSQUITTO_IMAGE: Final = "eclipse-mosquitto:2.0.22"
"""The base the broker image is built from."""

PGDATA_TARGET: Final = "/var/lib/postgresql"
"""PostgreSQL 18 declares the volume here, not at .../data."""

PGDATA_VOLUME: Final = "pgdata"
MODEL_CACHE_VOLUME: Final = "model-cache"
MODEL_CACHE_TARGET: Final = "/models"

SECRETS: Final = ("TYPESAFE_API_KEY", "LLM_API_KEY")
"""The only two variables that hold a credential (secrets via the environment only)."""

SECRET_HOLDERS: Final[Mapping[str, frozenset[str]]] = {
    "backend": frozenset(SECRETS),
    "init": frozenset({"LLM_API_KEY"}),
}
"""Which service may see which key; every other service sees neither."""

PublishedPort = tuple[str, str, int, str]
"""(service, host ip, container port, published host port); "" = ephemeral."""

BASE_PORTS: Final[frozenset[PublishedPort]] = frozenset(
    {
        ("frontend", "", 8080, "8080"),
        ("mqtt", "", 1883, "1883"),
        ("modbus-sim", "", 5020, "5020"),
    }
)
"""The three mappings compose.yaml publishes, all overridable by a variable."""

DEV_EXTRA_PORTS: Final[frozenset[PublishedPort]] = frozenset(
    {
        ("postgres", "", 5432, "5432"),
        ("backend", "", 3000, "3000"),
        ("modbus-sim", "", 8081, "8081"),
        ("gateway", "", 8082, "8082"),
    }
)
"""The fixed development ports of compose.dev.yaml."""

CI_EXTRA_PORTS: Final[frozenset[PublishedPort]] = frozenset({("postgres", "127.0.0.1", 5432, "")})
"""Loopback-only, ephemeral: the evaluation tool scores a kept CI stack."""

PORT_MAPPINGS: Final = (
    '"${UI_PORT:-8080}:8080"',
    '"${MQTT_PORT:-1883}:1883"',
    '"${MODBUS_PORT:-5020}:5020"',
)
"""compose.yaml writes every published port as an overridable variable, so an
automated run can ask for ephemeral host ports with UI_PORT=0 and friends."""

COMPOSE_GLOB: Final = "compose*.yaml"
DOCKERIGNORE: Final = ".dockerignore"
MOSQUITTO_DOCKERFILE: Final = "infra/mosquitto/Dockerfile"

FORBIDDEN_LITERALS: Final = ("gt/", "/gt", "GT_DIR", "ground" + "-truth")
"""Ground-truth isolation: a compose file never names a path holding the answers. The
simulator image bakes them in itself, so Compose has no reason to mention one
and ``scripts/check-gt-paths.sh`` can grep these files whole."""

ENV_FILE_DIRECTIVE: Final = re.compile(r"^\s*env_file\s*:")
"""No service loads a dotenv file: each one gets the variables it needs."""

DOCKERIGNORE_REQUIRED: Final = (".env", ".env.*", "!.env.example")
"""The keys stay out of every build context, the example stays in."""


class InvariantError(Exception):
    """A usage problem that stops the run before any invariant is judged."""


def _services(config: Mapping[str, Any]) -> Mapping[str, Mapping[str, Any]]:
    services = config.get("services")
    if not isinstance(services, dict):
        raise InvariantError("the rendered configuration has no `services` mapping")
    return services


def _expected_services(variant: str) -> frozenset[str]:
    return BASE_SERVICES | {MOCK_SERVICE} if variant == CI_VARIANT else BASE_SERVICES


def _expected_depends_on(variant: str, service: str) -> Mapping[str, str]:
    expected = dict(DEPENDS_ON[service])
    if variant == CI_VARIANT and service == "backend":
        expected[MOCK_SERVICE] = HEALTHY
    return expected


def _expected_ports(variant: str) -> frozenset[PublishedPort]:
    if variant == DEV_VARIANT:
        return BASE_PORTS | DEV_EXTRA_PORTS
    if variant == CI_VARIANT:
        return BASE_PORTS | CI_EXTRA_PORTS
    return BASE_PORTS


def check_service_set(variant: str, services: Mapping[str, Any]) -> list[str]:
    """The variant renders exactly the services it is supposed to render."""
    expected = _expected_services(variant)
    found = frozenset(services)
    failures = [f"service {name!r} is missing" for name in sorted(expected - found)]
    failures += [
        f"service {name!r} is not part of the {variant} stack" for name in sorted(found - expected)
    ]
    return failures


def check_depends_on(variant: str, services: Mapping[str, Any]) -> list[str]:
    """Start order and conditions are exactly those of :data:`DEPENDS_ON`."""
    failures: list[str] = []
    for name, service in sorted(services.items()):
        expected = _expected_depends_on(variant, name)
        declared = service.get("depends_on") or {}
        found = {
            other: str(entry.get("condition", "")) for other, entry in sorted(declared.items())
        }
        if found != dict(expected):
            failures.append(f"{name}: depends_on is {found}, expected {dict(expected)}")
    return failures


def check_healthchecks(services: Mapping[str, Any]) -> list[str]:
    """Every long-running service is health-checked; the one-shot is not."""
    failures: list[str] = []
    for name, service in sorted(services.items()):
        healthcheck = service.get("healthcheck") or {}
        has_test = bool(healthcheck.get("test"))
        if name == ONE_SHOT and has_test:
            failures.append(f"{name}: a one-shot service must not declare a healthcheck")
        elif name != ONE_SHOT and not has_test:
            failures.append(f"{name}: no healthcheck, so `up --wait` cannot know it is ready")
    return failures


def check_restart(services: Mapping[str, Any]) -> list[str]:
    """`init` exits on purpose; everything else comes back after a crash."""
    failures: list[str] = []
    for name, service in sorted(services.items()):
        expected = "no" if name == ONE_SHOT else "unless-stopped"
        found = str(service.get("restart", ""))
        if found != expected:
            failures.append(f"{name}: restart is {found!r}, expected {expected!r}")
    return failures


def _mounts(service: Mapping[str, Any], target: str) -> list[Mapping[str, Any]]:
    volumes = service.get("volumes") or []
    return [mount for mount in volumes if mount.get("target") == target]


def check_database_volume(services: Mapping[str, Any]) -> list[str]:
    """The wrong target silently loses the database on restart."""
    mounts = _mounts(services.get("postgres", {}), PGDATA_TARGET)
    if not mounts:
        return [f"postgres: nothing is mounted at {PGDATA_TARGET}"]
    failures = []
    for mount in mounts:
        if mount.get("type") != "volume" or mount.get("source") != PGDATA_VOLUME:
            failures.append(
                f"postgres: {PGDATA_TARGET} is {mount.get('type')} {mount.get('source')!r},"
                f" expected the named volume {PGDATA_VOLUME!r}"
            )
    return failures


def check_model_cache(variant: str, services: Mapping[str, Any]) -> list[str]:
    """Only init writes the embedding model cache; the backend reads it."""
    failures: list[str] = []
    expectations = {ONE_SHOT: False, "backend": True}
    for name, read_only in expectations.items():
        mounts = _mounts(services.get(name, {}), MODEL_CACHE_TARGET)
        if len(mounts) != 1:
            failures.append(
                f"{name}: {len(mounts)} mounts at {MODEL_CACHE_TARGET}, expected exactly one"
            )
            continue
        mount = mounts[0]
        if bool(mount.get("read_only", False)) != read_only:
            wanted = "read-only" if read_only else "writable"
            failures.append(f"{name}: the model cache must be mounted {wanted}")
        if variant != CI_VARIANT and mount.get("source") != MODEL_CACHE_VOLUME:
            failures.append(
                f"{name}: the model cache is {mount.get('source')!r},"
                f" expected the named volume {MODEL_CACHE_VOLUME!r}"
            )
    return failures


def check_secret_reach(services: Mapping[str, Any]) -> list[str]:
    """Secrets via the environment: a key reaches the two services that call an API, no other."""
    failures: list[str] = []
    for name, service in sorted(services.items()):
        environment = service.get("environment") or {}
        found = frozenset(key for key in SECRETS if key in environment)
        expected = SECRET_HOLDERS.get(name, frozenset())
        if found != expected:
            failures.append(
                f"{name}: sees {sorted(found)}, expected {sorted(expected)}"
                " (a key reaches only the services that need it)"
            )
    return failures


def _published(services: Mapping[str, Any]) -> frozenset[PublishedPort]:
    found: set[PublishedPort] = set()
    for name, service in services.items():
        for port in service.get("ports") or []:
            found.add(
                (
                    name,
                    str(port.get("host_ip", "")),
                    int(port.get("target", 0)),
                    str(port.get("published", "")),
                )
            )
    return frozenset(found)


def check_ports(variant: str, services: Mapping[str, Any]) -> list[str]:
    """Nothing but the documented mappings reaches the host."""
    expected = _expected_ports(variant)
    found = _published(services)
    failures = [f"published port {port} is missing" for port in sorted(expected - found)]
    failures += [
        f"published port {port} is not part of the {variant} stack"
        for port in sorted(found - expected)
    ]
    return failures


def check_images(services: Mapping[str, Any]) -> list[str]:
    """The database image is pinned; every other service builds from a file."""
    failures: list[str] = []
    postgres = str(services.get("postgres", {}).get("image", ""))
    if postgres != POSTGRES_IMAGE:
        failures.append(f"postgres: image is {postgres!r}, expected {POSTGRES_IMAGE!r}")
    mqtt_build = services.get("mqtt", {}).get("build") or {}
    dockerfile = str(mqtt_build.get("dockerfile", ""))
    if dockerfile != MOSQUITTO_DOCKERFILE:
        failures.append(f"mqtt: builds from {dockerfile!r}, expected {MOSQUITTO_DOCKERFILE!r}")
    return failures


def check_rendered(variant: str, config: Mapping[str, Any]) -> list[str]:
    """Every invariant that needs the rendered configuration."""
    services = _services(config)
    failures = check_service_set(variant, services)
    if failures:
        # The later checks index by service name; an unexpected set first.
        return failures
    failures += check_depends_on(variant, services)
    failures += check_healthchecks(services)
    failures += check_restart(services)
    failures += check_database_volume(services)
    failures += check_model_cache(variant, services)
    failures += check_secret_reach(services)
    failures += check_ports(variant, services)
    failures += check_images(services)
    return failures


def _compose_files(root: Path) -> list[Path]:
    return sorted(path for path in root.glob(COMPOSE_GLOB) if path.is_file())


def check_no_env_file(root: Path) -> list[str]:
    """`make up` works on a clean clone, so nothing loads a dotenv file."""
    failures: list[str] = []
    for path in _compose_files(root):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if ENV_FILE_DIRECTIVE.match(line):
                failures.append(f"{path.name}:{number}: env_file is not allowed")
    return failures


def check_no_forbidden_literals(root: Path) -> list[str]:
    """Ground-truth isolation: no compose file names a path that holds the answers."""
    failures: list[str] = []
    for path in _compose_files(root):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            for literal in FORBIDDEN_LITERALS:
                if literal in line:
                    failures.append(
                        f"{path.name}:{number}: contains {literal!r} (ground-truth isolation)"
                    )
    return failures


def check_port_variables(root: Path) -> list[str]:
    """Every published port is overridable, so parallel stacks can coexist."""
    path = root / "compose.yaml"
    if not path.is_file():
        return ["compose.yaml is missing"]
    text = path.read_text(encoding="utf-8")
    return [
        f"compose.yaml: the published port {mapping} is missing"
        for mapping in PORT_MAPPINGS
        if mapping not in text
    ]


def check_broker_image(root: Path) -> list[str]:
    """The broker Dockerfile pins the base image it is verified on."""
    path = root / MOSQUITTO_DOCKERFILE
    if not path.is_file():
        print(
            f"compose-invariants: {MOSQUITTO_DOCKERFILE} is not there yet; skipping its image pin",
            file=sys.stderr,
        )
        return []
    text = path.read_text(encoding="utf-8")
    if _pins_broker_image(text):
        return []
    return [f"{MOSQUITTO_DOCKERFILE}: does not build FROM {MOSQUITTO_IMAGE}"]


def _pins_broker_image(text: str) -> bool:
    """Whether the Dockerfile's base image is the pinned one.

    The broker Dockerfile writes the pin as the default of `ARG MQTT_IMAGE`, so that the 2.1
    upgrade and a local smoke run are a build argument rather than an edit. A build that
    passes no `--build-arg` still gets the pinned tag, so both spellings satisfy the check.
    """
    if f"FROM {MOSQUITTO_IMAGE}" in text:
        return True
    arg = re.search(r"^ARG\s+MQTT_IMAGE=(\S+)\s*$", text, flags=re.MULTILINE)
    uses_arg = re.search(r"^FROM\s+\$\{?MQTT_IMAGE\}?\s*$", text, flags=re.MULTILINE)
    return arg is not None and uses_arg is not None and arg.group(1) == MOSQUITTO_IMAGE


def check_dockerignore(root: Path) -> list[str]:
    """A key can only reach an image through the build context."""
    path = root / DOCKERIGNORE
    if not path.is_file():
        return [f"{DOCKERIGNORE} is missing"]
    lines = {line.strip() for line in path.read_text(encoding="utf-8").splitlines()}
    return [
        f"{DOCKERIGNORE}: the line {entry!r} is missing"
        for entry in DOCKERIGNORE_REQUIRED
        if entry not in lines
    ]


def check_sources(root: Path) -> list[str]:
    """Every invariant a rendering cannot show, read off the files themselves."""
    failures = check_no_env_file(root)
    failures += check_no_forbidden_literals(root)
    failures += check_port_variables(root)
    failures += check_broker_image(root)
    failures += check_dockerignore(root)
    return failures


def _report(variant: str, failures: Sequence[str]) -> int:
    if not failures:
        print(f"compose-invariants: ok {variant}")
        return 0
    for failure in failures:
        print(f"compose-invariants: FAIL {variant}: {failure}", file=sys.stderr)
    print(
        f"compose-invariants: {len(failures)} Compose invariant(s)"
        f" do not hold for the {variant} variant",
        file=sys.stderr,
    )
    return EXIT_FAILURE


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="compose-invariants.py",
        description="Assert the invariants the Compose stack relies on.",
    )
    parser.add_argument(
        "variant",
        choices=VARIANTS,
        help=(
            "which file combination the rendered configuration on stdin comes from;"
            f" {SOURCES_VARIANT!r} reads no stdin and runs the source checks alone"
        ),
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root (default: the one this script lives in)",
    )
    return parser.parse_args(list(argv))


def _load_config(stream: Iterable[str]) -> Mapping[str, Any]:
    text = "".join(stream)
    if not text.strip():
        raise InvariantError(
            "no rendered configuration on stdin; pipe `docker compose … config --format json` in"
        )
    try:
        config = json.loads(text)
    except json.JSONDecodeError as error:
        raise InvariantError(
            f"stdin is not the JSON `docker compose config` writes ({error})"
        ) from error
    if not isinstance(config, dict):
        raise InvariantError("the rendered configuration is not a JSON object")
    return config


def main(argv: Sequence[str]) -> int:
    """Run the checks of one variant and report them."""
    args = _parse_args(argv)
    root: Path = args.root
    variant: str = args.variant
    try:
        failures = list(check_sources(root))
        if variant != SOURCES_VARIANT:
            failures += check_rendered(variant, _load_config(sys.stdin))
    except InvariantError as error:
        print(f"compose-invariants: {error}", file=sys.stderr)
        return EXIT_USAGE
    return _report(variant, failures)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

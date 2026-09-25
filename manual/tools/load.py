# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Load and schema-validate the CAU-7 manual source of truth.

``load_spec`` reads the six YAML files under ``<root>/spec``, ``<root>/build.yaml``
and the derived ``<root>/spec/derived/normal-bands.json``, validates every present
document against its JSON Schema (draft 2020-12) and returns a :class:`Spec`.

The schemas always come from this checkout (``manual/spec/schemas``) so that a
fixture directory only has to carry data, never a copy of the schemas.

This module is the single spec loader; ``manual/tools/validate.py``,
``manual/tools/context.py`` and the PDF build in ``tools/manual-build`` all go
through it, so its public API is stable.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

__all__ = [
    "SPEC_FILES",
    "YAML_FILE_KEYS",
    "Spec",
    "SpecError",
    "SpecLoader",
    "alarm_by_code",
    "cause_by_id",
    "condition_by_id",
    "load_spec",
    "resolve_duration",
    "resolve_threshold",
    "setting_by_id",
    "signal_by_id",
    "task_by_id",
]

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "spec" / "schemas"

#: file key -> (path relative to the spec root, schema file name)
SPEC_FILES: dict[str, tuple[str, str]] = {
    "machine": ("spec/machine.yaml", "machine.schema.json"),
    "signals": ("spec/signals.yaml", "signals.schema.json"),
    "settings": ("spec/settings.yaml", "settings.schema.json"),
    "alarms": ("spec/alarms.yaml", "alarms.schema.json"),
    "faults": ("spec/faults.yaml", "faults.schema.json"),
    "maintenance": ("spec/maintenance.yaml", "maintenance.schema.json"),
    "build": ("build.yaml", "build.schema.json"),
    "bands": ("spec/derived/normal-bands.json", "normal-bands.schema.json"),
}

#: the seven YAML documents ``--strict`` insists on (``bands`` is the JSON one)
YAML_FILE_KEYS: tuple[str, ...] = (
    "machine",
    "signals",
    "settings",
    "alarms",
    "faults",
    "maintenance",
    "build",
)


class SpecLoader(yaml.SafeLoader):
    """A safe YAML loader whose booleans follow the YAML 1.2 core schema.

    PyYAML implements YAML 1.1, where the bare scalars ``off``, ``on``, ``yes``
    and ``no`` are booleans. The manual spec uses ``off`` as a machine state,
    both as a mapping key (``normal_bands.off``) and as a value, and the Go and
    TypeScript loaders that read the same files follow YAML 1.2, where only
    ``true`` and ``false`` are booleans. Narrowing the resolver here makes every
    consumer agree. Source files SHOULD still quote ``"off"`` so that a plain
    ``yaml.safe_load`` elsewhere reads them the same way.
    """


def _install_yaml12_booleans(loader: type[yaml.SafeLoader]) -> None:
    """Replace the YAML 1.1 boolean resolvers of ``loader`` with the 1.2 set."""
    resolvers: dict[str, list[tuple[str, Any]]] = {
        first: [entry for entry in entries if entry[0] != "tag:yaml.org,2002:bool"]
        for first, entries in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }
    loader.yaml_implicit_resolvers = resolvers
    loader.add_implicit_resolver(
        "tag:yaml.org,2002:bool",
        re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
        list("tTfF"),
    )


_install_yaml12_booleans(SpecLoader)


class SpecError(Exception):
    """Raised when one or more documents fail to parse or to validate.

    ``messages`` holds one human-readable line per problem, each naming the file
    and the JSON pointer of the offending value.
    """

    def __init__(self, messages: list[str]) -> None:
        super().__init__("\n".join(messages))
        self.messages = messages


@dataclass(frozen=True)
class Spec:
    """Every loaded manual document, with JSON-compatible values throughout."""

    root: Path
    machine: dict[str, Any] | None = None
    signals: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None
    alarms: dict[str, Any] | None = None
    faults: dict[str, Any] | None = None
    maintenance: dict[str, Any] | None = None
    build: dict[str, Any] | None = None
    bands: dict[str, Any] | None = None
    files_present: frozenset[str] = field(default_factory=frozenset)

    def document(self, key: str) -> dict[str, Any] | None:
        """Return the loaded document for ``key`` (see :data:`SPEC_FILES`)."""
        document: dict[str, Any] | None = getattr(self, key)
        return document

    def path_of(self, key: str) -> str:
        """Return the spec-root-relative path of ``key`` for finding messages."""
        return SPEC_FILES[key][0]

    @property
    def signal_list(self) -> list[dict[str, Any]]:
        return list((self.signals or {}).get("signals", []))

    @property
    def setting_list(self) -> list[dict[str, Any]]:
        return list((self.settings or {}).get("settings", []))

    @property
    def alarm_list(self) -> list[dict[str, Any]]:
        return list((self.alarms or {}).get("alarms", []))

    @property
    def condition_list(self) -> list[dict[str, Any]]:
        return list((self.faults or {}).get("conditions", []))

    @property
    def cause_list(self) -> list[dict[str, Any]]:
        return list((self.faults or {}).get("causes", []))

    @property
    def task_list(self) -> list[dict[str, Any]]:
        return list((self.maintenance or {}).get("tasks", []))


def _jsonify(value: Any) -> Any:
    """Return ``value`` with YAML dates and datetimes turned into ISO strings.

    ``yaml.safe_load`` parses ``2026-01-15`` into a :class:`datetime.date`, which
    JSON Schema cannot see as a string. Normalising once here keeps the loaded
    documents JSON-compatible for every consumer.
    """
    if isinstance(value, dict):
        return {key: _jsonify(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonify(item) for item in value]
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    return value


def _pointer(parts: Any) -> str:
    """Render a jsonschema error path as an RFC 6901 JSON pointer."""
    if not parts:
        return "/"
    escaped = [str(part).replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped)


def _schema_registry() -> tuple[Registry, dict[str, dict[str, Any]]]:
    """Build a referencing registry holding every schema under :data:`SCHEMA_DIR`."""
    schemas: dict[str, dict[str, Any]] = {}
    pairs: list[tuple[str, Resource]] = []
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        contents = json.loads(path.read_text(encoding="utf-8"))
        schemas[path.name] = contents
        resource = Resource.from_contents(contents, default_specification=DRAFT202012)
        pairs.append((path.name, resource))
        schema_id = contents.get("$id")
        if schema_id:
            pairs.append((schema_id, resource))
    return Registry().with_resources(pairs), schemas


def _read_document(path: Path) -> Any:
    if path.suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    # SpecLoader derives from yaml.SafeLoader, so this is exactly as safe as
    # yaml.safe_load: no Python object tags are constructed, only the boolean
    # resolver differs.
    return yaml.load(
        path.read_text(encoding="utf-8"),
        Loader=SpecLoader,  # noqa: S506 - a SafeLoader subclass, see the class docstring
    )


def load_spec(root: Path = Path("manual"), only: set[str] | None = None) -> Spec:
    """Load, normalise and schema-validate the manual spec rooted at ``root``.

    Args:
        root: the directory that holds ``build.yaml`` and ``spec/``.
        only: file keys of :data:`SPEC_FILES` to load; ``None`` loads all of them.
            Keys whose file is absent are simply left out of ``files_present``.

    Raises:
        SpecError: if any selected document fails to parse or to validate; the
            exception carries one message per problem, each with file and pointer.
    """
    root = Path(root)
    wanted = set(SPEC_FILES) if only is None else {key for key in only if key in SPEC_FILES}
    unknown = set() if only is None else set(only) - set(SPEC_FILES)
    errors: list[str] = []
    for key in sorted(unknown):
        errors.append(f"{root}: unknown spec file key {key!r}")

    registry, schemas = _schema_registry()
    documents: dict[str, Any] = {}
    present: set[str] = set()

    for key, (relative, schema_name) in SPEC_FILES.items():
        if key not in wanted:
            continue
        path = root / relative
        if not path.is_file():
            continue
        try:
            raw = _read_document(path)
        except (yaml.YAMLError, json.JSONDecodeError) as exc:
            errors.append(f"{relative}:/ cannot parse: {exc}")
            continue
        if not isinstance(raw, dict):
            errors.append(f"{relative}:/ expected a mapping at the document root")
            continue
        document = _jsonify(raw)
        validator = Draft202012Validator(schemas[schema_name], registry=registry)
        for error in sorted(validator.iter_errors(document), key=lambda err: list(err.path)):
            errors.append(f"{relative}:{_pointer(error.absolute_path)} {error.message}")
        documents[key] = document
        present.add(key)

    if errors:
        raise SpecError(errors)

    return Spec(root=root, files_present=frozenset(present), **documents)


# --- lookup helpers -------------------------------------------------------


def signal_by_id(spec: Spec, signal_id: str) -> dict[str, Any] | None:
    """Return the signal tag with ``signal_id``, or ``None``."""
    return next((item for item in spec.signal_list if item.get("id") == signal_id), None)


def setting_by_id(spec: Spec, setting_id: str) -> dict[str, Any] | None:
    """Return the programmable setting with ``setting_id``, or ``None``."""
    return next((item for item in spec.setting_list if item.get("id") == setting_id), None)


def alarm_by_code(spec: Spec, code: str) -> dict[str, Any] | None:
    """Return the controller message with ``code``, or ``None``."""
    return next((item for item in spec.alarm_list if item.get("code") == code), None)


def cause_by_id(spec: Spec, fault_id: str) -> dict[str, Any] | None:
    """Return the cause with ``fault_id``, or ``None``."""
    return next((item for item in spec.cause_list if item.get("fault_id") == fault_id), None)


def condition_by_id(spec: Spec, condition_id: str) -> dict[str, Any] | None:
    """Return the symptom condition with ``condition_id``, or ``None``."""
    return next((item for item in spec.condition_list if item.get("id") == condition_id), None)


def task_by_id(spec: Spec, task_id: str) -> dict[str, Any] | None:
    """Return the maintenance task with ``task_id``, or ``None``."""
    return next((item for item in spec.task_list if item.get("id") == task_id), None)


# --- resolution helpers ---------------------------------------------------


def resolve_threshold(
    spec: Spec,
    threshold: dict[str, Any],
    signal: dict[str, Any] | None = None,
) -> tuple[float, str] | None:
    """Resolve an alarm threshold to ``(value, unit)``.

    An inline ``{value, unit}`` is returned as is. A ``{setting, offset?}``
    reference resolves to the setting's default plus the offset, carrying the
    setting's unit. ``None`` means the reference does not resolve; rule R1
    reports the dangling id, so callers can skip silently.

    ``signal`` is accepted for symmetry with the callers (rules P2 and P4) and
    is not needed to resolve the value.
    """
    del signal
    if "value" in threshold:
        return float(threshold["value"]), str(threshold["unit"])
    setting = setting_by_id(spec, str(threshold.get("setting", "")))
    if setting is None:
        return None
    return float(setting["default"]) + float(threshold.get("offset", 0)), str(setting["unit"])


def resolve_duration(spec: Spec, for_s: int | dict[str, Any]) -> int | None:
    """Resolve ``for_s`` (seconds, or a setting reference) to whole seconds.

    Returns ``None`` when a setting reference does not resolve.
    """
    if isinstance(for_s, dict):
        setting = setting_by_id(spec, str(for_s.get("setting", "")))
        if setting is None:
            return None
        return round(float(setting["default"]) + float(for_s.get("offset", 0)))
    return int(for_s)

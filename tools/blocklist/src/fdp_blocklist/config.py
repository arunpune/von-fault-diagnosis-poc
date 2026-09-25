# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``tools/blocklist/blocklist.toml`` and the paths of the tool's own data."""

import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Final

__all__ = ["CONFIG_NAME", "Config", "ConfigError", "find_tool_dir", "load_config"]

CONFIG_NAME: Final = "blocklist.toml"
_TOOL_SUBPATH: Final = Path("tools") / "blocklist"


class ConfigError(RuntimeError):
    """The tool's configuration is missing or malformed."""


@dataclass(frozen=True, slots=True)
class Config:
    """The scanner's settings plus the locations of its data files."""

    tool_dir: Path
    salt: str
    exclude: tuple[str, ...]
    pdf_globs: tuple[str, ...]

    @property
    def hash_file(self) -> Path:
        """The committed digest file."""
        return self.tool_dir / "data" / "blocklist.sha256"

    @property
    def allow_file(self) -> Path:
        """The committed allow list of reviewed exemptions."""
        return self.tool_dir / "data" / "allow.txt"

    @property
    def private_list(self) -> Path:
        """The gitignored plain-text list; absent in CI and in a fresh clone."""
        return self.tool_dir / "private" / "blocklist.txt"


def find_tool_dir(start: Path | None = None) -> Path:
    """Locate ``tools/blocklist``: next to this package, else above ``start``."""
    installed = Path(__file__).resolve().parents[2]
    if (installed / CONFIG_NAME).is_file():
        return installed
    here = (start or Path.cwd()).resolve()
    for candidate in (here, *here.parents):
        if (candidate / _TOOL_SUBPATH / CONFIG_NAME).is_file():
            return candidate / _TOOL_SUBPATH
    raise ConfigError(f"{CONFIG_NAME} not found next to fdp_blocklist or above {here}")


def _string_list(table: dict[str, object], key: str, source: Path) -> tuple[str, ...]:
    value = table.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ConfigError(f"{source}: [scan] {key} must be a list of strings")
    return tuple(str(item) for item in value)


def load_config(tool_dir: Path | None = None) -> Config:
    """Read ``blocklist.toml`` from ``tool_dir`` (discovered when not given)."""
    directory = tool_dir if tool_dir is not None else find_tool_dir()
    source = directory / CONFIG_NAME
    try:
        parsed = tomllib.loads(source.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ConfigError(f"{source}: {error}") from error
    scan = parsed.get("scan")
    if not isinstance(scan, dict):
        raise ConfigError(f"{source}: missing the [scan] table")
    salt = scan.get("salt")
    if not isinstance(salt, str) or not salt:
        raise ConfigError(f"{source}: [scan] salt must be a non-empty string")
    return Config(
        tool_dir=directory,
        salt=salt,
        exclude=_string_list(scan, "exclude", source),
        pdf_globs=_string_list(scan, "pdf_globs", source),
    )

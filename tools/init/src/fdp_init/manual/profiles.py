# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Table profiles, identifier grammar and vocabularies.

Everything a manual-specific assumption could hide in lives here, so
``tables.py`` and the catalog builder stay free of it: which header words name
which column, what a fault id looks like, and how the English of a move
sentence maps onto the manual's closed vocabulary.

The vocabularies are the manual's, not a translation of them: the
``signal_move`` direction enum of ``common.schema.json`` *is* the list of the
manual's words, and the ten subsystems are the manual's ten. The maps below
therefore only normalise inflected, plain-English forms back onto those words —
``"is higher"`` onto ``higher`` — and never invent a target the contracts do not
know.

Nothing in this module reads a PDF; it works on strings, so every rule in it is
unit-testable without pdfplumber.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache

from ..util.textnorm import norm_header_cell, norm_ws
from .model import Table, TableKind

__all__ = [
    "ALARM_CODE_RE",
    "ALARM_KIND_WORDS",
    "BEHAVIOURS",
    "BENIGN_WORDS",
    "CANONICAL_COLUMNS",
    "CONDITION_ID_RE",
    "DEFAULT_ALARM_KIND",
    "DEFAULT_SUBSYSTEM",
    "DIRECTION_MAP",
    "FAULT_ID_RE",
    "GROUP_SYMPTOM_SEPARATOR",
    "HEADER_HINT_COVERAGE",
    "HEADER_HINT_HITS",
    "LIKELIHOODS",
    "MIN_HEADER_HITS",
    "ONSET_MAP",
    "PHASE_MAP",
    "PROFILES",
    "SUBSYSTEM_KEYWORDS",
    "SUBSYSTEM_MAP",
    "CauseMarker",
    "Profile",
    "SignalMoveDraft",
    "SignalsIndex",
    "TableKind",
    "alarm_code_re",
    "alarm_kind",
    "classify_header",
    "condition_id_re",
    "fault_id_re",
    "header_hint_hits",
    "infer_subsystem",
    "is_benign",
    "label_column",
    "looks_like_header_line",
    "map_subsystem",
    "normalize_direction",
    "normalize_id",
    "parse_cause_marker",
    "parse_delay",
    "parse_move_sentence",
    "parse_quantity",
    "signal_tag",
    "split_tag_cell",
]

# ---------------------------------------------------------------------------
# Header profiles
# ---------------------------------------------------------------------------

MIN_HEADER_HITS = 2
"""A row is a header only when it names at least this many known columns."""

HEADER_HINT_HITS = 3
"""Synonym hits that make a bare text line look like a header (the fallback).

Higher than :data:`MIN_HEADER_HITS` on purpose: this threshold decides whether
an *unruled* page is re-parsed with the text strategy, and a false positive
there costs a junk table, so it asks for one more column than a header row that
already sits inside ruled borders.
"""

HEADER_HINT_COVERAGE = 0.60
"""Share of a text line's words that must belong to the columns it names.

Without it a prose sentence that happens to use several column words reads as a
header; see :func:`looks_like_header_line`.
"""

CANONICAL_COLUMNS: frozenset[str] = frozenset(
    {
        "alarms",
        "cause",
        "checks",
        "code",
        "condition",
        "consumables",
        "default",
        "delay",
        "description",
        "id",
        "interval",
        "kind",
        "label",
        "max",
        "min",
        "normal",
        "parameter",
        "post_checks",
        "procedure",
        "range",
        "rate",
        "remedy",
        "reset",
        "signal",
        "signals",
        "source_column",
        "subsystem",
        "tag",
        "task",
        "threshold",
        "title",
        "trigger",
        "type",
        "unit",
    }
)
"""Every column name a profile may map to; the catalog builder reads these."""


@dataclass(frozen=True, slots=True)
class Profile:
    """One table shape: which header words name which canonical column.

    ``required`` is a tuple of alternatives: every group must be satisfied by at
    least one of its columns, and the row must name :data:`MIN_HEADER_HITS`
    known columns in total. That is the "≥ 2 hits" rule written so that
    "code plus one of title/type/trigger" fits it too.
    """

    kind: TableKind
    synonyms: Mapping[str, tuple[str, ...]]
    required: tuple[frozenset[str], ...]

    def column_map(self, cells: Sequence[str]) -> dict[str, int] | None:
        """Map canonical column names to indices, or ``None`` when no match.

        The first cell that claims a canonical name keeps it, so a table that
        prints ``Min`` twice does not lose its first one.
        """
        index = _synonym_index(self.kind)
        found: dict[str, int] = {}
        for position, cell in enumerate(cells):
            canonical = index.get(norm_header_cell(cell))
            if canonical is not None and canonical not in found:
                found[canonical] = position
        if len(found) < MIN_HEADER_HITS:
            return None
        if any(not (group & found.keys()) for group in self.required):
            return None
        return found


TROUBLESHOOTING_PROFILE = Profile(
    kind=TableKind.TROUBLESHOOTING,
    synonyms={
        "id": ("id", "fault id", "fault", "ref", "reference", "code", "no"),
        "cause": ("cause", "possible cause", "probable cause", "likely cause"),
        # The troubleshooting table has a subsystem column; without it no
        # wording of a benign cause infers one.
        "subsystem": ("subsystem", "system", "area"),
        "signals": (
            "signals",
            "signal behaviour",
            "signal behavior",
            "signal moves",
            "indications",
            "what the signals do",
        ),
        "checks": ("check", "checks", "what to check", "verification", "how to check"),
        "remedy": ("remedy", "action", "corrective action", "solution", "what to do"),
        "alarms": ("alarms", "messages", "related alarms"),
        "condition": ("condition", "symptom", "problem"),
    },
    required=(frozenset({"cause"}), frozenset({"remedy"})),
)

ALARMS_PROFILE = Profile(
    kind=TableKind.ALARMS,
    synonyms={
        "code": ("code", "message code", "id", "no"),
        "title": ("title", "message", "text", "description", "meaning"),
        "type": ("type", "class", "category", "kind"),
        "trigger": ("trigger", "condition", "cause"),
        "threshold": ("threshold", "limit", "setpoint"),
        "delay": ("delay", "delay s", "time"),
        "reset": ("reset", "reset rule", "acknowledge"),
        "signal": ("signal", "tag"),
    },
    required=(frozenset({"code"}), frozenset({"title", "type", "trigger"})),
)

PARAMETERS_PROFILE = Profile(
    kind=TableKind.PARAMETERS,
    synonyms={
        "parameter": ("parameter", "setting", "name", "no", "id"),
        "min": ("min", "minimum"),
        "default": ("default", "factory"),
        "max": ("max", "maximum"),
        "unit": ("unit",),
        "description": ("description",),
    },
    required=(
        frozenset({"parameter"}),
        frozenset({"min"}),
        frozenset({"default"}),
        frozenset({"max"}),
    ),
)

SIGNALS_PROFILE = Profile(
    kind=TableKind.SIGNALS,
    synonyms={
        "tag": ("tag", "signal", "id", "tag id"),
        "label": ("label", "panel label"),
        "description": ("description", "meaning"),
        "unit": ("unit",),
        "kind": ("kind", "type"),
        "range": ("range", "min", "max"),
        "source_column": ("source column", "metropt column", "column"),
        "normal": ("normal", "normal band", "loaded", "unloaded", "off"),
        "rate": ("sample rate", "rate"),
    },
    required=(frozenset({"tag"}), frozenset({"unit"})),
)

MAINTENANCE_PROFILE = Profile(
    kind=TableKind.MAINTENANCE,
    synonyms={
        "task": ("task", "activity", "item", "id"),
        "interval": ("interval", "every", "period", "hours"),
        "consumables": ("consumables", "parts"),
        "procedure": ("procedure",),
        "post_checks": ("post service checks", "check after"),
    },
    required=(frozenset({"task"}), frozenset({"interval"})),
)

PROFILES: tuple[Profile, ...] = (
    TROUBLESHOOTING_PROFILE,
    ALARMS_PROFILE,
    SIGNALS_PROFILE,
    PARAMETERS_PROFILE,
    MAINTENANCE_PROFILE,
)
"""Every profile but ``OTHER``, which is the "nothing matched" answer."""

_PROFILES_BY_KIND: dict[TableKind, Profile] = {profile.kind: profile for profile in PROFILES}


@lru_cache(maxsize=len(PROFILES))
def _synonym_index(kind: TableKind) -> Mapping[str, str]:
    """Reverse the profile's synonym sets into ``phrase -> canonical column``."""
    index: dict[str, str] = {}
    for canonical, phrases in _PROFILES_BY_KIND[kind].synonyms.items():
        for phrase in phrases:
            index.setdefault(phrase, canonical)
    return index


@lru_cache(maxsize=len(PROFILES))
def _hint_pattern(kind: TableKind) -> re.Pattern[str]:
    """Alternation over one profile's synonyms, longest phrase first."""
    phrases = sorted(_synonym_index(kind), key=len, reverse=True)
    alternatives = "|".join(re.escape(phrase) for phrase in phrases)
    return re.compile(rf"\b(?:{alternatives})\b")


def classify_header(cells: Sequence[str]) -> tuple[TableKind, dict[str, int]]:
    """Classify a header row and map its canonical columns to indices.

    Returns ``(TableKind.OTHER, {})`` when no profile matches. When several do,
    the one that recognises the most columns wins; :data:`PROFILES` breaks a tie
    in its own order, which puts the troubleshooting table first because it is
    the one the catalog is built from.
    """
    best_kind = TableKind.OTHER
    best_map: dict[str, int] = {}
    for profile in PROFILES:
        found = profile.column_map(cells)
        if found is not None and len(found) > len(best_map):
            best_kind, best_map = profile.kind, found
    return best_kind, best_map


def label_column(kind: TableKind, label: str) -> str | None:
    """The canonical column that ``label`` names in the profile of ``kind``.

    ``"Signals"`` names ``signals`` in a troubleshooting table. ``None`` when
    the profile knows no such header word, and always for ``OTHER``, which has
    no profile.
    """
    if kind not in _PROFILES_BY_KIND:
        return None
    return _synonym_index(kind).get(norm_header_cell(label))


def header_hint_hits(line: str) -> int:
    """Count the columns the best-matching profile recognises in one text line.

    ``tables.py`` uses it on a page that yielded no ruled table: a prose line
    names at most one or two column words by accident, a printed header names
    several.
    """
    return _hint_scan(line)[0]


def _hint_scan(line: str) -> tuple[int, float]:
    """Best profile's ``(distinct columns named, share of the line they cover)``."""
    normalised = norm_header_cell(line)
    words = len(normalised.split())
    if not words:
        return 0, 0.0
    best = (0, 0.0)
    for profile in PROFILES:
        index = _synonym_index(profile.kind)
        columns: set[str] = set()
        covered = 0
        for match in _hint_pattern(profile.kind).finditer(normalised):
            phrase = match.group(0)
            columns.add(index[phrase])
            covered += len(phrase.split())
        best = max(best, (len(columns), covered / words))
    return best


def looks_like_header_line(line: str) -> bool:
    """True when a bare text line reads like a printed table header.

    Two conditions, because either alone misfires: the line must name
    :data:`HEADER_HINT_HITS` distinct columns, *and* those column words must be
    most of the line. A sentence such as "lists the causes of one condition, the
    signals that move, what to check and what to do" names four columns by
    accident but spends two thirds of its words on prose, so only the coverage
    test tells it apart from ``Fault id | Possible cause | Signals | Checks``.
    """
    hits, coverage = _hint_scan(line)
    return hits >= HEADER_HINT_HITS and coverage >= HEADER_HINT_COVERAGE


# ---------------------------------------------------------------------------
# Identifier grammar
# ---------------------------------------------------------------------------

FAULT_ID_RE = r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b"
"""Default fault-id pattern: snake_case with at least one underscore.

The manual's grammar is ``^[a-z][a-z0-9_]{1,39}$``, but a *scanner* built
from it would match every ordinary lower-case word in the prose. Requiring one
underscore keeps ``oil_cooler_fouled`` and rejects ``cooler``.
"""

CONDITION_ID_RE = FAULT_ID_RE
"""Condition ids share the fault-id grammar."""

ALARM_CODE_RE = r"\b[WXSM][0-9]{3}\b"
"""Default alarm-code pattern, ``W104`` and friends."""

FAULT_ID_PATTERN_ENV = "CATALOG_FAULT_ID_PATTERN"
CONDITION_ID_PATTERN_ENV = "CATALOG_CONDITION_ID_PATTERN"
ALARM_CODE_PATTERN_ENV = "CATALOG_ALARM_CODE_PATTERN"


@lru_cache(maxsize=32)
def _compile(pattern: str, variable: str) -> re.Pattern[str]:
    try:
        return re.compile(pattern)
    except re.error as exc:  # pragma: no cover - exercised through _env_pattern
        raise ValueError(f"{variable} is not a valid regular expression: {exc}") from exc


def _env_pattern(variable: str, default: str) -> re.Pattern[str]:
    """Compile the override in ``variable``, or the default when it is unset.

    An empty value counts as unset, and the environment is read
    on every call so a test that sets the variable needs no module reload.
    """
    return _compile(os.environ.get(variable, "").strip() or default, variable)


def fault_id_re() -> re.Pattern[str]:
    """The fault-id scanner, honouring ``CATALOG_FAULT_ID_PATTERN``."""
    return _env_pattern(FAULT_ID_PATTERN_ENV, FAULT_ID_RE)


def condition_id_re() -> re.Pattern[str]:
    """The condition-id scanner, honouring ``CATALOG_CONDITION_ID_PATTERN``."""
    return _env_pattern(CONDITION_ID_PATTERN_ENV, CONDITION_ID_RE)


def alarm_code_re() -> re.Pattern[str]:
    """The alarm-code scanner, honouring ``CATALOG_ALARM_CODE_PATTERN``."""
    return _env_pattern(ALARM_CODE_PATTERN_ENV, ALARM_CODE_RE)


def normalize_id(kind: str, raw: str) -> str:
    """The single normalisation hook for an identifier read off the page.

    Ids are stored verbatim, so this is the identity for every id kind but
    ``subsystem``: the manual prints ``intake unloading`` with a space where the
    contract enum has an underscore, and putting
    it back is a spelling fix, not a translation.
    """
    text = norm_ws(raw)
    if kind == "subsystem":
        return re.sub(r"[\s-]+", "_", text.lower())
    return text


_LABELLED_TAG_RE = re.compile(r"^(?P<label>[A-Z][A-Z0-9]{0,5})\s+(?P<tag>[a-z][a-z0-9_]{1,39})$")
"""``P1 discharge_pressure``: a panel label, then a tag id of the snake_case grammar."""


def split_tag_cell(cell: str) -> tuple[str, str]:
    """Split a tag cell into ``(tag id, panel label)``.

    The mini manual prints the tag and the panel label in columns of their own;
    the committed CAU-7 signal list prints both in the tag cell, label first.
    A cell of any other shape is the tag alone, with no label, so a BYO
    manual's tags are kept exactly as printed.
    """
    text = norm_ws(cell)
    match = _LABELLED_TAG_RE.match(text)
    if match is None:
        return normalize_id("signal", text), ""
    return normalize_id("signal", match.group("tag")), match.group("label")


def signal_tag(cells: Sequence[str], tag_column: int, label_column: int | None) -> tuple[str, str]:
    """The tag id and the panel label of one ``SIGNALS`` row.

    A label column, when the table has one, wins over a label printed in the tag
    cell; both layouts give the same pair.
    """
    tag, label = split_tag_cell(_cell(cells, tag_column))
    printed = norm_ws(_cell(cells, label_column))
    return tag, printed or label


# ---------------------------------------------------------------------------
# Signal-move vocabulary (the manual's)
# ---------------------------------------------------------------------------

DIRECTION_MAP: Mapping[str, str] = {
    "rises": "rises",
    "rise": "rises",
    "rising": "rises",
    "increases": "rises",
    "increase": "rises",
    "increasing": "rises",
    "climbs": "rises",
    "goes up": "rises",
    "falls": "falls",
    "fall": "falls",
    "falling": "falls",
    "drops": "falls",
    "drop": "falls",
    "dropping": "falls",
    "decreases": "falls",
    "decrease": "falls",
    "decreasing": "falls",
    "goes down": "falls",
    "high": "high",
    "is high": "high",
    "reads high": "high",
    "stays high": "high",
    "above normal": "high",
    "low": "low",
    "is low": "low",
    "reads low": "low",
    "stays low": "low",
    "below normal": "low",
    "unchanged": "unchanged",
    "is unchanged": "unchanged",
    "does not change": "unchanged",
    "stays the same": "unchanged",
    "no change": "unchanged",
    "flat": "unchanged",
    "fluctuates": "fluctuates",
    "fluctuate": "fluctuates",
    "fluctuating": "fluctuates",
    "swings": "fluctuates",
    "erratic": "fluctuates",
    "is erratic": "fluctuates",
    "near_zero": "near_zero",
    "near zero": "near_zero",
    "close to zero": "near_zero",
    "almost zero": "near_zero",
    "not_venting": "not_venting",
    "not venting": "not_venting",
    "does not vent": "not_venting",
    "no venting": "not_venting",
    "on": "on",
    "is on": "on",
    "turns on": "on",
    "switches on": "on",
    "off": "off",
    "is off": "off",
    "turns off": "off",
    "switches off": "off",
    "stays_on": "stays_on",
    "stays on": "stays_on",
    "remains on": "stays_on",
    "stays_off": "stays_off",
    "stays off": "stays_off",
    "remains off": "stays_off",
    "toggles": "toggles",
    "toggle": "toggles",
    "toggling": "toggles",
    "cycles on and off": "toggles",
    "no_pulse": "no_pulse",
    "no pulse": "no_pulse",
    "no pulses": "no_pulse",
    "does not pulse": "no_pulse",
    "higher": "higher",
    "is higher": "higher",
    "more often": "higher",
    "lower": "lower",
    "is lower": "lower",
    "less often": "lower",
    "longer": "longer",
    "is longer": "longer",
    "takes longer": "longer",
    "shorter": "shorter",
    "is shorter": "shorter",
    "faster": "faster",
    "is faster": "faster",
    "slower": "slower",
    "is slower": "slower",
    "not_reached": "not_reached",
    "not reached": "not_reached",
    "is not reached": "not_reached",
    "does not reach": "not_reached",
    "never reached": "not_reached",
}
"""Plain-English move wording to the manual's direction word (identity on its own words)."""

AMBIGUOUS_DIRECTION_WORDS = frozenset({"on", "off"})
"""Words of :data:`DIRECTION_MAP` that are too common to scan a sentence for.

``on`` and ``off`` are ordinary prepositions; the sentence scanner therefore
only recognises them in a phrase (``is on``, ``turns off``), while
:func:`normalize_direction` still accepts the bare word from a table cell.
"""

BEHAVIOURS: Mapping[str, tuple[str, ...]] = {
    "load_cycle_rate": (
        "how often the compressor loads per hour",
        "load cycle rate",
        "load cycle",
    ),
    "loaded_run_duration": (
        "how long each loaded run lasts",
        "loaded run duration",
        "loaded run",
    ),
    "unloaded_pressure_decay": (
        "how fast line pressure falls while the unit is not delivering",
        "pressure decay while unloaded",
        "unloaded pressure decay",
        "pressure decay",
    ),
    "cut_out_reached": (
        "whether a loaded run ends at the cut-out pressure",
        "cut-out",
        "cut out",
    ),
    "pressure_rise_while_loaded": (
        "how fast line pressure rises during a loaded run",
        "pressure rise while loaded",
        "pressure rise",
    ),
    "start_current_peak": (
        "the current peak at motor start",
        "start current peak",
        "start current",
    ),
}
"""The manual's derived behaviours and the wording ``move_text()`` prints them with.

The first phrase of each is the behaviour's ``description`` in
``manual/spec/signals.yaml``, which is the subject ``move_text()`` opens the
sentence with; the shorter ones are the plain-English names another manual may
use. The description has to be listed because it names a signal on the way —
"How fast line pressure falls while the unit is not delivering is faster" — and
the leftmost match is what :func:`parse_move_sentence` reads the sentence as, so
without it that sentence is ``line_pressure`` / ``falls``.

A behaviour is the ``behaviour`` side of the contracts ``signal_move``, never a
signal tag, so :class:`SignalMoveDraft` flags it.
"""

ONSET_MAP: Mapping[str, str] = {
    "gradually": "gradual",
    "gradual": "gradual",
    "slowly": "gradual",
    "over time": "gradual",
    "suddenly": "sudden",
    "sudden": "sudden",
    "abruptly": "sudden",
    "sharply": "sudden",
    "intermittently": "intermittent",
    "intermittent": "intermittent",
    "from time to time": "intermittent",
    "sustained": "sustained",
    "continuously": "sustained",
    "steadily": "sustained",
    "persistently": "sustained",
}
"""Onset wording to the ``onset`` enum of ``common.schema.json``."""

PHASE_MAP: Mapping[str, str] = {
    "while loaded": "loaded",
    "when loaded": "loaded",
    "under load": "loaded",
    "at full load": "loaded",
    "loaded": "loaded",
    "while unloaded": "unloaded",
    "when unloaded": "unloaded",
    "unloaded": "unloaded",
    "while off": "off",
    "when off": "off",
    "with the unit stopped": "off",
    "while the unit is off": "off",
    "at standstill": "off",
    "in every state": "any",
    "in any state": "any",
    "in all states": "any",
    "at any time": "any",
    "at start": "start",
    "on start": "start",
    "while starting": "start",
    "during start": "start",
    "at startup": "start",
}
"""Phase wording to the ``phase`` enum of ``common.schema.json``."""

MAN_SUBSYSTEMS: tuple[str, ...] = (
    "compressor",
    "intake_unloading",
    "oil",
    "cooling",
    "separator_drain",
    "dryer",
    "reservoirs",
    "distribution",
    "control",
    "electrical",
)
"""The ten subsystems of ``common.schema.json``; the manual's list verbatim."""

SUBSYSTEM_MAP: Mapping[str, str] = {name: name for name in MAN_SUBSYSTEMS}
"""The manual to the contracts: the identity.

The enum no longer carries ``downstream``, ``controls`` or ``other``.
"""

DEFAULT_SUBSYSTEM = "compressor"
"""Where a cause lands when nothing names or infers a subsystem.

The enum carries no ``other``; ``compressor`` is the machine-level value that
remains, so an unplaceable cause still validates.
The manual of this repository prints the column, so this is a BYO-manual
fallback only.
"""

SUBSYSTEM_KEYWORDS: Mapping[str, str] = {
    "airend": "compressor",
    "bearing": "compressor",
    "element": "intake_unloading",
    "intake": "intake_unloading",
    "unload": "intake_unloading",
    "unloading": "intake_unloading",
    "oil": "oil",
    "lubricant": "oil",
    "ambient": "cooling",
    "cooler": "cooling",
    "cooling": "cooling",
    "fan": "cooling",
    "radiator": "cooling",
    "drain": "separator_drain",
    "separator": "separator_drain",
    "dryer": "dryer",
    "purge": "dryer",
    "tower": "dryer",
    "receiver": "reservoirs",
    "reservoir": "reservoirs",
    "demand": "distribution",
    "distribution": "distribution",
    "downstream": "distribution",
    "leak": "distribution",
    "controller": "control",
    "sensor": "control",
    "setting": "control",
    "transducer": "control",
    "contactor": "electrical",
    "motor": "electrical",
    "relay": "electrical",
    "voltage": "electrical",
}
"""Keyword inference for a manual that prints no subsystem column."""

BENIGN_WORDS: tuple[str, ...] = ("no fault", "ambient", "demand", "normal operation")
"""Wording that marks a cause as benign; the manual has three such causes."""

ALARM_KIND_WORDS: tuple[tuple[str, str], ...] = (
    ("shutdown warning", "shutdown_warning"),
    ("shutdown", "shutdown"),
    ("service", "service"),
)
"""Type-cell wording to the ``alarm_type`` enum; order matters, longest first."""

DEFAULT_ALARM_KIND = "warning"
"""What an alarm is when its type cell names none of :data:`ALARM_KIND_WORDS`."""


def _alternation(phrases: Iterable[str]) -> re.Pattern[str]:
    """Compile a word-bounded alternation, longest phrase first.

    Longest first makes the regex engine prefer the longest phrase that starts
    at the leftmost matching position, so ``"is higher"`` beats ``"higher"``.
    Equal-length phrases are ordered alphabetically rather than by the set's
    iteration order, so the compiled pattern is the same in every process: two
    phrases of one length can never both match at one position, but a pattern
    that changes with ``PYTHONHASHSEED`` is not something to debug twice.

    A hyphen in a phrase also matches a space or nothing: a compound the line
    broke at its hyphen comes back joined, ``"cut-\nout"`` as ``"cutout"``,
    because :func:`~fdp_init.util.textnorm.dehyphenate` cannot tell that hyphen
    from a soft one.
    """
    ordered = sorted(set(phrases), key=lambda phrase: (-len(phrase), phrase))
    alternatives = "|".join(re.escape(phrase).replace(r"\-", "[- ]?") for phrase in ordered)
    return re.compile(rf"\b(?:{alternatives})\b")


_DIRECTION_SCANNER = _alternation(
    phrase for phrase in DIRECTION_MAP if phrase not in AMBIGUOUS_DIRECTION_WORDS
)
_ONSET_SCANNER = _alternation(ONSET_MAP)
_PHASE_SCANNER = _alternation(PHASE_MAP)
_BEHAVIOUR_CANDIDATES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (_alternation(phrases), behaviour) for behaviour, phrases in BEHAVIOURS.items()
)


def normalize_direction(word: str) -> str | None:
    """Map one direction word or phrase onto the manual's vocabulary.

    Returns ``None`` for wording the manual does not use, so a caller can keep
    the sentence as free text instead of guessing.
    """
    return DIRECTION_MAP.get(norm_ws(word).lower())


def map_subsystem(raw: str) -> str:
    """Map a printed subsystem cell onto the contracts enum.

    The cell is spelled with spaces (``intake unloading``); anything the enum
    does not know falls back to keyword inference on the same text.
    """
    normalised = normalize_id("subsystem", raw)
    mapped = SUBSYSTEM_MAP.get(normalised)
    if mapped is not None:
        return mapped
    return infer_subsystem(raw)


def infer_subsystem(text: str) -> str:
    """Infer a subsystem from free text, :data:`DEFAULT_SUBSYSTEM` when unsure.

    The first keyword in :data:`SUBSYSTEM_KEYWORDS` order that appears as a word
    prefix wins (so ``unload`` also catches ``unloading``), which makes the
    result independent of where in the sentence the keyword sits.
    """
    lowered = norm_ws(text).lower()
    for keyword, subsystem in SUBSYSTEM_KEYWORDS.items():
        if re.search(rf"\b{re.escape(keyword)}", lowered):
            return subsystem
    return DEFAULT_SUBSYSTEM


def is_benign(text: str) -> bool:
    """True when the wording marks the cause as "not a fault"."""
    lowered = norm_ws(text).lower()
    return any(word in lowered for word in BENIGN_WORDS)


LIKELIHOODS: tuple[str, ...] = ("common", "occasional", "rare")
"""The ranking a cause cell may print after the cause name (``catalog-entry.likelihood``)."""

_CAUSE_MARKER_RE = re.compile(
    rf"^(?P<name>[^.!?()]+?)\s*\((?P<likelihood>{'|'.join(LIKELIHOODS)})"
    r"(?P<benign>,\s*benign)?\)\s*(?P<rest>.*)$",
    re.DOTALL,
)
"""``Name (common, benign) summary…``: the name ends at the first marker, before any sentence."""


@dataclass(frozen=True, slots=True)
class CauseMarker:
    """What the head of a cause cell says about the cause.

    The committed CAU-7 manual opens each cause cell with the cause name and its
    ranking in parentheses — ``Air demand above the rated delivery (common,
    benign)`` — and then prints the summary. ``rest`` is everything after the
    parenthesis.
    """

    name: str
    likelihood: str
    benign: bool
    rest: str


def parse_cause_marker(text: str) -> CauseMarker | None:
    """Split a cause cell at its likelihood marker; ``None`` when it prints none.

    The name may not contain a sentence end, so a ranking word in parentheses
    later in the prose of a manual that prints no marker never cuts a sentence
    in half.
    """
    match = _CAUSE_MARKER_RE.match(norm_ws(text))
    if match is None:
        return None
    return CauseMarker(
        name=norm_ws(match.group("name")),
        likelihood=match.group("likelihood"),
        benign=match.group("benign") is not None,
        rest=norm_ws(match.group("rest")),
    )


GROUP_SYMPTOM_SEPARATOR = " — "
"""What separates a group row's condition line from the symptom it runs on with.

The spanning table of the realistic CAU-7 manual prints ``8.3 Line pressure
below setpoint low_line_pressure — The display shows…`` in one cell.
"""


def alarm_kind(text: str) -> str:
    """Map an alarm type cell onto the ``alarm_type`` enum."""
    lowered = norm_ws(text).lower()
    for phrase, kind in ALARM_KIND_WORDS:
        if phrase in lowered:
            return kind
    return DEFAULT_ALARM_KIND


_QUANTITY_RE = re.compile(r"([+-]?\d+(?:[.,]\d+)?)\s*(.*)$")
_PARENTHESISED_RE = re.compile(r"\([^)]*\)")
_DELAY_RE = re.compile(r"([+-]?\d+(?:[.,]\d+)?)\s*([a-z]+)")

DELAY_UNITS_S: Mapping[str, int] = {
    "s": 1,
    "sec": 1,
    "secs": 1,
    "second": 1,
    "seconds": 1,
    "min": 60,
    "mins": 60,
    "minute": 60,
    "minutes": 60,
    "h": 3600,
    "hr": 3600,
    "hrs": 3600,
    "hour": 3600,
    "hours": 3600,
}
"""Delay units the manual prints, in seconds."""


def parse_quantity(text: str) -> tuple[float, str] | None:
    """Parse ``"7.0 bar (102 psi)"`` into ``(7.0, "bar")``.

    The imperial value in parentheses is dropped: the manual prints SI first and
    the catalog stores the SI value. Returns ``None`` when the cell holds
    no number.
    """
    cleaned = norm_ws(_PARENTHESISED_RE.sub(" ", norm_ws(text)))
    match = _QUANTITY_RE.search(cleaned)
    if match is None:
        return None
    value = float(match.group(1).replace(",", "."))
    return value, norm_ws(match.group(2))


def parse_delay(text: str) -> int | None:
    """Parse ``"2 min"`` into ``120`` seconds; ``None`` when there is no delay."""
    match = _DELAY_RE.search(norm_ws(text).lower())
    if match is None:
        return None
    factor = DELAY_UNITS_S.get(match.group(2))
    if factor is None:
        return None
    return round(float(match.group(1).replace(",", ".")) * factor)


# ---------------------------------------------------------------------------
# Move sentences
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SignalMoveDraft:
    """One move sentence, read as a contracts ``signal_move``.

    ``signal_id`` is a signal tag, or a behaviour id when ``is_behaviour`` is
    set — the contracts require exactly one of ``signal``/``behaviour``, and the
    catalog builder picks the right key from this flag. ``note`` is the
    human-readable join of ``onset`` and ``phase``, onset first, which is what
    ``expected.json`` compares.
    """

    signal_id: str
    direction: str
    note: str | None = None
    is_behaviour: bool = False
    onset: str | None = None
    phase: str | None = None
    text: str = ""


@dataclass(frozen=True, slots=True)
class SignalsIndex:
    """Resolves the names a move sentence uses to the signal tags of the manual.

    Built from the document's ``SIGNALS`` table, so a BYO manual with other tags
    resolves against its own. A sentence names a signal by its spaced tag
    (``"Oil temperature"``) or by the panel label in parentheses (``"(T1)"``);
    both are indexed, and the leftmost, longest match in the sentence wins.
    """

    candidates: tuple[tuple[re.Pattern[str], str], ...] = ()

    @classmethod
    def empty(cls) -> SignalsIndex:
        """An index that resolves nothing but behaviours."""
        return cls()

    @classmethod
    def from_table(cls, table: Table) -> SignalsIndex:
        """Build the index from a ``SIGNALS`` table; empty when it has no tags."""
        _, column_map = classify_header(table.header)
        tag_column = column_map.get("tag")
        if tag_column is None:
            return cls.empty()
        label_column = column_map.get("label")
        candidates: list[tuple[re.Pattern[str], str]] = []
        for row in table.rows:
            tag, label = signal_tag(row.cells, tag_column, label_column)
            if not tag:
                continue
            phrases = {tag.lower(), tag.replace("_", " ").lower()}
            if label:
                candidates.append((re.compile(rf"\(\s*{re.escape(label.lower())}\s*\)"), tag))
            candidates.append((_alternation(phrases), tag))
        return cls(candidates=tuple(candidates))


def _cell(cells: Sequence[str], index: int | None) -> str:
    if index is None or index >= len(cells):
        return ""
    return cells[index]


def _find_target(lowered: str, signals_index: SignalsIndex) -> tuple[int, str, bool] | None:
    """Find the signal or behaviour the sentence is about.

    Returns ``(end_offset, id, is_behaviour)`` for the leftmost match, longest
    at that position, so ``"Line pressure (P2) falls…"`` resolves through the
    spaced tag rather than through the label that follows it.
    """
    best: tuple[int, int, str, bool] | None = None
    for pattern, signal_id, is_behaviour in (
        *((p, s, False) for p, s in signals_index.candidates),
        *((p, b, True) for p, b in _BEHAVIOUR_CANDIDATES),
    ):
        match = pattern.search(lowered)
        if match is None:
            continue
        key = (match.start(), -(match.end() - match.start()), signal_id, is_behaviour)
        if best is None or key < best:
            best = key
    if best is None:
        return None
    start, negative_length, signal_id, is_behaviour = best
    return start - negative_length, signal_id, is_behaviour


def parse_move_sentence(sentence: str, signals_index: SignalsIndex) -> SignalMoveDraft | None:
    """Read one move sentence into a :class:`SignalMoveDraft`.

    ``"Oil temperature (T1) rises gradually in every state."`` becomes
    ``oil_temperature`` / ``rises`` with note ``"gradual, any"``. The direction,
    onset and phase are searched *after* the signal name, so a tag that contains
    a direction word cannot be mistaken for the movement. Returns ``None`` when
    the sentence names no known signal or no known direction, which leaves it to
    the caller to keep the sentence as free text.
    """
    text = norm_ws(sentence)
    if not text:
        return None
    lowered = text.lower()
    target = _find_target(lowered, signals_index)
    if target is None:
        return None
    end, signal_id, is_behaviour = target
    remainder = lowered[end:]
    # The manual puts the onset between the copula and the state ("is persistently
    # on"), which would hide the phrase an ambiguous "on"/"off" needs.
    direction_match = _DIRECTION_SCANNER.search(norm_ws(_ONSET_SCANNER.sub(" ", remainder)))
    if direction_match is None:
        return None
    direction = DIRECTION_MAP[direction_match.group(0)]
    onset_match = _ONSET_SCANNER.search(remainder)
    phase_match = _PHASE_SCANNER.search(remainder)
    onset = ONSET_MAP[onset_match.group(0)] if onset_match else None
    phase = PHASE_MAP[phase_match.group(0)] if phase_match else None
    note = ", ".join(part for part in (onset, phase) if part) or None
    return SignalMoveDraft(
        signal_id=signal_id,
        direction=direction,
        note=note,
        is_behaviour=is_behaviour,
        onset=onset,
        phase=phase,
        text=text,
    )

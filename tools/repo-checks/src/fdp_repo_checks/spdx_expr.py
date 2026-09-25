# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""SPDX licence expressions: parse one, then judge it against a policy.

The ground rules forbid copyleft in anything that ships, and a registry rarely
answers with a bare identifier: ``pnpm`` reports ``(MIT OR CC0-1.0)``, Python
wheels report ``Apache-2.0 OR BSD-3-Clause`` in ``License-Expression`` and
``BSD 2-Clause License`` in the legacy ``License`` field, and go-licenses
reports ``EPL-2.0`` for a project that is dual-licensed under the Eclipse
Distribution License. Judging those by string equality would be wrong in both
directions, so this module parses the real grammar.

Grammar, with the precedence the SPDX specification gives (``WITH`` binds
tightest, then ``AND``, then ``OR``)::

    expression := or
    or         := and ( "OR" and )*
    and        := with ( "AND" with )*
    with       := primary ( "WITH" identifier )?
    primary    := identifier | "(" or ")"

A verdict is one of four values ordered by how bad it is
(:data:`Verdict.severity`): ``ok`` < ``flagged`` < ``unknown`` < ``fail``.
``OR`` takes the *best* operand (a dual licence may be taken under either),
``AND`` the *worst* (both obligations apply). ``A WITH exception`` is judged
as ``A``: every SPDX exception loosens the base licence, never tightens it.

``unknown`` sits below ``fail`` deliberately. ``GPL-3.0-only OR Something-New``
is not provably a violation, only unaudited, and the report should say so;
both still stop the build in runtime scope, so nothing ships unaudited.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from enum import StrEnum

__all__ = [
    "ALIASES",
    "DEFAULT_DENY_PREFIXES",
    "License",
    "Operation",
    "SpdxSyntaxError",
    "Verdict",
    "allowed",
    "evaluate",
    "identifiers",
    "normalise_identifier",
    "parse",
    "render",
]


class SpdxSyntaxError(ValueError):
    """The text is not an SPDX licence expression."""


class Verdict(StrEnum):
    """What the policy says about an expression."""

    OK = "ok"
    FLAGGED = "flagged"
    UNKNOWN = "unknown"
    FAIL = "fail"

    @property
    def severity(self) -> int:
        """How bad the verdict is; higher is worse."""
        return _SEVERITY[self]


_SEVERITY = {Verdict.OK: 0, Verdict.FLAGGED: 1, Verdict.UNKNOWN: 2, Verdict.FAIL: 3}


DEFAULT_DENY_PREFIXES: tuple[str, ...] = (
    "GPL-",
    "AGPL-",
    "SSPL-",
    "EUPL-",
    "CC-BY-SA-",
    "CC-BY-NC-",
)
"""Identifier prefixes that fail outright in runtime scope.

Prefix matching is exact enough to be safe: ``LGPL-2.1-only`` does not start
with ``GPL-`` and ``CC-BY-4.0`` does not start with ``CC-BY-SA-``, so the
lesser copyleft licences stay in the flagged set where the policy puts them.
"""

ALIASES: dict[str, str] = {
    # Apache
    "apache 2.0": "Apache-2.0",
    "apache-2": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "asl 2.0": "Apache-2.0",
    # BSD. "BSD License" is the ambiguous PyPI classifier tail; both two- and
    # three-clause BSD are on the runtime allow-list, so resolving it to the
    # three-clause form cannot change a verdict, only the reported string.
    "bsd license": "BSD-3-Clause",
    "bsd 2-clause": "BSD-2-Clause",
    "bsd 2-clause license": "BSD-2-Clause",
    "bsd-2-clause license": "BSD-2-Clause",
    "simplified bsd": "BSD-2-Clause",
    "bsd 3-clause": "BSD-3-Clause",
    "bsd 3-clause license": "BSD-3-Clause",
    "bsd-3-clause license": "BSD-3-Clause",
    "new bsd license": "BSD-3-Clause",
    "modified bsd license": "BSD-3-Clause",
    # The Eclipse Distribution License is the BSD-3-Clause text verbatim; the
    # repository's election of EDL-1.0 for Paho rests on it.
    "edl-1.0": "BSD-3-Clause",
    "eclipse distribution license 1.0": "BSD-3-Clause",
    "eclipse distribution license - v 1.0": "BSD-3-Clause",
    # MIT
    "expat": "MIT",
    "mit license": "MIT",
    "mit/x11": "MIT",
    "the mit license": "MIT",
    # Others seen in registry metadata
    "isc license": "ISC",
    "iscl": "ISC",
    "isc license (iscl)": "ISC",
    "mozilla public license 2.0": "MPL-2.0",
    "mpl 2.0": "MPL-2.0",
    "python software foundation license": "PSF-2.0",
    "psf": "PSF-2.0",
    "zlib/libpng": "Zlib",
    "zlib/libpng license": "Zlib",
}
"""Registry spellings mapped to the SPDX identifier they mean.

Keys are case-folded and whitespace-collapsed. A key that holds spaces can
only match a whole expression, because the tokeniser splits on whitespace.
"""

_DEPRECATED_BASES = {
    "gpl-1.0": "GPL-1.0",
    "gpl-2.0": "GPL-2.0",
    "gpl-3.0": "GPL-3.0",
    "lgpl-2.0": "LGPL-2.0",
    "lgpl-2.1": "LGPL-2.1",
    "lgpl-3.0": "LGPL-3.0",
    "agpl-1.0": "AGPL-1.0",
    "agpl-3.0": "AGPL-3.0",
}
"""Identifiers SPDX deprecated in favour of an explicit ``-only``/``-or-later``."""

_UNKNOWN_IDENTIFIERS = frozenset(
    {
        "none",
        "noassertion",
        "unknown",
        # npm spells "proprietary, no licence granted" this way. It is not the
        # Unlicense public-domain dedication and must never resolve to it.
        "unlicensed",
        "see license in license",
    }
)
"""Placeholders a tool prints when it could not determine a licence."""

_KEYWORDS = frozenset({"and", "or", "with"})
_TOKEN = re.compile(r"\(|\)|[^\s()]+")


@dataclass(frozen=True)
class License:
    """A single identifier, optionally with an SPDX exception."""

    identifier: str
    exception: str | None = None


@dataclass(frozen=True)
class Operation:
    """``AND`` or ``OR`` over two or more operands."""

    operator: str
    operands: tuple[Node, ...]


Node = License | Operation


def normalise_identifier(token: str) -> str:
    """Return the SPDX identifier ``token`` means.

    Resolves the alias table, the deprecated bare identifiers and the legacy
    ``+`` suffix; an identifier this module does not know is returned with its
    spelling intact, because the comparison against the policy is
    case-insensitive anyway.
    """
    text = " ".join(token.split())
    suffix = ""
    if text.endswith("+") and len(text) > 1:
        text = text[:-1]
        suffix = "-or-later"
    key = text.casefold()
    if key in _DEPRECATED_BASES:
        return f"{_DEPRECATED_BASES[key]}{suffix or '-only'}"
    canonical = ALIASES.get(key, text)
    return f"{canonical}{suffix}" if suffix else canonical


class _Parser:
    """Recursive-descent parser over the tokens of one expression."""

    def __init__(self, tokens: Sequence[str]) -> None:
        self._tokens = tokens
        self._index = 0

    def parse(self) -> Node:
        node = self._parse_or()
        remaining = self._peek()
        if remaining is not None:
            raise SpdxSyntaxError(f"unexpected {remaining!r} after a complete expression")
        return node

    def _peek(self) -> str | None:
        return self._tokens[self._index] if self._index < len(self._tokens) else None

    def _next(self) -> str:
        token = self._peek()
        if token is None:
            raise SpdxSyntaxError("the expression ends too early")
        self._index += 1
        return token

    def _accept(self, keyword: str) -> bool:
        token = self._peek()
        if token is not None and token.casefold() == keyword:
            self._index += 1
            return True
        return False

    def _parse_or(self) -> Node:
        return self._parse_binary("or", self._parse_and)

    def _parse_and(self) -> Node:
        return self._parse_binary("and", self._parse_with)

    def _parse_binary(self, keyword: str, operand: Callable[[], Node]) -> Node:
        operands = [operand()]
        while self._accept(keyword):
            operands.append(operand())
        if len(operands) == 1:
            return operands[0]
        return Operation(keyword.upper(), tuple(operands))

    def _parse_with(self) -> Node:
        node = self._parse_primary()
        if not self._accept("with"):
            return node
        if not isinstance(node, License):
            raise SpdxSyntaxError("WITH must follow a single licence identifier")
        return License(node.identifier, self._parse_word("an exception name"))

    def _parse_primary(self) -> Node:
        if self._peek() == "(":
            self._next()
            node = self._parse_or()
            if self._next() != ")":
                raise SpdxSyntaxError("a parenthesis is not closed")
            return node
        return License(normalise_identifier(self._parse_word("a licence identifier")))

    def _parse_word(self, expected: str) -> str:
        token = self._next()
        if token in {"(", ")"} or token.casefold() in _KEYWORDS:
            raise SpdxSyntaxError(f"expected {expected}, found {token!r}")
        return token


def parse(expression: str) -> Node:
    """Parse an SPDX licence expression.

    A whole string that the alias table knows is accepted even when it is not
    valid SPDX (``"BSD 2-Clause License"``), because that is how legacy
    ``License`` metadata is spelled.

    Raises:
        SpdxSyntaxError: the text is empty or not an expression.
    """
    text = " ".join(expression.split())
    if not text:
        raise SpdxSyntaxError("empty licence expression")
    alias = ALIASES.get(text.casefold())
    if alias is not None:
        return License(alias)
    return _Parser(_TOKEN.findall(text)).parse()


def render(node: Node) -> str:
    """Render a parsed expression back to a normalised string."""
    if isinstance(node, License):
        return f"{node.identifier} WITH {node.exception}" if node.exception else node.identifier
    joined = f" {node.operator} ".join(_render_operand(operand, node) for operand in node.operands)
    return joined


def _render_operand(operand: Node, parent: Operation) -> str:
    text = render(operand)
    needs_parens = isinstance(operand, Operation) and operand.operator != parent.operator
    return f"({text})" if needs_parens else text


def identifiers(node: Node) -> tuple[str, ...]:
    """Every licence identifier the expression names, in reading order."""
    if isinstance(node, License):
        return (node.identifier,)
    return tuple(name for operand in node.operands for name in identifiers(operand))


def _verdict_for(
    identifier: str,
    allow: frozenset[str],
    flagged: frozenset[str],
    deny: tuple[str, ...],
) -> Verdict:
    key = identifier.casefold()
    if key in _UNKNOWN_IDENTIFIERS or key.startswith("licenseref-"):
        return Verdict.UNKNOWN
    if key in allow:
        return Verdict.OK
    if key in flagged:
        return Verdict.FLAGGED
    if any(key.startswith(prefix) for prefix in deny):
        return Verdict.FAIL
    return Verdict.UNKNOWN


def evaluate(
    node: Node,
    *,
    allow: frozenset[str],
    flagged: frozenset[str],
    deny: tuple[str, ...],
) -> Verdict:
    """Judge a parsed expression; the sets and prefixes must be case-folded."""
    if isinstance(node, License):
        return _verdict_for(node.identifier, allow, flagged, deny)
    verdicts = [
        evaluate(operand, allow=allow, flagged=flagged, deny=deny) for operand in node.operands
    ]
    choose = min if node.operator == "OR" else max
    return choose(verdicts, key=lambda verdict: verdict.severity)


def _folded(values: Iterable[str]) -> frozenset[str]:
    return frozenset(value.casefold() for value in values)


def allowed(
    expression: str | None,
    allow_set: Iterable[str],
    flagged_set: Iterable[str],
    deny_prefixes: Iterable[str] = DEFAULT_DENY_PREFIXES,
) -> Verdict:
    """Judge ``expression`` against the policy sets.

    Text that is not an expression — blank metadata, a comma-separated list of
    licence names, a placeholder such as ``Unknown`` — is ``unknown`` rather
    than an error: an entry the policy cannot read is exactly what the
    ``[overrides]`` table of ``licenses-policy.toml`` exists for.
    """
    if expression is None:
        return Verdict.UNKNOWN
    try:
        node = parse(expression)
    except SpdxSyntaxError:
        return Verdict.UNKNOWN
    return evaluate(
        node,
        allow=_folded(allow_set),
        flagged=_folded(flagged_set),
        deny=tuple(prefix.casefold() for prefix in deny_prefixes),
    )

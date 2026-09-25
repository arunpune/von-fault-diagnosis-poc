# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The Jinja layer of the manual build, an adapter over the manual's contract.

``manual/tools/context.py`` is the single authoring contract: the namespace,
the filters, the cross-reference labels, the outline numbering and the
fact-placement predicates are the manual's, and the PDF build neither
re-implements nor forks them. :func:`manual_context` imports that file out of
the checkout the way :mod:`fdp_manual_build.manual_tools` imports the manual's
loader, so the preview and the PDF derive their numbers from one
implementation.

On top of it this module adds the three things the PDF needs and the preview
does not:

* the real :func:`figure` — the SVG is inlined and validated against the
  figure rules instead of being linked, so the text inside a drawing is
  extractable and scannable;
* the real ``tables.*`` macros — :data:`TABLE_PARTIALS` maps each of the
  manual's macro names onto the partial of ``manual/templates`` that lays the table out
  for print, so a partial's ``{{ tables.alarms() }}`` yields the manual's table
  and not the preview stub;
* a ``finalize`` hook that refuses a bare ``int``, ``float`` or ``{value, unit}``
  mapping, so a partial cannot state a number the spec does not hold;
* a :class:`FactTracker` that records which ``prose_only`` anchors a partial
  really stated, the run-time half of content check C5.

Two environments come out of it. The *content* environment renders the
manual's Markdown partials and YAML text fields and carries the manual's
namespace; the *page* environment renders the PDF build's own HTML templates
under ``manual/templates`` and carries the typed model. Only the content
environment gets the bare-number hook: a page template legitimately prints a
chapter number.
"""

from __future__ import annotations

import dataclasses
import importlib.util
import re
import sys
from collections.abc import Callable, Mapping, MutableMapping, Sequence
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from types import MappingProxyType, ModuleType
from typing import TYPE_CHECKING, Any, Final, Protocol, cast
from xml.etree import ElementTree

import jinja2

from fdp_manual_build import markdown, units
from fdp_manual_build.errors import BuildError
from fdp_manual_build.manual_tools import spec_loader
from fdp_manual_build.model import Manual, Quantity

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.config import BuildConfig, VariantConfig
    from fdp_manual_build.manual_tools import Spec
    from fdp_manual_build.numbering import ChapterSource, SectionMap

__all__ = [
    "CONTEXT_RELATIVE",
    "FORBIDDEN_SVG_TAGS",
    "TABLE_HELPERS",
    "TABLE_PARTIALS",
    "TEMPLATES_RELATIVE",
    "BareNumberError",
    "Binding",
    "ContextModule",
    "FactTracker",
    "ManualEnvironment",
    "Outline",
    "Sources",
    "Templating",
    "inline_svg",
    "make_env",
    "make_templating",
    "manual_context",
    "number_headings",
    "page_env",
    "resolve_manual",
]

#: The manual's authoring contract, relative to the repository root.
CONTEXT_RELATIVE: Final = Path("manual") / "tools" / "context.py"
#: The PDF build's HTML templates and stylesheets, relative to the repository root.
TEMPLATES_RELATIVE: Final = Path("manual") / "templates"

#: The manual's ``tables.<name>()`` macro → the partial of the PDF build that
#: implements it for real. The partial exports one Jinja macro per entry, named
#: exactly like the key. ``revision_history`` has no entry: chapter 10 is prose
#: plus the manual's own stub, and the templating tests hold it to exactly one
#: table.
TABLE_PARTIALS: Final[Mapping[str, str]] = MappingProxyType(
    {
        "alarms": "partials/table-alarms.html.j2",
        "settings": "partials/table-parameters.html.j2",
        "maintenance_schedule": "partials/table-maintenance.html.j2",
        "maintenance_procedures": "partials/table-maintenance.html.j2",
        "troubleshooting": "partials/table-troubleshooting.html.j2",
        "signals": "partials/table-signals.html.j2",
        "normal_bands": "partials/table-signals.html.j2",
        "technical_data": "partials/table-technical-data.html.j2",
        "parts": "partials/table-technical-data.html.j2",
    }
)

#: The helpers of the manual's namespace a generated table reaches through ``man.*``.
#: They resolve what the typed model stores
#: unresolved — a threshold that points at a setting, a delay, the sentences of
#: ``signal_moves`` — and they apply the variant's imperial conversion, so a
#: table and a sentence of prose never print one number two ways.
TABLE_HELPERS: Final[tuple[str, ...]] = (
    "num",
    "q",
    "val",
    "thr",
    "delay",
    "sig",
    "move_text",
    "unit_label",
)

_CONTEXT_MODULE = "fdp_manual_build._manual_tools_context"
#: ``context.py`` imports the manual's loader as the top-level module ``load``.
_LOADER_MODULE = "load"

#: SVG elements the figure rules forbid: they would pull in raster art or run code.
FORBIDDEN_SVG_TAGS: Final[frozenset[str]] = frozenset({"image", "script", "foreignObject"})
_SVG_NAMESPACE: Final = "{http://www.w3.org/2000/svg}"
_XLINK_HREF: Final = "{http://www.w3.org/1999/xlink}href"

#: One anchored heading line. The trailing class is ``[ \t]`` rather than
#: ``\s`` so that the newline stays outside the match and the line is replaced
#: in place.
_HEADING_LINE: Final = re.compile(
    r"^(#{2,3})[ \t]+(.+?)[ \t]+\{#([a-z0-9:_-]+)\}[ \t]*$", re.MULTILINE
)
_BLANK_LINE: Final = re.compile(r"\n[ \t]*\n+")
_XML_DECLARATION: Final = re.compile(r"^\s*<\?xml[^>]*\?>\s*")
_DOCTYPE: Final = re.compile(r"<!DOCTYPE", re.IGNORECASE)


class BareNumberError(BuildError):
    """A template printed a raw number instead of going through the manual's helpers."""


class Outline(Protocol):
    """The subset of ``context.Outline`` the build uses."""

    headings: Sequence[Any]
    by_anchor: Mapping[str, Any]

    def has(self, anchor: str) -> bool: ...

    def reference(self, anchor: str) -> Any: ...

    def label(self, anchor: str) -> str: ...

    def number_of(self, anchor: str) -> str: ...

    def figure_number(self, chapter: int, index: int) -> str: ...


class RenderState(Protocol):
    """The per-partial state ``context.make_env`` hangs on its environment."""

    chapter: int
    figures: int
    footnotes: bool


class ManualEnvironment(Protocol):
    """The Jinja environment ``context.make_env`` returns."""

    state: RenderState
    globals: MutableMapping[str, Any]
    filters: MutableMapping[str, Any]
    finalize: Callable[[Any], Any] | None

    def from_string(self, source: str) -> jinja2.Template: ...


class ContextModule(Protocol):
    """The public surface of ``manual/tools/context.py`` the build relies on."""

    ContextError: type[Exception]
    IMPERIAL: Mapping[str, tuple[str, Callable[[float], float]]]

    def build_outline(self, spec: Spec, partials: Mapping[int, str]) -> Outline: ...

    def make_env(self, spec: Spec, variant: str, outline: Outline) -> ManualEnvironment: ...

    def render_partial(self, environment: ManualEnvironment, chapter: int, text: str) -> str: ...

    def render_text(self, environment: ManualEnvironment, text: str) -> str: ...

    def md_to_html(self, text: str, footnotes: bool) -> str: ...

    def unit_label(self, unit: str) -> str: ...

    def variant_knobs(self, build: Mapping[str, Any], name: str) -> dict[str, Any]: ...


# --- importing the manual's contract ---------------------------------------------


@cache
def manual_context(repo_root: Path) -> ContextModule:
    """Import ``manual/tools/context.py`` out of ``repo_root``.

    Raises:
        BuildError: when the checkout holds no ``manual/tools/context.py``.
    """
    path = (repo_root / CONTEXT_RELATIVE).resolve()
    if not path.is_file():
        raise BuildError(f"{repo_root}: no {CONTEXT_RELATIVE.as_posix()} in this checkout")
    return _import_context(path, cast("ModuleType", spec_loader(repo_root)))


def _import_context(path: Path, loader: ModuleType) -> ContextModule:
    """Execute ``context.py`` with the manual's loader bound to the name it imports.

    ``context.py`` reaches its sibling with ``from load import …``, which a
    plain path import cannot resolve. Binding ``sys.modules["load"]`` for the
    duration of the import keeps ``manual/tools`` off ``sys.path`` and makes
    the loader object identical to the one :mod:`fdp_manual_build.load` used,
    so both see one ``Spec`` class.
    """
    cached = sys.modules.get(_CONTEXT_MODULE)
    if cached is not None:
        return cast("ContextModule", cached)
    spec = importlib.util.spec_from_file_location(_CONTEXT_MODULE, path)
    if spec is None or spec.loader is None:  # pragma: no cover - a readable .py file
        raise BuildError(f"{path}: cannot be imported as a Python module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_CONTEXT_MODULE] = module
    previous = sys.modules.get(_LOADER_MODULE)
    sys.modules[_LOADER_MODULE] = loader
    try:
        spec.loader.exec_module(module)
    except Exception:
        del sys.modules[_CONTEXT_MODULE]
        raise
    finally:
        if previous is None:
            del sys.modules[_LOADER_MODULE]
        else:
            sys.modules[_LOADER_MODULE] = previous
    return cast("ContextModule", module)


# --- fact placement --------------------------------------------------------


@dataclass
class FactTracker:
    """Records which fact anchors a partial really stated (content check C5).

    ``fact_in_prose(anchor)`` is the manual's predicate; wrapping it here turns the
    source-level rule "every ``prose_only`` anchor sits inside a
    ``fact_in_prose`` block" into a build-time guarantee, including for the
    branches a variant actually took.
    """

    in_prose: bool = False
    stated: set[str] = field(default_factory=set)

    def track(self, predicate: Callable[[str], bool]) -> Callable[[str], bool]:
        """Wrap the manual's ``fact_in_prose`` so every taken branch is recorded."""

        def fact_in_prose(anchor: str) -> bool:
            allowed = predicate(anchor)
            if allowed and self.in_prose:
                self.stated.add(anchor)
            return allowed

        return fact_in_prose

    def missing(self, variant: VariantConfig) -> tuple[str, ...]:
        """``prose_only`` anchors of ``variant`` that no partial ever stated."""
        if variant.fact_placement != "mixed":
            return ()
        return tuple(anchor for anchor in variant.prose_only if anchor not in self.stated)


# --- figures ---------------------------------------------------------------


def inline_svg(path: Path) -> str:
    """Read one figure and return its markup, ready to inline.

    Raises:
        BuildError: when the file is missing, is not well-formed XML, holds a
            forbidden element or points at anything outside the document.
    """
    if not path.is_file():
        raise BuildError(f"{path}: no such figure")
    text = path.read_text(encoding="utf-8")
    if _DOCTYPE.search(text):
        # The figure rules ask for self-contained SVG 1.1; refusing the prolog
        # outright also keeps entity expansion and external DTDs away from the
        # parser below.
        raise BuildError(f"{path}: a figure must carry no DOCTYPE")
    try:
        # A committed, blocklist-scanned repository source with no DOCTYPE.
        root = ElementTree.fromstring(text)  # noqa: S314
    except ElementTree.ParseError as error:
        raise BuildError(f"{path}: not well-formed XML ({error})") from error
    problems = sorted(_svg_problems(root))
    if problems:
        raise BuildError(f"{path}: {'; '.join(problems)}")
    return _BLANK_LINE.sub("\n", _XML_DECLARATION.sub("", text)).strip()


def _svg_problems(root: ElementTree.Element) -> set[str]:
    problems: set[str] = set()
    for element in root.iter():
        tag = element.tag.removeprefix(_SVG_NAMESPACE)
        if tag in FORBIDDEN_SVG_TAGS:
            problems.add(f"<{tag}> is not allowed in a figure")
        for name in ("href", _XLINK_HREF):
            target = element.get(name)
            if target is not None and not target.startswith("#"):
                problems.add(f"external reference {target!r}")
    return problems


# --- environments ----------------------------------------------------------


@dataclass(frozen=True)
class Sources:
    """The checkout and the manual-side inputs one variant is rendered from."""

    repo_root: Path
    spec: Spec
    chapters: tuple[ChapterSource, ...]

    @property
    def partials(self) -> dict[int, str]:
        """Chapter number → the raw Markdown ``build_outline`` scans."""
        return {chapter.number: chapter.text for chapter in self.chapters}


@dataclass(frozen=True)
class Binding:
    """The objects the content environment is wired to, built once per variant."""

    repo_root: Path
    spec: Spec
    outline: Outline
    pages: jinja2.Environment
    facts: FactTracker


def make_env(
    cfg: BuildConfig,
    variant: VariantConfig,
    manual: Manual,
    sections: SectionMap,
    binding: Binding,
) -> ManualEnvironment:
    """Build the content environment: the manual's namespace plus the PDF build's overrides.

    ``manual`` and ``sections`` join the namespace so a generated table can
    reach the typed model; everything else in it is the manual's
    and must stay that way.
    """
    context = manual_context(binding.repo_root)
    env = context.make_env(binding.spec, variant.name, binding.outline)
    env.finalize = _finalize
    figure = _figure_renderer(env, binding, cfg.manual_root / "figures")
    env.globals["figure"] = figure
    env.filters["figure"] = figure
    tracked = binding.facts.track(cast("Callable[[str], bool]", env.globals["fact_in_prose"]))
    env.globals["fact_in_prose"] = tracked
    env.filters["fact_in_prose"] = tracked
    env.filters["fmt"] = units.format_number
    env.filters["md"] = markdown.render_inline
    env.globals["sections"] = sections
    env.globals["manual"] = manual
    env.globals["tables"] = _TableMacros(binding.pages, env, env.globals["tables"])
    return env


class _TableMacros:
    """The manual's ``tables`` namespace, backed by the PDF build's own templates.

    ``context.Tables`` renders the preview stubs; the manual's real tables are
    the Jinja macros under ``manual/templates/partials``. Looking the macro up
    lazily keeps the two sides independent: a name :data:`TABLE_PARTIALS` does
    not map falls through to the manual's stub, so a macro the PDF build has no template
    for still prints the table the preview shows.

    The rendered markup is collapsed onto contiguous lines because it is
    inserted into the Markdown partial before the parser runs, and CommonMark
    ends a raw HTML block at the first blank line.
    """

    def __init__(
        self,
        pages: jinja2.Environment,
        env: ManualEnvironment,
        fallback: object,
    ) -> None:
        self._pages = pages
        self._helpers = {name: env.globals[name] for name in TABLE_HELPERS}
        self._fallback = fallback

    def __getattr__(self, name: str) -> Callable[[], str]:
        partial = TABLE_PARTIALS.get(name)
        if partial is None:
            return cast("Callable[[], str]", getattr(self._fallback, name))
        return lambda: self._render(partial, name)

    def _render(self, partial: str, macro: str) -> str:
        module = self._pages.get_template(partial).make_module(vars={"man": self._helpers})
        rendered = cast("Callable[[], str]", getattr(module, macro))()
        return _BLANK_LINE.sub("\n", rendered).strip()


def page_env(cfg: BuildConfig, variant: VariantConfig, repo_root: Path) -> jinja2.Environment:
    """Build the environment that renders the PDF build's own HTML templates."""
    directory = repo_root / TEMPLATES_RELATIVE
    if not directory.is_dir():
        raise BuildError(f"{directory}: no {TEMPLATES_RELATIVE.as_posix()} in this checkout")
    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(directory, encoding="utf-8"),
        undefined=jinja2.StrictUndefined,
        autoescape=False,  # noqa: S701 - every value is escaped explicitly; templates emit HTML
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
    )
    env.filters["fmt"] = units.format_number
    env.filters["md"] = markdown.render_inline
    env.globals["qty"] = units.fmt_qty
    env.globals["qty_range"] = units.qty_range
    env.globals["units_mode"] = variant.units
    env.globals["admonition_labels"] = markdown.ADMONITIONS
    env.globals["document"] = cfg.document
    env.globals["variant"] = variant
    env.globals["source_date_iso"] = cfg.source_date_iso
    return env


def _finalize(value: Any) -> Any:
    """Refuse a bare number so prose cannot state a fact the spec does not hold."""
    if isinstance(value, bool):
        return value
    if isinstance(value, Quantity) or (isinstance(value, Mapping) and "value" in value):
        raise BareNumberError(
            f"a template printed the quantity {value!r} directly; use q() so the unit and the "
            "variant's imperial conversion are applied"
        )
    if isinstance(value, int | float):
        raise BareNumberError(
            f"a template printed the bare number {value!r}; numbers reach the manual through "
            "num(), q(), val(), thr() or delay() only"
        )
    return value


def _figure_renderer(
    env: ManualEnvironment,
    binding: Binding,
    figures_dir: Path,
) -> Callable[[str, str], str]:
    """Return the ``figure(id, caption)`` global that inlines the SVG.

    The counter is the one ``context.make_env`` keeps, so the numbers match the
    preview's and stay ``N.k`` per chapter.
    """
    template = binding.pages.get_template("partials/figure.html.j2")

    def figure(figure_id: str, caption: str) -> str:
        state = env.state
        state.figures += 1
        number = binding.outline.figure_number(state.chapter, state.figures)
        svg = inline_svg(figures_dir / f"{figure_id}.svg")
        rendered = template.render(figure_id=figure_id, number=number, caption=caption, svg=svg)
        return _BLANK_LINE.sub("\n", rendered).strip()

    return figure


# --- rendering -------------------------------------------------------------


def number_headings(text: str, outline: Outline) -> str:
    """Prefix every anchored heading with the number the outline gave it.

    The number is printed in a ``<span class="num">`` rather than generated by
    a CSS counter, so it survives text extraction and the outline stays the one
    source of section numbers.
    """

    def replace(match: re.Match[str]) -> str:
        anchor = match.group(3)
        if not outline.has(anchor):
            return match.group(0)
        number = outline.number_of(anchor)
        return f'{match.group(1)} <span class="num">{number}</span> {match.group(2)} {{#{anchor}}}'

    return _HEADING_LINE.sub(replace, text)


@dataclass(frozen=True)
class Templating:
    """Everything one variant is rendered with, bound to one checkout."""

    cfg: BuildConfig
    variant: VariantConfig
    context: ContextModule
    binding: Binding
    sections: SectionMap
    env: ManualEnvironment

    @property
    def outline(self) -> Outline:
        """The section, figure and cross-reference numbers of this build."""
        return self.binding.outline

    @property
    def pages(self) -> jinja2.Environment:
        """The environment that renders the PDF build's own HTML templates."""
        return self.binding.pages

    @property
    def facts(self) -> FactTracker:
        """The fact-placement recorder behind ``fact_in_prose``."""
        return self.binding.facts

    @property
    def footnote_mode(self) -> markdown.FootnoteMode:
        """``float`` where the stylesheet floats footnotes, ``inline`` elsewhere."""
        return "float" if self.variant.footnotes else "inline"

    def chapter_body(self, chapter: ChapterSource) -> str:
        """Render one Markdown partial to the HTML fragment of its chapter."""
        self.facts.in_prose = True
        try:
            rendered = self.context.render_partial(self.env, chapter.number, chapter.text)
        except (BuildError, jinja2.TemplateError, self.context.ContextError) as error:
            raise BuildError(f"{chapter.relative}: {error}") from error
        finally:
            self.facts.in_prose = False
        return markdown.render_markdown(number_headings(rendered, self.outline), self.footnote_mode)

    def resolve(self, manual: Manual) -> Manual:
        """Fill every ``*_html`` field of the model for this variant."""
        resolved = resolve_manual(manual, self.env, mode=self.footnote_mode, context=self.context)
        self.env.globals["manual"] = resolved
        self.pages.globals["manual"] = resolved
        self.pages.globals["machine"] = resolved.machine
        return resolved

    def check_fact_placement(self) -> None:
        """Fail when a ``prose_only`` anchor never reached the prose (check C5).

        Raises:
            BuildError: naming every anchor the variant promised to the prose.
        """
        missing = self.facts.missing(self.variant)
        if not missing:
            return
        names = ", ".join(missing)
        raise BuildError(
            f"{self.cfg.manual_root}: variant {self.variant.name!r} lists {names} as prose-only, "
            "but no partial stated them inside a fact_in_prose block"
        )


def make_templating(
    cfg: BuildConfig,
    variant: VariantConfig,
    manual: Manual,
    sections: SectionMap,
    sources: Sources,
) -> Templating:
    """Bind the manual's contract, the PDF build's templates and the model for one variant."""
    context = manual_context(sources.repo_root)
    binding = Binding(
        repo_root=sources.repo_root,
        spec=sources.spec,
        outline=context.build_outline(sources.spec, sources.partials),
        pages=page_env(cfg, variant, sources.repo_root),
        facts=FactTracker(),
    )
    env = make_env(cfg, variant, manual, sections, binding)
    binding.pages.globals["sections"] = sections
    binding.pages.globals["outline"] = binding.outline
    # The generated tables read the model, so it is in the page namespace from
    # the start; `Templating.resolve` replaces it with the resolved copy.
    binding.pages.globals["manual"] = manual
    binding.pages.globals["machine"] = manual.machine
    return Templating(
        cfg=cfg,
        variant=variant,
        context=context,
        binding=binding,
        sections=sections,
        env=env,
    )


# --- model resolution ------------------------------------------------------


def resolve_manual(
    manual: Manual,
    env: ManualEnvironment,
    *,
    mode: markdown.FootnoteMode = "inline",
    context: ContextModule | None = None,
) -> Manual:
    """Return a copy of ``manual`` with every text field resolved.

    Each ``<name>_md`` field is rendered as a Jinja template in the manual's namespace
    — so a YAML sentence may use ``num()``, ``sig()`` or ``ref()`` exactly like
    a partial — and the result also fills its ``<name>_html`` sibling as an
    inline HTML fragment fit for a table cell. A field without an ``_html``
    sibling is left untouched.
    """
    return _Resolver(context or _imported_context(), env, mode).node(manual)


def _imported_context() -> ContextModule:
    """The manual's contract as :func:`manual_context` imported it earlier."""
    module = sys.modules.get(_CONTEXT_MODULE)
    if module is None:
        raise BuildError("manual/tools/context.py has not been imported; call manual_context first")
    return cast("ContextModule", module)


class _Resolver:
    """Walks the frozen model, rendering ``*_md`` and filling ``*_html``."""

    def __init__(self, context: ContextModule, env: ManualEnvironment, mode: str) -> None:
        self._context = context
        self._env = env
        self._mode = cast("markdown.FootnoteMode", mode)

    def node[T](self, value: T) -> T:
        """Return ``value`` with every nested dataclass resolved."""
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return cast("T", self._dataclass(value))
        if isinstance(value, tuple):
            return cast("T", tuple(self.node(item) for item in value))
        if isinstance(value, Mapping):
            resolved = {key: self.node(item) for key, item in value.items()}
            return cast("T", MappingProxyType(resolved))
        return value

    def _dataclass(self, value: Any) -> Any:
        names = {item.name for item in dataclasses.fields(value)}
        changes: dict[str, Any] = {}
        for name in names:
            if name.endswith("_html"):
                continue
            current = getattr(value, name)
            html_name = f"{name.removesuffix('_md')}_html"
            if not name.endswith("_md") or html_name not in names:
                changes[name] = self.node(current)
                continue
            source = self._jinja(current)
            changes[name] = source
            changes[html_name] = self._html(source)
        return dataclasses.replace(value, **changes)

    def _jinja(self, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, tuple):
            return tuple(self._jinja(item) for item in value)
        try:
            return self._context.render_text(self._env, str(value))
        except (BuildError, jinja2.TemplateError, self._context.ContextError) as error:
            raise BuildError(f"a spec text field does not render: {error}") from error

    def _html(self, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, tuple):
            return tuple(self._html(item) for item in value)
        return markdown.render_inline(str(value), self._mode)

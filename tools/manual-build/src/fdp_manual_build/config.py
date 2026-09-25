# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``manual/build.yaml`` → :class:`BuildConfig` and :class:`VariantConfig`.

The file belongs to the manual sources; the PDF build adds its own keys under
the ``pdf`` block. Parsing and schema validation go through the manual's
loader, so the knob names here are the manual's.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final, Literal, cast

from fdp_manual_build.errors import BuildError, LoadError
from fdp_manual_build.manual_tools import spec_loader

__all__ = [
    "BuildConfig",
    "ChapterConfig",
    "DocumentConfig",
    "FontsConfig",
    "OutputsConfig",
    "PageBudget",
    "PdfConfig",
    "RevisionEntry",
    "VariantConfig",
    "load_build_config",
]

Layout = Literal["single_column", "mixed", "two_column"]
TableStyle = Literal["fit_page", "span_pages_repeat_header"]
FactPlacement = Literal["tables_only", "mixed", "prose_only"]
XrefStyle = Literal["explicit", "short_with_footnotes"]
Units = Literal["si", "si_plus_imperial"]
PageFurniture = Literal["page_numbers", "running_headers_footers_revision_stamp"]

#: The manual has ten chapters; the numbers are part of every cross-reference.
CHAPTER_COUNT: Final = 10
#: The manual targets 30 to 50 A4 pages; the build fails outside this wider budget.
DEFAULT_PAGE_BUDGET: Final = (28, 56)
#: Both committed variants must exist before anything can be built.
REQUIRED_VARIANTS: Final = ("clean", "realistic")

_LAYOUTS: Final = frozenset({"single_column", "mixed", "two_column"})
_TABLE_STYLES: Final = frozenset({"fit_page", "span_pages_repeat_header"})
_FACT_PLACEMENTS: Final = frozenset({"tables_only", "mixed", "prose_only"})
_XREF_STYLES: Final = frozenset({"explicit", "short_with_footnotes"})
_UNITS: Final = frozenset({"si", "si_plus_imperial"})
_PAGE_FURNITURE: Final = frozenset({"page_numbers", "running_headers_footers_revision_stamp"})

_BUILD_YAML = "build.yaml"


@dataclass(frozen=True)
class RevisionEntry:
    """One row of the revision history printed in chapter 10."""

    revision: str
    date: str
    change: str


@dataclass(frozen=True)
class DocumentConfig:
    """``document:`` — the identity printed on the cover and in the furniture."""

    title: str
    subtitle: str
    number: str
    revision: str
    revision_date: str
    language: str
    license: str
    issuer: str
    revisions: tuple[RevisionEntry, ...]


@dataclass(frozen=True)
class ChapterConfig:
    """One chapter: its fixed number, its slug and the partial that holds it."""

    number: int
    slug: str
    title: str

    @property
    def filename(self) -> str:
        """``content/NN-<slug>.md``, the partial written for this chapter."""
        return f"{self.number:02d}-{self.slug}.md"


@dataclass(frozen=True)
class OutputsConfig:
    """``outputs:`` — where the PDFs go and how they are named."""

    dir: str
    basename: str

    def pdf_name(self, variant: str) -> str:
        """``cau-7-realistic.pdf`` for ``variant="realistic"``."""
        return f"{self.basename}-{variant}.pdf"


@dataclass(frozen=True)
class FontsConfig:
    """``fonts:`` — the two families and the directory that holds the files."""

    body: str
    mono: str
    dir: str


@dataclass(frozen=True)
class PageBudget:
    """The inclusive page range a rendered variant must land in."""

    min: int
    max: int


@dataclass(frozen=True)
class PdfConfig:
    """``pdf:`` — the keys the PDF build owns inside the manual's file."""

    pdf_identifier: str
    page_budget: PageBudget
    manifest: str
    catalog: str


@dataclass(frozen=True)
class VariantConfig:
    """One resolved variant: the manual's knob names with ``extends`` applied."""

    name: str
    layout: Layout
    two_column_chapters: tuple[int, ...]
    tables: TableStyle
    fact_placement: FactPlacement
    prose_only: tuple[str, ...]
    table_only: tuple[str, ...]
    xref_style: XrefStyle
    units: Units
    page_furniture: PageFurniture
    footnotes: bool
    enabled: bool
    extends: str | None
    raster_dpi: int | None
    skew_deg: float | None
    noise: float | None

    def fact_in_prose(self, anchor: str) -> bool:
        """False only when this variant keeps ``anchor`` out of the prose."""
        return not (self.fact_placement == "mixed" and anchor in self.table_only)

    def fact_in_table(self, anchor: str) -> bool:
        """False only when this variant keeps ``anchor`` out of the tables."""
        return not (self.fact_placement == "mixed" and anchor in self.prose_only)

    def is_two_column(self, chapter: int) -> bool:
        """Whether chapter ``chapter`` is set in two columns in this variant."""
        return self.layout != "single_column" and chapter in self.two_column_chapters


@dataclass(frozen=True)
class BuildConfig:
    """``manual/build.yaml`` as the build engine sees it."""

    path: Path
    manual_root: Path
    schema_version: int
    document: DocumentConfig
    source_date_epoch: int
    outputs: OutputsConfig
    fonts: FontsConfig
    chapters: tuple[ChapterConfig, ...]
    default_variant: str
    variants: Mapping[str, VariantConfig]
    allowed_number_phrases: tuple[str, ...]
    pdf: PdfConfig
    source_hash: str

    @property
    def source_date_iso(self) -> str:
        """``source_date_epoch`` as the ``dcterms.created`` value of the HTML."""
        return datetime.fromtimestamp(self.source_date_epoch, tz=UTC).isoformat()

    def variant(self, name: str) -> VariantConfig:
        """Return the resolved variant ``name``."""
        try:
            return self.variants[name]
        except KeyError:
            known = ", ".join(sorted(self.variants))
            raise BuildError(f"{self.path}: unknown variant {name!r} (have {known})") from None

    def chapter_path(self, chapter: ChapterConfig) -> Path:
        """Absolute path of the Markdown partial that holds ``chapter``."""
        return self.manual_root / "content" / chapter.filename


def load_build_config(repo_root: Path, manual_root: Path | None = None) -> BuildConfig:
    """Read, validate and map ``<manual_root>/build.yaml``.

    Args:
        repo_root: the checkout that provides ``manual/tools/load.py`` and the
            schemas under ``manual/spec/schemas``.
        manual_root: the tree that holds ``build.yaml``; defaults to
            ``<repo_root>/manual``. A fixture passes its own directory.

    Raises:
        BuildError: when the file is missing, fails its schema or breaks one of
            the build rules (chapter numbering, variants, page budget).
    """
    root = (repo_root / "manual") if manual_root is None else manual_root
    path = root / _BUILD_YAML
    if not path.is_file():
        raise BuildError(f"{path}: no {_BUILD_YAML} in this manual tree")

    loader = spec_loader(repo_root)
    try:
        spec = loader.load_spec(root=root, only={"build"})
    except loader.SpecError as error:
        messages: Sequence[str] = getattr(error, "messages", [str(error)])
        raise BuildError(
            f"{path}: {_BUILD_YAML} does not validate",
            [LoadError.parse(message) for message in messages],
        ) from error

    document = spec.document("build")
    if document is None:  # pragma: no cover - load_spec found the file above
        raise BuildError(f"{path}: {_BUILD_YAML} could not be read")
    return _build_config(path, root, document)


def _build_config(path: Path, manual_root: Path, raw: Mapping[str, Any]) -> BuildConfig:
    errors: list[LoadError] = []
    relative = _BUILD_YAML
    chapters = _chapters(relative, raw["chapters"], errors)
    variants = _variants(relative, raw["variants"], errors)
    default_variant = str(raw["default_variant"])
    if default_variant not in variants:
        errors.append(
            LoadError(relative, "/default_variant", f"unknown variant {default_variant!r}")
        )
    for name in REQUIRED_VARIANTS:
        if name not in variants:
            errors.append(LoadError(relative, "/variants", f"variant {name!r} is missing"))
    pdf = _pdf(relative, raw.get("pdf"), raw["outputs"], errors)
    if errors:
        raise BuildError(f"{path}: {_BUILD_YAML} breaks the build rules", errors)

    return BuildConfig(
        path=path,
        manual_root=manual_root,
        schema_version=int(raw["schema_version"]),
        document=_document(raw["document"]),
        source_date_epoch=int(raw["source_date_epoch"]),
        outputs=OutputsConfig(dir=raw["outputs"]["dir"], basename=raw["outputs"]["basename"]),
        fonts=FontsConfig(
            body=raw["fonts"]["body"], mono=raw["fonts"]["mono"], dir=raw["fonts"]["dir"]
        ),
        chapters=chapters,
        default_variant=default_variant,
        variants=MappingProxyType(variants),
        allowed_number_phrases=tuple(raw["lint"]["allowed_number_phrases"]),
        pdf=pdf,
        source_hash=hashlib.sha256(path.read_bytes()).hexdigest(),
    )


def _document(raw: Mapping[str, Any]) -> DocumentConfig:
    return DocumentConfig(
        title=raw["title"],
        subtitle=raw["subtitle"],
        number=raw["number"],
        revision=raw["revision"],
        revision_date=raw["revision_date"],
        language=raw["language"],
        license=raw["license"],
        issuer=raw["issuer"],
        revisions=tuple(
            RevisionEntry(revision=item["revision"], date=item["date"], change=item["change"])
            for item in raw["revisions"]
        ),
    )


def _chapters(
    relative: str,
    raw: Sequence[Mapping[str, Any]],
    errors: list[LoadError],
) -> tuple[ChapterConfig, ...]:
    chapters = tuple(
        ChapterConfig(number=int(item["number"]), slug=item["slug"], title=item["title"])
        for item in raw
    )
    if len(chapters) != CHAPTER_COUNT:
        errors.append(
            LoadError(relative, "/chapters", f"expected {CHAPTER_COUNT}, found {len(chapters)}")
        )
    for index, chapter in enumerate(chapters):
        if chapter.number != index + 1:
            errors.append(
                LoadError(
                    relative,
                    f"/chapters/{index}/number",
                    f"expected {index + 1}, found {chapter.number}",
                )
            )
    slugs = [chapter.slug for chapter in chapters]
    for index, slug in enumerate(slugs):
        if slugs.index(slug) != index:
            errors.append(LoadError(relative, f"/chapters/{index}/slug", f"duplicate {slug!r}"))
    return chapters


def _variants(
    relative: str,
    raw: Mapping[str, Mapping[str, Any]],
    errors: list[LoadError],
) -> dict[str, VariantConfig]:
    resolved: dict[str, VariantConfig] = {}
    for name in raw:
        variant = _variant(relative, name, raw, errors, seen=())
        if variant is not None:
            resolved[name] = variant
    return resolved


def _variant(
    relative: str,
    name: str,
    raw: Mapping[str, Mapping[str, Any]],
    errors: list[LoadError],
    seen: tuple[str, ...],
) -> VariantConfig | None:
    pointer = f"/variants/{name}"
    if name in seen:
        cycle = " -> ".join([*seen, name])
        errors.append(LoadError(relative, pointer, f"`extends` cycle {cycle}"))
        return None
    body = raw[name]
    parent_name = body.get("extends")
    base = _EMPTY_VARIANT
    if parent_name is not None:
        if parent_name not in raw:
            errors.append(
                LoadError(relative, f"{pointer}/extends", f"unknown variant {parent_name!r}")
            )
            return None
        parent = _variant(relative, str(parent_name), raw, errors, seen=(*seen, name))
        if parent is None:
            return None
        base = parent
    return _apply_knobs(relative, name, base, body, errors)


def _apply_knobs(
    relative: str,
    name: str,
    base: VariantConfig,
    body: Mapping[str, Any],
    errors: list[LoadError],
) -> VariantConfig:
    knobs = _Knobs(relative, f"/variants/{name}", body, errors)
    prose_only = tuple(body.get("prose_only", base.prose_only))
    table_only = tuple(body.get("table_only", base.table_only))
    for anchor in sorted(set(prose_only) & set(table_only)):
        errors.append(
            LoadError(relative, knobs.pointer, f"anchor {anchor!r} is both prose- and table-only")
        )
    return replace(
        base,
        name=name,
        layout=knobs.choice("layout", _LAYOUTS, base.layout),
        two_column_chapters=tuple(body.get("two_column_chapters", base.two_column_chapters)),
        tables=knobs.choice("tables", _TABLE_STYLES, base.tables),
        fact_placement=knobs.choice("fact_placement", _FACT_PLACEMENTS, base.fact_placement),
        prose_only=prose_only,
        table_only=table_only,
        xref_style=knobs.choice("xref_style", _XREF_STYLES, base.xref_style),
        units=knobs.choice("units", _UNITS, base.units),
        page_furniture=knobs.choice("page_furniture", _PAGE_FURNITURE, base.page_furniture),
        footnotes=bool(body.get("footnotes", base.footnotes)),
        enabled=bool(body.get("enabled", True)),
        extends=body.get("extends"),
        raster_dpi=body.get("raster_dpi", base.raster_dpi),
        skew_deg=body.get("skew_deg", base.skew_deg),
        noise=body.get("noise", base.noise),
    )


class _Knobs:
    """Reads one variant's enumerated knobs, falling back to its parent."""

    def __init__(
        self,
        relative: str,
        pointer: str,
        body: Mapping[str, Any],
        errors: list[LoadError],
    ) -> None:
        self.pointer = pointer
        self._relative = relative
        self._body = body
        self._errors = errors

    def choice[T: str](self, key: str, allowed: frozenset[str], fallback: T) -> T:
        """The knob ``key``, or ``fallback`` when it is absent or unknown."""
        if key not in self._body:
            return fallback
        value = str(self._body[key])
        if value not in allowed:
            self._errors.append(
                LoadError(self._relative, f"{self.pointer}/{key}", f"unknown value {value!r}")
            )
            return fallback
        return cast("T", value)


def _pdf(
    relative: str,
    raw: Mapping[str, Any] | None,
    outputs: Mapping[str, Any],
    errors: list[LoadError],
) -> PdfConfig:
    basename = str(outputs["basename"])
    out_dir = str(outputs["dir"])
    body = raw or {}
    budget_raw = body.get("page_budget", {})
    budget = PageBudget(
        min=int(budget_raw.get("min", DEFAULT_PAGE_BUDGET[0])),
        max=int(budget_raw.get("max", DEFAULT_PAGE_BUDGET[1])),
    )
    if budget.min >= budget.max:
        errors.append(
            LoadError(
                relative,
                "/pdf/page_budget",
                f"min {budget.min} is not below max {budget.max}",
            )
        )
    pdf_outputs = body.get("outputs", {})
    return PdfConfig(
        pdf_identifier=str(body.get("pdf_identifier", f"fdp-{basename}-manual")),
        page_budget=budget,
        manifest=str(pdf_outputs.get("manifest", f"{out_dir}/build-manifest.json")),
        catalog=str(pdf_outputs.get("catalog", "tools/eval/fixtures/catalog.json")),
    )


_EMPTY_VARIANT = VariantConfig(
    name="",
    layout="single_column",
    two_column_chapters=(),
    tables="fit_page",
    fact_placement="tables_only",
    prose_only=(),
    table_only=(),
    xref_style="explicit",
    units="si",
    page_furniture="page_numbers",
    footnotes=False,
    enabled=True,
    extends=None,
    raster_dpi=None,
    skew_deg=None,
    noise=None,
)

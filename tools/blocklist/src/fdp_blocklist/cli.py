# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-blocklist``: scan, list, self-test and hash.

Exit codes follow the convention of the repository's Python tools: ``0`` clean,
``1`` findings, ``2`` a usage or environment error.
"""

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from fdp_blocklist import __version__, terms
from fdp_blocklist.config import Config, ConfigError, load_config
from fdp_blocklist.scan import Hit, Matcher, ScanError, Scanner, collect_paths
from fdp_blocklist.terms import HashedList, RegexTerm, TermList, TermListError

__all__ = ["main"]

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_ERROR = 2

_HASH_SUFFIX = ".sha256"

_SELF_TEST_LIST = """\
[makers]
Zorblax Kompressoren  # synthetic: never a real name

[lubricants]
Zorbal

[product-lines]
re:\\bZX-?9[0-9]{3}\\b  # synthetic model-code pattern
"""

_SELF_TEST_TEXT = """\
Zorbaline oil and the zorbal drum sit beside the zorblaxkompressoren spare.
A plate on the skid reads Zorblax
Kompressoren, model ZX-9000, rebuilt last spring.
"""

#: What ``_SELF_TEST_TEXT`` must yield: the plain term, its concatenated form,
#: the same phrase split across a line break and the model-code pattern.
_SELF_TEST_EXPECTED = frozenset(
    {"zorbal", "zorblaxkompressoren", "zorblax kompressoren", "zx-9000"}
)


def _terminal(message: str) -> None:
    print(message, file=sys.stderr)


def _load_terms(
    config: Config,
    override: Path | None,
) -> tuple[HashedList, tuple[RegexTerm, ...], str]:
    """The digests to match, the ``re:`` patterns in force and their origin."""
    if override is not None:
        if override.suffix == _HASH_SUFFIX:
            return terms.read_hash_file(override), (), str(override)
        plain = terms.read_term_list(override)
        hashed = HashedList(terms.hash_terms(plain, config.salt), str(override))
        return hashed, plain.regex, str(override)
    hashed = terms.read_hash_file(config.hash_file)
    patterns: tuple[RegexTerm, ...] = ()
    origin = str(config.hash_file)
    if config.private_list.is_file():
        patterns = terms.read_term_list(config.private_list).regex
        origin = f"{origin} + {config.private_list}"
    return hashed, patterns, origin


def _report_text(hits: Sequence[Hit], summary: str) -> None:
    for hit in hits:
        print(f"{hit.location}: {hit.term}  [{hit.section}]")
        if hit.context:
            print(f"    {hit.context}")
    print(summary)


def _run_scan(args: argparse.Namespace) -> int:
    config = load_config()
    root = Path(args.root).resolve()
    hashed, patterns, origin = _load_terms(config, args.list)
    matcher = Matcher(hashed, config.salt, patterns)
    allow = terms.read_allow_list(args.allow if args.allow is not None else config.allow_file)
    scanner = Scanner(root, matcher, allow)

    relative = collect_paths(
        root,
        args.paths,
        excludes=(*config.exclude, *args.exclude),
        pdf_globs=config.pdf_globs,
        staged=args.staged,
    )
    text_paths = [path for path in relative if not path.lower().endswith(".pdf")]
    pdf_paths = [path for path in relative if path.lower().endswith(".pdf")]
    extra_pdfs = [Path(entry) for entry in args.pdf]

    hits: list[Hit] = []
    for path in text_paths:
        hits.extend(scanner.scan_file(path))
    if pdf_paths or extra_pdfs:
        from fdp_blocklist import pdf  # noqa: PLC0415

        for path in pdf_paths:
            hits.extend(pdf.scan_pdf(scanner, root / path, path))
        for extra in extra_pdfs:
            if not extra.is_file():
                raise ScanError(f"{extra}: no such PDF")
            hits.extend(pdf.scan_pdf(scanner, extra, extra.as_posix()))

    scanned_pdfs = len(pdf_paths) + len(extra_pdfs)
    summary = (
        f"{len(hits)} hit(s) in {len(text_paths)} text file(s) and {scanned_pdfs} PDF(s) "
        f"against {len(hashed.entries)} digest(s) and {matcher.regex_count} pattern(s) "
        f"from {origin}"
    )
    if args.format == "json":
        print(
            json.dumps(
                {
                    "hits": [hit.as_dict() for hit in hits],
                    "text_files": len(text_paths),
                    "pdf_files": scanned_pdfs,
                    "digests": len(hashed.entries),
                    "patterns": matcher.regex_count,
                    "list": origin,
                },
                indent=2,
                sort_keys=True,
            )
        )
    else:
        _report_text(hits, summary)
    return EXIT_FINDINGS if hits else EXIT_OK


def _run_list(args: argparse.Namespace) -> int:
    config = load_config()
    source = args.list if args.list is not None else config.hash_file
    hashed = terms.read_hash_file(source)
    counts = terms.section_counts(hashed)
    variants = len(hashed.entries) - sum(counts.values())
    short = [name for name, count in counts.items() if count < terms.MINIMUM_TERMS[name]]
    rows = [
        {"section": name, "terms": count, "minimum": terms.MINIMUM_TERMS[name]}
        for name, count in counts.items()
    ]
    if args.format == "json":
        print(
            json.dumps(
                {"source": str(source), "sections": rows, "variants": variants},
                indent=2,
                sort_keys=True,
            )
        )
    else:
        print(f"{'section':<16}{'terms':>7}{'minimum':>9}")
        for row in rows:
            flag = "  short" if row["section"] in short else ""
            print(f"{row['section']:<16}{row['terms']:>7}{row['minimum']:>9}{flag}")
        total = sum(counts.values())
        print(f"{len(hashed.entries)} digest(s) = {total} term(s) + {variants} variant(s)")
    if short:
        _terminal(f"below the section minimum: {', '.join(short)}")
        return EXIT_FINDINGS
    return EXIT_OK


def _run_self_test(args: argparse.Namespace) -> int:
    config = load_config()
    plain = terms.parse_term_list(_SELF_TEST_LIST, "<self-test>")
    hashed = HashedList(terms.hash_terms(plain, config.salt), "<self-test>")
    matcher = Matcher(hashed, config.salt, plain.regex)
    hits = matcher.scan_text("<self-test>", _SELF_TEST_TEXT)
    found = {hit.term.casefold() for hit in hits}
    missing = sorted(_SELF_TEST_EXPECTED - found)
    unexpected = sorted(found - _SELF_TEST_EXPECTED)
    if args.format == "json":
        print(
            json.dumps(
                {
                    "hits": [hit.as_dict() for hit in hits],
                    "missing": missing,
                    "unexpected": unexpected,
                },
                indent=2,
                sort_keys=True,
            )
        )
    else:
        _report_text(hits, f"self-test: {len(hits)} hit(s) on synthetic terms")
    if missing or unexpected:
        _terminal(f"self-test failed: missing {missing}, unexpected {unexpected}")
        return EXIT_FINDINGS
    return EXIT_OK


def _run_hash(args: argparse.Namespace) -> int:
    config = load_config()
    plain: TermList = terms.read_term_list(args.source)
    rendered = terms.render_hash_file(terms.hash_terms(plain, config.salt))
    target = args.out if args.out is not None else config.hash_file
    if args.check:
        if not target.is_file():
            _terminal(f"{target}: missing; run fdp-blocklist hash --from {args.source}")
            return EXIT_FINDINGS
        if target.read_text(encoding="utf-8") != rendered:
            _terminal(f"{target}: out of date with {args.source}")
            return EXIT_FINDINGS
        print(f"{target}: up to date with {args.source} ({len(plain.plain)} term(s))")
        return EXIT_OK
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered, encoding="utf-8")
    print(
        f"{target}: wrote {len(plain.plain)} term(s) "
        f"({len(plain.regex)} re: pattern(s) stay in {args.source})"
    )
    return EXIT_OK


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fdp-blocklist",
        description="Scan repository text and PDF text for real brand names.",
    )
    parser.add_argument("--version", action="version", version=f"fdp-blocklist {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan", help="scan files and PDFs for listed terms")
    scan.add_argument("paths", nargs="*", help="limit the scan to these files or directories")
    scan.add_argument(
        "--pdf",
        action="append",
        default=[],
        metavar="PATH",
        help="also scan this PDF, even outside the scan set",
    )
    scan.add_argument("--format", choices=("text", "json"), default="text")
    scan.add_argument("--root", default=".", metavar="DIR", help="repository root (default: .)")
    scan.add_argument(
        "--list",
        type=Path,
        metavar="FILE",
        help="digest file (*.sha256) or plain-text list to match instead",
    )
    scan.add_argument("--allow", type=Path, metavar="FILE", help="allow list to use instead")
    scan.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="GLOB",
        help="skip paths matching this glob, in addition to blocklist.toml",
    )
    scan.add_argument("--staged", action="store_true", help="scan the staged files only")
    scan.set_defaults(handler=_run_scan)

    listing = subparsers.add_parser("list", help="show the sections and their term counts")
    listing.add_argument("--list", type=Path, metavar="FILE", help="digest file to read instead")
    listing.add_argument("--format", choices=("text", "json"), default="text")
    listing.set_defaults(handler=_run_list)

    self_test = subparsers.add_parser(
        "self-test", help="run the matcher over synthetic text with synthetic terms"
    )
    self_test.add_argument("--format", choices=("text", "json"), default="text")
    self_test.set_defaults(handler=_run_self_test)

    hashing = subparsers.add_parser("hash", help="regenerate or verify the committed digest file")
    hashing.add_argument(
        "--from",
        dest="source",
        type=Path,
        required=True,
        metavar="FILE",
        help="the gitignored plain-text term list",
    )
    hashing.add_argument("--out", type=Path, metavar="FILE", help="digest file to write")
    hashing.add_argument(
        "--check",
        action="store_true",
        help="do not write; fail when the digest file is out of date",
    )
    hashing.set_defaults(handler=_run_hash)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point of the ``fdp-blocklist`` console script."""
    args = _build_parser().parse_args(argv)
    try:
        exit_code: int = args.handler(args)
    except (ConfigError, ScanError, TermListError, OSError) as error:
        _terminal(f"fdp-blocklist: {error}")
        return EXIT_ERROR
    return exit_code


if __name__ == "__main__":
    sys.exit(main())

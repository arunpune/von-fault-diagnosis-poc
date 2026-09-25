# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Manual build for the fault-diagnosis PoC.

Turns the YAML sources under ``manual/`` into the two committed manuals (the
clean and the realistic variant) and the reference catalog. This package holds
the loader, the data model and the build engine; the source of truth for field
names, schemas and the authoring contract stays with ``manual/tools``.

See ``README.md`` next to this package for how to run it, and docs/manual.md
for what the build produces.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]

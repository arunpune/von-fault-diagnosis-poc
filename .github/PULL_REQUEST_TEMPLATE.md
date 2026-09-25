<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC0-1.0 -->

## Summary

<!-- What does this change do, and why? Link the issue it addresses, e.g. "Closes #123". -->

## Checks run

<!-- Tick what you ran locally, and paste the tail of any output that matters. -->

- [ ] `make check` (lint and unit tests)
- [ ] `make test-integration`, if the change touches the database, the broker, the images or the Compose files
- [ ] `make eval`, if the change touches detection, retrieval, the decision backends or the gate
- [ ] `make check-manual`, if the change touches the manual sources or the manual build
- [ ] Documentation updated where behaviour, commands or variables changed

## Ground rules

- [ ] The change follows the [ground rules](https://github.com/meddleconnect/jev-fault-diagnosis-poc/blob/main/CONTRIBUTING.md#ground-rules): no third-party manual, no real brand
      name or model code, ground truth kept out of the diagnosis, no MetroPT-3 rows or other large files, no GPL or
      AGPL runtime dependency.
- [ ] New files carry an SPDX header (or a `REUSE.toml` entry), and `make reuse` passes.
- [ ] The commits follow Conventional Commits with a scope from [CONTRIBUTING.md](https://github.com/meddleconnect/jev-fault-diagnosis-poc/blob/main/CONTRIBUTING.md#4-commits).
- [ ] No secret: no API key, token, password or `.env` content in the code, the tests, the logs or this description.
- [ ] I license this contribution under the project's licences, as [CONTRIBUTING.md](https://github.com/meddleconnect/jev-fault-diagnosis-poc/blob/main/CONTRIBUTING.md#licensing-of-contributions) describes.

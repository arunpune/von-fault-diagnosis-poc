<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Security policy

Fault Diagnosis PoC is a proof of concept. It is not meant for production use: the UI and the API have no
authentication, the database and broker passwords are non-secret defaults, and the machine and its manual are
fictional. Run it on a machine or network you trust. The threat model and its limits are in
[docs/security.md](docs/security.md).

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub's private vulnerability reporting:
[open a draft security advisory](https://github.com/meddleconnect/von-fault-diagnosis-poc/security/advisories/new).

**Never report a vulnerability in a public issue, pull request or discussion**, and never paste a real API key, token or
password anywhere, including in the report. If a key of yours was exposed, revoke it with its vendor first.

A useful report includes:

- what the vulnerability is and what an attacker could do with it;
- the affected component (for example the backend, the gateway, the simulator, init, the frontend or the Compose
  configuration) and the version or commit;
- the steps to reproduce it, with a minimal proof of concept where possible;
- the configuration involved (the decision backend, the Compose files, any changed `.env` variable, without its
  secret value);
- any mitigation you know of.

## Supported versions

| Version             | Supported |
| ------------------- | --------- |
| The latest release  | Yes       |
| `main`              | Yes       |
| Every older release | No        |

Fixes land on `main` and ship with the next release.

## What to expect

This is a proof of concept maintained on a best-effort basis, so there is no guaranteed response time. The maintainers
aim to acknowledge a report within a few working days, to keep you informed while it is looked at, and to credit you in
the advisory once a fix is published, unless you prefer not to be named. Please give them a reasonable time to fix the
issue before you disclose it.

## Scope

In scope: the code, configuration and container definitions in this repository.

Out of scope:

- third-party services the stack can call, such as TypeSafe AI's Von API and Anthropic's API; report their issues to
  their vendors;
- third-party dependencies, unless this repository uses them in a vulnerable way; report the dependency itself
  upstream;
- the behaviours [docs/security.md](docs/security.md) documents as limits of the proof of concept, such as the missing
  authentication and the default credentials, unless you find a way past a boundary it claims to hold, for example the
  broker ACL, the database roles or the ground-truth isolation.

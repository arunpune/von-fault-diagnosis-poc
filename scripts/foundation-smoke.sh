#!/bin/sh
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The fresh-worktree contract: clone this repository at a revision into a
# temporary directory and reach green there with nothing but the documented
# toolchain — no node_modules, no .venv, no gitignored helper, no environment
# variable of this checkout.
#
# Usage: scripts/foundation-smoke.sh [REVISION]   (default: HEAD)
#
# It is runnable from a linked worktree and from CI: the objects come from
# the common git directory and the revision is checked out detached, so the
# branch a worktree happens to be on does not change what is proved.
#
# Exit code: the exit code of `make check` inside the clone. The temporary
# directory is always removed.

set -eu

revision=${1:-HEAD}

say() {
	printf '%s\n' "foundation-smoke: $*"
}

fail() {
	say "$*" >&2
	exit 2
}

command -v git >/dev/null 2>&1 || fail "git is not on PATH"
command -v make >/dev/null 2>&1 || fail "make is not on PATH"

source_repo=$(git rev-parse --path-format=absolute --git-common-dir) ||
	fail "not inside a git work tree"
commit=$(git rev-parse --verify "$revision^{commit}") ||
	fail "$revision does not name a commit"

work=$(mktemp -d "${TMPDIR:-/tmp}/fdp-foundation-smoke.XXXXXX") ||
	fail "cannot create a temporary directory"
clone=$work/fdp
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

started=$(date +%s)
say "cloning $revision ($commit) into $clone"
git clone --local --no-hardlinks --no-checkout --quiet "$source_repo" "$clone"
git -C "$clone" checkout --quiet --detach "$commit"

status=0
say "running 'make install' in the clone"
make -C "$clone" install || status=$?
if [ "$status" -eq 0 ]; then
	say "running 'make check' in the clone"
	make -C "$clone" check || status=$?
fi

elapsed=$(($(date +%s) - started))
if [ "$status" -eq 0 ]; then
	say "green in ${elapsed}s"
else
	say "red after ${elapsed}s (exit $status)" >&2
fi
exit "$status"

#!/usr/bin/env bash
# CI test entry point (PA-65). Bamboo's Script task is `./test.sh` then
# `./build.sh`, matching every other plan on that server.
#
#   ./test.sh              # install, test, lint, typecheck
#   ./test.sh --no-install # skip the install step (already warm)
#
# ## Three things here are deliberate and easy to "tidy" into breakage
#
# **Tests run first.** Bamboo's JUnit parser task globs
# `**/test-reports/*.xml`, and a script that dies before vitest ever runs
# leaves no XML — so the build reports "no test results found" instead of
# naming the failing test. Lint and typecheck produce no XML at all, so if they
# ran first, any lint error would present as a mystery.
#
# **Nothing aborts early.** Each step's exit status is collected and the script
# fails at the end, so one run tells you about a test failure *and* a lint
# error rather than making you fix them one build at a time. This is why
# `set -e` is deliberately not in force around the steps themselves.
#
# **`--frozen-lockfile` is not negotiable.** It is what makes a rebuild of a
# tag install the same dependency tree as the original build (the "reproducible"
# acceptance criterion). A warm pnpm store on the one shared build agent can
# mask a lockfile that is actually incomplete — that is exactly how PA-64 found
# the lockfile was missing pnpm 12's own package-manager document.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

install=1
[[ "${1:-}" == '--no-install' ]] && install=0

reports_dir="${repo_root}/test-reports"
rm -rf "$reports_dir"
mkdir -p "$reports_dir"

failures=()
run() {
    local label="$1"
    shift
    echo "==> ${label}"
    if ! "$@"; then
        echo "!!! ${label} FAILED"
        failures+=("$label")
    fi
}

if [[ "$install" == '1' ]]; then
    # A failed install is the one thing worth aborting on: every step below
    # would fail for the same reason and the output would bury the cause.
    echo '==> pnpm install --frozen-lockfile'
    if ! pnpm install --frozen-lockfile; then
        echo '!!! install FAILED'
        exit 1
    fi
fi

# `packages/protocol` is consumed as compiled output, so it must exist before
# anything typechecks, lints or tests against it. Same reason the root
# package.json scripts each start with `pnpm protocol`.
echo '==> pnpm protocol'
if ! pnpm protocol; then
    echo '!!! protocol build FAILED'
    exit 1
fi

# The junit reporter writes its XML even when tests fail, which is the whole
# point of running this first. `default` is kept alongside it so a human
# reading the build log still sees the normal progress output.
run 'pnpm test (vitest)' pnpm exec vitest run \
    --reporter=default \
    --reporter=junit \
    --outputFile.junit="${reports_dir}/junit.xml"

run 'pnpm lint' pnpm lint
run 'pnpm typecheck' pnpm typecheck

if [[ ${#failures[@]} -gt 0 ]]; then
    echo
    echo "FAILED: ${failures[*]}"
    exit 1
fi

echo
echo 'All checks passed.'

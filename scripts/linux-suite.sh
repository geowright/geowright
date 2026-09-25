#!/bin/bash
# The suite on LINUX, locally: inside the official Playwright container (any Docker-compatible runtime).
# For when no hosted Linux CI is available — everything is developed on macOS, real-world CI is Linux, and Linux has
# found things macOS never showed (slower software GL, different fonts and DPR handling).
#
#   bash scripts/linux-suite.sh                          # typecheck, build, full suite, compat matrix
#   bash scripts/linux-suite.sh tests/act.spec.ts -g x   # anything after the script name goes to `playwright test`
#
# The working tree is COPIED into a named volume (geowright-linux-<hash of this checkout's path>: one per checkout, so
# two checkouts never run each other's code): node_modules holds platform binaries, so the macOS one cannot be shared,
# and the copy keeps the container from writing into the repository. `npm ci` is cached in that volume and only re-run
# when package-lock.json changes. One run per checkout at a time. Results: test-results-linux/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .scratch
LOCK=.scratch/linux-suite.lock
mkdir "$LOCK" 2>/dev/null || { echo "linux-suite: already running in this checkout ($PWD/$LOCK; remove it if no run is)" >&2; exit 1; }
trap 'rmdir "$LOCK"' EXIT
# shasum on macOS, sha1sum where there is no shasum (a Linux host): the same SHA-1, so the same volume name.
SHA1=$(command -v shasum >/dev/null 2>&1 && echo shasum || echo sha1sum)
VOLUME="geowright-linux-$(pwd -P | $SHA1 | cut -c1-12)"
PW=$(node -p "require('./node_modules/@playwright/test/package.json').version")
IMAGE="mcr.microsoft.com/playwright:v${PW}-noble"
OUT="$PWD/test-results-linux"
rm -rf "$OUT" && mkdir -p "$OUT"
# The verdict names a commit: the one checked out, with no changes and no untracked files, BEFORE the copy is made. (The
# copy takes untracked files too: a new module that was never added would run here and be missing from the commit. And
# read after a ~10-minute run, HEAD may be a commit made meanwhile in this checkout, whose code never ran.)
RAN_ON=$(git rev-parse HEAD)
RAN_CLEAN=0; [ -n "$(git status --porcelain)" ] || RAN_CLEAN=1

# (COPYFILE_DISABLE / --no-mac-metadata: macOS tar otherwise adds an AppleDouble `._name` twin for every file with
#  extended attributes, and Playwright on Linux then tries to run `._act.spec.ts`)
case "$(tar --version 2>/dev/null)" in *bsdtar*) MAC_TAR=--no-mac-metadata ;; *) MAC_TAR= ;; esac # GNU tar has no such flag (exit 64)
# shellcheck disable=SC2086 # MAC_TAR is one flag or nothing
git ls-files -z --cached --others --exclude-standard | COPYFILE_DISABLE=1 tar $MAC_TAR --null -T - -cf - 2>/dev/null | docker run --rm -i --init --ipc=host \
  -v "$VOLUME":/work -v "$OUT":/out -e CI=true -e FORCE_COLOR=0 -e LINUX_WORKERS "$IMAGE" bash -c '
    set -euo pipefail
    mkdir -p /work/src && cd /work/src
    find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    tar -xf - 2>/dev/null
    if ! cmp -s package-lock.json /work/lock.installed 2>/dev/null; then npm ci --no-audit --no-fund && cp package-lock.json /work/lock.installed; fi
    echo "== $(uname -sm), node $(node -v), $(nproc) cpus"
    code=0
    if [ "$#" -gt 0 ]; then
      npm run build >/dev/null
      npx playwright test "$@" --output=/out/suite || code=$?
    else
      npm run typecheck
      npm run build >/dev/null
      # 2 workers, like a hosted 4-vCPU runner (the default, half the cores, is 5 here: five software-GL browsers in
      # a VM on a shared desktop starve each other; first run, 26 timeouts). NO APOSTROPHES in this quoted block.
      npx playwright test --workers=${LINUX_WORKERS:-2} --output=/out/suite || code=$?
      npm run test:compat -- --output=/out/compat || code=$?
    fi
    exit $code
  ' bash "$@"

# A full green run on a clean tree leaves a verdict for that commit (git-ignored): release tooling asks for it. Only if
# the checkout is still exactly what was copied: same commit, still no changes and no untracked files.
if [ "$#" -eq 0 ] && [ "$RAN_CLEAN" -eq 0 ]; then
  echo "linux-suite: green, but the copy held changes or untracked files that ${RAN_ON} does not: no verdict written" >&2
elif [ "$#" -eq 0 ]; then
  if [ "$(git rev-parse HEAD)" = "$RAN_ON" ] && [ -z "$(git status --porcelain)" ]; then
    mkdir -p .scratch/verdicts && date -u +%Y-%m-%dT%H:%M:%SZ > ".scratch/verdicts/linux-$RAN_ON.ok"
  else
    echo "linux-suite: green, but the checkout changed during the run (HEAD, changes or untracked files): no verdict written for ${RAN_ON}" >&2
  fi
fi

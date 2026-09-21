#!/bin/bash
# The suite on LINUX, locally: inside the official Playwright container (any Docker-compatible runtime).
# For when no hosted Linux CI is available — everything is developed on macOS, real-world CI is Linux, and Linux has
# found things macOS never showed (slower software GL, different fonts and DPR handling).
#
#   bash scripts/linux-suite.sh                          # typecheck, build, full suite, compat matrix
#   bash scripts/linux-suite.sh tests/act.spec.ts -g x   # anything after the script name goes to `playwright test`
#
# The working tree is COPIED into a named volume (geowright-linux): node_modules holds platform binaries, so the
# macOS one cannot be shared, and the copy keeps the container from writing into the repository. `npm ci` is cached
# in that volume and only re-run when package-lock.json changes. Results: test-results-linux/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
PW=$(node -p "require('./node_modules/@playwright/test/package.json').version")
IMAGE="mcr.microsoft.com/playwright:v${PW}-noble"
OUT="$PWD/test-results-linux"
rm -rf "$OUT" && mkdir -p "$OUT"

# (COPYFILE_DISABLE / --no-mac-metadata: macOS tar otherwise adds an AppleDouble `._name` twin for every file with
#  extended attributes, and Playwright on Linux then tries to run `._act.spec.ts`)
git ls-files -z --cached --others --exclude-standard | COPYFILE_DISABLE=1 tar --no-mac-metadata --null -T - -cf - 2>/dev/null | docker run --rm -i --init --ipc=host \
  -v geowright-linux:/work -v "$OUT":/out -e CI=true -e FORCE_COLOR=0 -e LINUX_WORKERS "$IMAGE" bash -c '
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

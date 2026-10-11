#!/bin/bash
# Vendoring helper for MapLibre's own examples (maplibre/maplibre-gl-js, BSD-3-Clause), pinned to one tag.
#
#   bash wild/scripts/examples.sh fetch <name>   download the pristine upstream file to .upstream/ and, if the
#                                                example is not vendored yet, copy it to examples/ (then add the hook line by hand)
#   bash wild/scripts/examples.sh patches        regenerate patches/<name>.diff = upstream -> vendored, for every example
#   bash wild/scripts/examples.sh verify         regenerate the patches, then fail unless each one is exactly one added line,
#                                                the hook, and nothing removed (node wild/scripts/apps.mjs patches)
#
# Upstream is fetched once per TAG into the git-ignored .upstream/<TAG>/ and compared against from then on (a changed TAG
# fetches afresh; delete .upstream/ to re-fetch the same tag). Needs the network + an authenticated `gh` for a fetch.
# Never run by the test suite; the suite checks the COMMITTED patches offline (apps.mjs check), not upstream itself.
#
# Exit status: 0 done (verify: every example is upstream plus its hook) · 1 a verdict: a patch is not the hook alone, or
# upstream has no such example (HTTP 404) · 2 usage · 3 upstream could not be fetched (no network, gh missing or not
# logged in): nothing was compared. A caller may skip the comparison on 3 only, never on a verdict.
set -euo pipefail
TAG=v6.10.0
DIR=$(cd "$(dirname "$0")/../maplibre-examples" && pwd -P)
UP="$DIR/.upstream/$TAG"
mkdir -p "$UP" "$DIR/examples" "$DIR/patches"

# Into a temporary file first: a failed or interrupted fetch must not leave a partial file that later runs trust.
# A file upstream does not have (HTTP 404) is a verdict, exit 1; any other failure to fetch is exit 3.
fetch() {
  if gh api "repos/maplibre/maplibre-gl-js/contents/test/examples/$1.html?ref=$TAG" -H "Accept: application/vnd.github.raw" \
    > "$UP/$1.html.part" 2> "$UP/$1.html.err"; then
    rm -f "$UP/$1.html.err"; mv "$UP/$1.html.part" "$UP/$1.html"; return
  fi
  cat "$UP/$1.html.err" >&2; rm -f "$UP/$1.html.part"
  if grep -q 'HTTP 404' "$UP/$1.html.err"; then
    rm -f "$UP/$1.html.err"
    echo "examples.sh: maplibre-gl-js has no test/examples/$1.html at $TAG: a vendored example must be an upstream one" >&2
    exit 1
  fi
  rm -f "$UP/$1.html.err"
  echo "examples.sh: could not fetch $1.html ($TAG) from GitHub (no network, or gh missing or not logged in): nothing was compared" >&2
  exit 3
}

case "${1:-}" in
  fetch)
    fetch "$2"
    [ -e "$DIR/examples/$2.html" ] || cp "$UP/$2.html" "$DIR/examples/$2.html"
    ;;
  patches | verify)
    status=0
    for f in "$DIR"/examples/*.html; do
      name=$(basename "$f" .html)
      [ -e "$UP/$name.html" ] || fetch "$name"
      diff -u --label "upstream/test/examples/$name.html ($TAG)" --label "wild/maplibre-examples/examples/$name.html" "$UP/$name.html" "$f" > "$DIR/patches/$name.diff" || true
    done
    # The verdict is apps.mjs's, the same code the unit suite runs over the committed patches: it counts every line of
    # the diff body (blank ones, and content starting with - or +) and requires the one added line to be the hook.
    node "$DIR/../scripts/apps.mjs" patches || status=1   # (1, whatever node exited with: 3 means "not fetched")
    if [ "$1" = verify ]; then exit $status; fi
    ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac

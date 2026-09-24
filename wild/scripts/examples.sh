#!/bin/bash
# Vendoring helper for MapLibre's own examples (maplibre/maplibre-gl-js, BSD-3-Clause), pinned to one tag.
#
#   bash wild/scripts/examples.sh fetch <name>   download the pristine upstream file to .upstream/ and, if the
#                                                example is not vendored yet, copy it to examples/ (then add the hook line by hand)
#   bash wild/scripts/examples.sh patches        regenerate patches/<name>.diff = upstream -> vendored, for every example
#   bash wild/scripts/examples.sh verify         regenerate the patches, then fail unless each one is exactly one added line,
#                                                the hook, and nothing removed (node wild/scripts/apps.mjs patches)
#
# Upstream is fetched once into the git-ignored .upstream/ and compared against from then on: delete .upstream/ to
# compare against a fresh copy (after changing TAG, always). Needs the network + an authenticated `gh` for a fetch.
# Never run by the test suite; the suite checks the COMMITTED patches offline (apps.mjs check), not upstream itself.
set -euo pipefail
TAG=v6.10.0
DIR=$(cd "$(dirname "$0")/../maplibre-examples" && pwd -P)
mkdir -p "$DIR/.upstream" "$DIR/examples" "$DIR/patches"

fetch() {
  gh api "repos/maplibre/maplibre-gl-js/contents/test/examples/$1.html?ref=$TAG" -H "Accept: application/vnd.github.raw" > "$DIR/.upstream/$1.html"
}

case "${1:-}" in
  fetch)
    fetch "$2"
    [ -e "$DIR/examples/$2.html" ] || cp "$DIR/.upstream/$2.html" "$DIR/examples/$2.html"
    ;;
  patches | verify)
    status=0
    for f in "$DIR"/examples/*.html; do
      name=$(basename "$f" .html)
      [ -e "$DIR/.upstream/$name.html" ] || fetch "$name"
      diff -u --label "upstream/test/examples/$name.html ($TAG)" --label "wild/maplibre-examples/examples/$name.html" "$DIR/.upstream/$name.html" "$f" > "$DIR/patches/$name.diff" || true
    done
    # The verdict is apps.mjs's, the same code the unit suite runs over the committed patches: it counts every line of
    # the diff body (blank ones, and content starting with - or +) and requires the one added line to be the hook.
    node "$DIR/../scripts/apps.mjs" patches || status=$?
    if [ "$1" = verify ]; then exit $status; fi
    ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac

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
set -euo pipefail
TAG=v6.10.0
DIR=$(cd "$(dirname "$0")/../maplibre-examples" && pwd -P)
UP="$DIR/.upstream/$TAG"
mkdir -p "$UP" "$DIR/examples" "$DIR/patches"

# Into a temporary file first: a failed or interrupted fetch must not leave a partial file that later runs trust.
fetch() {
  gh api "repos/maplibre/maplibre-gl-js/contents/test/examples/$1.html?ref=$TAG" -H "Accept: application/vnd.github.raw" > "$UP/$1.html.part"
  mv "$UP/$1.html.part" "$UP/$1.html"
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
    node "$DIR/../scripts/apps.mjs" patches || status=$?
    if [ "$1" = verify ]; then exit $status; fi
    ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac

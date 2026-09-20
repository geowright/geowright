#!/bin/bash
# Vendoring helper for MapLibre's own examples (maplibre/maplibre-gl-js, BSD-3-Clause), pinned to one tag.
#
#   bash wild/scripts/examples.sh fetch <name>   download the pristine upstream file to .upstream/ and, if the
#                                                example is not vendored yet, copy it to examples/ (then add the hook line by hand)
#   bash wild/scripts/examples.sh patches        regenerate patches/<name>.diff = upstream -> vendored, for every example
#   bash wild/scripts/examples.sh verify         fail if any vendored example differs from upstream by more than added lines
#
# Needs the network + an authenticated `gh`. Never run by the test suite.
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
      removed=$(grep -c '^-[^-]' "$DIR/patches/$name.diff" || true)
      added=$(grep -c '^+[^+]' "$DIR/patches/$name.diff" || true)
      echo "$name: +$added -$removed"
      if [ "$1" = verify ] && { [ "$removed" != 0 ] || [ "$added" != 1 ]; }; then status=1; fi
    done
    exit $status
    ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac

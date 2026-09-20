#!/bin/bash
# Opt-in: cache a small REAL basemap extract outside the repo (~/.cache/geowright/openfreemap). See the .mjs for the rules.
set -euo pipefail
exec node "$(dirname "$0")/fetch-real-basemap.mjs" "$@"

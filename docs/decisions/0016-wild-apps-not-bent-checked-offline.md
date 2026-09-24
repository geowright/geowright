# 0016. Real-world apps are not bent to fit the library: what is checked, and where

- Status: Accepted
- Date: 2026-09-24
- Decided by: Shai Sinai
- Supersedes: 0010

## Decision
Applications under `wild/`, written by people other than this project's author, are tested as
their upstream authors wrote them, plus exactly one added line: the hook. Nothing else in the app
is changed to make it easier to test. (The decision of 0010, unchanged.)

## Why
0010's "enforced by" line claimed more than was checked: `examples.sh verify` covered only the
MapLibre examples, compared against a cached upstream copy it never re-fetched, did not count blank
lines or lines whose content starts with `-`/`+`, and never looked at what the one added line was;
the wrapper apps' sources were not checked at all. Pinning upstream checksums was considered and
left out for now.

## Consequences
- easy: a passing wild-app suite is evidence the library works on real code; the committed record of each app's one line is checked by the unit suite, with no network
- costs: that a vendored file equals upstream apart from the hook is verified only against a fetched upstream copy, by hand or by `examples.sh verify` — not in the suite, and not for the wrapper apps
- enforced by: `node wild/scripts/apps.mjs check` (unit suite, offline) — each MapLibre example's committed patch is one added line, the hook, and nothing removed, counting every line of the diff body, and matches the vendored file; each wrapper app's sources name `__geowright_maps` only in hook lines, at most one per file, each the line its `UPSTREAM.md` shows, in the files it marks "+1 line". `bash wild/scripts/examples.sh verify` regenerates the examples' patches from the git-ignored `.upstream/` cache (fetched from the pinned tag when missing) and applies the same patch check. Not verified offline: upstream sameness of the rest of any vendored file

## More
- 0010 (superseded), 0002 (the hook), 0015
- CONTRIBUTING.md "Do not bend third-party apps"; wild/README.md
- docs/DESIGN.md "Testing apps we did not write"

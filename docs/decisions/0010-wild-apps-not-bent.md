# 0010. Real-world apps are not bent to fit the library

- Status: Superseded by 0016
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
Applications under `wild/`, written by people other than this project's author, are tested as
their upstream authors wrote them, plus exactly one added line: the hook. Nothing else in the app
is changed to make it easier to test.

## Why
The point of testing apps this project did not write is to find real friction, not to curate away
the hard cases — bending an app to fit would quietly make that evidence worthless. When something
is awkward to test, the rule is to fix the library or write the friction down, never to edit the
app around the problem.

## Consequences
- easy: a passing wild-app suite is genuine evidence the library works on real code, not only its own demo; friction found this way has turned into real library fixes
- costs: some real apps cannot be included yet at all — for example when a dependency's license does not clear the allowlist — rather than being patched into compliance
- enforced by: `bash wild/scripts/examples.sh verify`; CONTRIBUTING.md "Do not bend third-party apps"

## More
- CONTRIBUTING.md
- README.md "Tested against apps its author did not write"
- docs/DESIGN.md "Testing apps we did not write"

# 0004. The adapter seam

- Status: Accepted
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
`src/inpage/engine.ts` imports nothing from any map library. All library-specific knowledge
lives behind an adapter seam (`src/inpage/types.ts`), and an adapter is written using only its
map library's public API — no undocumented or internal fields.

## Why
This keeps the engine (actionability, identity, matchers) reusable across map libraries without
rewriting it for each one, and keeps every adapter safe from breaking on a minor library upgrade.
Public-API-only was a deliberate choice against reading a library's private internal state for
actionability checks. It rules out any adapter shortcut that depends on undocumented internals,
and rules out engine code that only makes sense for one library's data model.

## Consequences
- easy: a second, unrelated library (sharing the same API family) needed only a thin extra adapter, not engine changes
- costs: some checks have to estimate rather than read an exact number from the library — a wrong estimate costs a retry, never a wrong action, because every candidate is still verified against the library's own hit test
- enforced by: CONTRIBUTING.md ("no underscore fields"); not enforced by an automated lint, relies on code review

## More
- CONTRIBUTING.md
- docs/DESIGN.md "The one-line hook, not auto-discovery"
- src/inpage/types.ts
- src/inpage/engine.ts

# 0003. Real input only

- Status: Accepted
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
Actions are always driven by real browser input: `page.mouse`, `page.keyboard`,
`page.touchscreen`, and CDP `Input.*` for multi-touch gestures Playwright does not expose.
`map.fire()` and synthetic DOM events are never used to drive an action.

## Why
A test that can pass by firing a synthetic event proves nothing about whether a real user's
click would work — it would still pass against a broken click handler. CDP `Input.*` counts as
real input because it is browser-level, equivalent to real hardware events, which is why it is
allowed for gestures (pinch, two-finger rotate) that Playwright's own API cannot send. This rules
out mock-map testing styles that fire fake events directly at a map's internal handlers.

## Consequences
- easy: a passing test is trustworthy evidence a real user's input would work; surfaces real gesture bugs (drag thresholds, double-click detection) that synthetic events would hide
- costs: driving draw tools needs explicit choreography (finish gesture, drag vs click-move-click) because real input is stricter than a fake event stream
- enforced by: CONTRIBUTING.md "Ground rules"; not enforced by an automated check beyond code review

## More
- CONTRIBUTING.md
- README.md
- docs/DESIGN.md "Actionability: what click a feature has to verify"

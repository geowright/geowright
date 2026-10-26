# 0027. The 1.0 in-page API is queries plus an action protocol

- Status: Proposed
- Date: 2026-10-26
- Decided by: Pending maintainer review

## Decision
What `window.__geowright` freezes at 1.0 is the queries and an action protocol, not queries only. An action starts
with `begin(mapId, action, query, opts)` and continues with `next(mapId, token, outcome)`; each call returns one step:
`input` (the real input to send) or `wait` (how long to sleep), each with a `then` token to pass to `next`, or `done`
or `fail` (with `afterInput`: never resend). The binding only sends real input (0003) and keeps the clock. The same contract carries which layers the app added: the
seam gets an optional adapter member for it, and the basemap heuristic is used only when an adapter cannot say.

## Why
Queries only would freeze today's split, where the Node side leads every action (aim, arm, input, disarm, retry,
learn the aim). Every runner or language would then port about 1,200 lines of orchestration, and Cypress's command
queue and a Python or Java binding pay that most. With the protocol a binding is a loop of about 60 lines. Adding the
protocol after 1.0 needs a major version, so this is a one-way door either way. The clock stays outside because a
busy page cannot be trusted to keep time. App layers are told from basemap layers today by a guess (on a tiled source with
many layers, a layer is taken for basemap when another layer of its type is there too; the only one of its type is the
app's); the adapter knows, so the contract should ask it.
This rules out a 1.0 that exposes only queries and arm/disarm calls.

## Consequences
- easy: a second runner (Puppeteer, then WebDriver BiDi, 0026) or a language binding is a short loop, not a port;
  Cypress becomes a recursive `cy.then` chain if users ask for it.
- costs: the in-page API to freeze is larger; action state lives in the page and is lost on navigation (already true
  of an armed check); error text moves into the page bundle; the Playwright binding is rewritten onto the loop in 0.x.
- not enforced by a check yet; once accepted, the conformance suite (0026) drives every driver through the loop only.

## More
- docs/DESIGN.md "Drivers and map libraries" (the action protocol, the app-layer report)
- 0002 (the hook), 0003 (real input), 0004 (the seam), 0019 and 0022 (what an action verifies), 0026 (drivers)
- `src/inpage/index.ts` (the in-page API), `src/inpage/types.ts` (the seam), `src/inpage/engine.ts` (`isBasemap`)

# 0024. Keep the Mapbox 1.13 mid-fetch idle limit until a public completion signal is proven

- Status: Proposed
- Date: 2026-10-12
- Decided by: Pending maintainer review
- Scope: Design only; no runtime, public API or support-claim change

## Decision
Retain the documented Mapbox GL JS 1.13 limitation and caller readiness workaround for now.
Evaluate public source events first, then narrowly scoped Playwright request tracking, before
promising automatic protection against mid-fetch absence verdicts. Neither approach is proven
by this record. Do not infer completion from a fixed delay or balanced start/end event counts.

This proposal addresses audit finding C-1 and the limitation recorded with the W1 wave. It does not supersede the
accepted public-adapter seam (0004), supported-version decision (0011), or deterministic-test
decision (0021), and does not reopen the sustained replacement-loop policy.

## Why
An absence verdict can be wrong even when Mapbox reports an idle map. After `setData(empty)`
followed by `setData(url)` while the first update is loading, the first completion can report
the source loaded before the URL response arrives. Waiting for idle again uses the same
unreliable signal. Presence remains useful evidence; absence and counts need stronger readiness.

### Verified by reading this checkout

These are repository facts, including earlier measurements recorded there, not measurements
reproduced during this design work. References use the unchanged checkout's line numbers.

- `README.md:341–344` documents the clear-then-load limit, premature `.not` or count success,
  and waiting for something the app shows once its data is in; it states MapLibre 2–6 are unaffected.
- `docs/DESIGN.md:1197–1204` records idle about **19 ms** after the two calls with
  `isSourceLoaded` true while the URL is still fetching. It attributes this to a single loaded
  flag and a worker-queued second load, notes no `getData()` on 1.13 and unbalanced events for
  abandoned loads, and identifies the compat `test.fixme`. These are recorded findings.
- `tests/compat/compat.spec.ts:517–555` covers both **clear, then load** and **a URL, then another**.
  Its comments record 19 ms and 16 ms respectively (`:523–526`); both are marked `test.fixme`
  only for `mapbox-gl-1` (`:529`). The second URL is fulfilled with feature X after a simulated
  slow response (`:532–535`). The assertion must reject absence, and X must subsequently appear
  (`:551–554`). Reading a skipped regression is not evidence that it passed.
- `src/inpage/maplibre-adapter.ts:307–369` subscribes to public `sourcedataloading` and
  `sourcedata` during each idle wait, tracks replacements for diagnosis, and accepts `idle`
  if `areTilesLoaded()` permits it (`:361–365`). Tracking starts is already present; it does
  not establish that the newest URL has finished. Comments at `:313–319` explain abandoned
  updates and why event-time data matters on MapLibre 5–6.
- `src/playwright/index.ts:1339–1353` treats idle or a never-idle diagnosis as settled;
  `:1425–1431` requires settling for feature counts in both polarities.
  `docs/DESIGN.md:768–781` distinguishes finite server loads from sustained replacement loops.
  Blocking all outstanding network requests would change that existing loop policy.
- `tests/compat/compat.spec.ts:25–32` installs the shared network guard and fixture routes.
  `tests/fixtures.ts:14–25` uses context routing with `fallback()`; page fixture routes take
  precedence. `playwright.compat.config.ts:24` blocks service workers because they bypass routes.
  A route observer must coexist with these fixtures rather than replace or consume them.
- `package.json` pins the Mapbox alias to 1.13.3 and has a typecheck script, but no lint script.
  Decision numbers 0001–0023 are occupied; 0024 is the next free number.

### NOT verified

- The live issue threads, external API documentation, library internals, or a new browser event
  trace were not consulted. The 19 ms / 16 ms timings and worker explanation above were read,
  not independently reproduced. They are examples, not deadlines or timing guarantees.
- No proof that public `dataloading` / `sourcedataloading` / `sourcedata` distinguishes every
  superseded, queued, failed or cancelled URL generation on 1.13. In particular, a data event
  or `isSourceLoaded` true must not automatically clear a pending generation.
- No proof that Playwright observes all relevant worker requests, cached responses, redirects,
  transformed URLs, or a request already running when geowright attaches; no reliable mapping
  from request to map/source generation has been demonstrated here.
- No runtime fix, compat run, repeat-20 flake result or performance measurement is supplied.
  Offline document checks and typecheck results belong in this change's report.

## Options and consequences

### A. Track relevant requests through public Playwright network APIs / page.route

Observe requests before the triggering update, keyed by request identity rather than URL alone.
Match only the intended GeoJSON source requests; handle completion, failure, cancellation and
redirects. Use the caller's existing fixture route where practical; adding library-owned routing
would need to preserve route precedence and fallback. Network completion is a prerequisite,
not proof of rendering: obtain a fresh map settle/render observation after completion.

- **Cost:** cross-layer state between Playwright and the in-page adapter, listener teardown,
  URL/source attribution, multiple maps, and deadline handling. All-page network idle would
  couple map assertions to unrelated polling and still miss queued work before a request starts.
- **Flakiness risk:** observing too late misses requests; clearing at `response` rather than body
  completion permits another early verdict; cache/service-worker and URL transformations need
  evidence. Same-URL requests and late completions from obsolete generations must not clear newer work.
- **Public API impact:** potentially none if automatic coverage is provable. Otherwise it needs
  explicit caller registration/readiness and an honest opt-in contract, with README API table and
  CHANGELOG updates. A Playwright-only fix would leave the direct in-page/agent path unprotected.

### B. Track public source loading/data events in the adapter

Inspect the real `dataloading` / `sourcedataloading` / `sourcedata` sequence and public payloads
on 1.13. Prefer this only if they identify readiness of the newest update without private fields,
wrapping `setData`, or requiring an app-hook change. Attach before the operation for the experiment;
then separately test attaching after it, as users can attach to an already-open page (0002).

- **Cost:** adapter lifecycle state across waits, source removal/re-addition and style replacement;
  proof of generation attribution, event ordering and cleanup on every supported version.
- **Flakiness risk:** abandoned updates do not necessarily emit a balancing completion; a counter
  can remain pending forever or clear on the first completion while the second fetch continues.
  Tile events must not count as replacement completion. A quiet-event grace period is only a guess.
- **Public API impact:** no new public API if it works entirely behind the seam; coverage would
  include direct in-page consumers. An app-issued completion token would be a different API proposal.
  Current evidence makes a simple increment/decrement counter unsuitable.

### C. Require caller readiness for this operation

Keep assertions unchanged and have the caller wait for a visible app ready state tied to the
newest load, or positively assert a feature unique to that result before asserting absence/counts.
Waiting for an arbitrary old feature, a generic response alone, or `waitForIdle()` is insufficient.

- **Cost:** each affected test must know when the application's latest result is actually applied.
  Apps without a trustworthy ready signal need their own test-level coordination.
- **Flakiness risk:** low with generation-specific readiness; stale ready flags can recreate the
  race. Fixed sleeps merely hide it. This is a workaround, not general automatic protection.
- **Public API impact:** none for documented caller sequencing. Adding a readiness callback or
  making it mandatory would add outward-facing API and requires a separate implementation decision.

### D. Keep only the documented limit

- **Cost:** smallest implementation cost, but affected absence/count assertions can remain false
  positives unless callers follow C. Documentation does not enforce safety.
- **Flakiness risk:** the known ordering hazard remains; fast local responses can conceal it.
- **Public API impact:** none; retain the narrow Mapbox support exception and skipped regression.

### Recommendation

Use **D with C's existing workaround now**, and make **B the first bounded experiment** because
it stays within the adapter and protects every consumer if proven. If event traces cannot identify
the newest completion, reject B rather than guess, and evaluate A as a scoped Playwright option.
A has more integration cost and cannot alone justify removing the limit for all consumers.
No option is approved for implementation by this Proposed design. The benefit of automatic
waiting must be demonstrated against cancellation and supersession, not just the happy path.

## Tests that would prove an implementation

All responses must use local fixtures; observe real map events rather than synthesizing them.

1. Reproduce the two cases at `tests/compat/compat.spec.ts:517–555` on 1.13.3 before changing
   runtime code. In the implementation change, remove the Mapbox `test.fixme` only if both reject
   premature absence and still prove X arrives. The same tests must fail against the old runtime.
2. Add a deferred route with an explicit release gate: after observing the request and the early
   idle, keep the body withheld through a bounded assertion deadline. `.not.toHaveFeature(X)`
   and count 0 must fail with no settled verdict; release in `finally`, then prove X is visible
   and count 1 succeeds. Include negated counts and a successful absence after genuinely empty
   final data. Use event/gate coordination, not a sleep tuned to 19 ms.
3. Trace public events plus network request identity through clear/load, two URLs, three finite
   replacements, same-URL replacement, aborted/failed requests, and supersession. Neither the
   first completion nor an obsolete response may settle newer work; no stale pending state may
   block future successful loads. Define failure behavior explicitly as no verdict when readiness
   remains unknown, rather than silently equating a transport error with an empty source.
4. Test attach-after-start, source removal/re-addition with the same id, style replacement,
   multiple maps/sources and teardown. For A, also cover redirects, cached responses, existing
   route fixtures/guard precedence and unrelated long-lived requests; explicitly document any
   service-worker or pre-attachment coverage restriction rather than claim universal coverage.
5. Cover the shared settling paths: negative visibility, geometry and popup-feature assertions
   where absence needs settling, plus counts in both polarities. Preserve positive presence,
   ordinary idle-map latency, animated maps and the accepted sustained replacement-loop policy;
   pending finite loads must not be relabelled never idle to let `.not` pass.
6. Run the focused compat cases, then the whole compat matrix and core suite with typecheck.
   Run affected timing specs with `--repeat-each=20`, zero flakes/retries; measure under software
   GL and `GEOWRIGHT_CPU_THROTTLE=4`. A browser trace establishes ordering, not a universal timing
   bound. Update support claims only to the coverage actually demonstrated.

## What remains documented if nothing is built

Keep README Limits (`README.md:341–344`) and the supported-version exception, DESIGN's known
limitation (`docs/DESIGN.md:1197–1204`), and both Mapbox compat `test.fixme` cases. The 1.13
support claim remains qualified: overlapping GeoJSON updates can make `.not` and counts conclude
before the newest URL data arrives. Keep caller readiness advice; do not advertise network-idle,
event counting, longer timeouts or another idle wait as a fix. This record adds design rationale,
not evidence that the limitation was removed.

## More

- [Adapter seam](0004-the-adapter-seam.md), [supported libraries](0011-supported-map-libraries.md),
  [deterministic tests](0021-deterministic-tests-guard-on-every-page.md)
- [DESIGN](../DESIGN.md#costs-and-known-limitations), [README Limits](../../README.md#limits)

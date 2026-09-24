/**
 * The prelude of every code example in README.md and docs/RECIPES.md (see tests/docs/examples.ts).
 *
 * An example runs as the body of `test('…', async ({ page, map }) => { <example> })` with these in scope:
 *  - `page`   the demo app (demo/), loaded, every request answered locally (tests/fixtures.ts);
 *  - `map`    `geowright(page)` for the demo's map, idle. An example may declare its own `map`; it shadows this one;
 *  - `expect` geowright's `expect` (Playwright's, plus the map matchers), unless the example imports its own;
 *  - `test`   for `test.use(…)`, which the check hoists to the example's describe block;
 *  - `buildingsGeoJSON` a GeoJSON FeatureCollection: the demo's vector-tile buildings (tests/buildings.ts), where an
 *    example says "your fixture".
 * Everything else an example uses, it declares or imports itself — so a reader can copy it.
 * A name added here is also added to PRELUDE in tests/docs/examples.ts.
 */
export { test, expect } from '../fixtures';
export { BUILDINGS as buildingsGeoJSON } from '../buildings';

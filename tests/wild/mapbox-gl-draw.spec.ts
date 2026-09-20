import { brightBasemap } from './basemap';
import { example, expect, test, type Routes } from './harness';
import { fileURLToPath } from 'node:url';

// MapLibre example "Draw polygon with mapbox-gl-draw": mapbox-gl-draw (@mapbox/mapbox-gl-draw@1.5.0
// from unpkg) + turf, loaded as an ES module from esm.sh (`import * as turf from
// 'https://esm.sh/@turf/turf@7.1.0'`).
//
// node_modules has @mapbox/mapbox-gl-draw@1.5.2 (not 1.5.0): routed the unpkg JS/CSS URLs to that
// absolute path (see MAPBOX_GL_DRAW below) — a newer patch of the same 1.5.x line the example asks for.
//
// STOPPED HERE: the turf import cannot be satisfied.
// `import * as turf from 'https://esm.sh/@turf/turf@7.1.0'` is a real ES module import at the top of
// the page's <script type="module">; when the request for that URL is unrouted (aborted, per this
// repo's no-network rule), that import rejects and the WHOLE module script never runs —
// `const map = new maplibregl.Map(...)` included. Confirmed directly: with everything else routed
// (mapbox-gl-draw JS/CSS, the basemap) and only the esm.sh URL left unrouted/tolerated,
// `window.__geowright_maps.main` never gets set at all after the page settles — the map object itself
// is never constructed. This is the "cannot be made to load at all" case in the brief's hard limits.
// Per the brief: checked whether the @turf/turf npm package itself ships a single self-contained ESM
// bundle we could vendor instead of esm.sh. It does not:
//   - `npm view @turf/turf@7.1.0 dist` / the unpkg file listing for @turf/turf@7.1.0 show only 4 files:
//     dist/ (a folder), LICENSE, README.md, package.json — and inside dist/ only dist/cjs/ and dist/esm/.
//   - package.json: "module": "dist/esm/index.js", but that file is NOT self-contained — its first ~80
//     lines alone are `import { x } from "@turf/along"`, `"@turf/angle"`, `"@turf/area"`, ... one bare
//     specifier per turf function, dozens of separate `@turf/*` packages. None of those are npm
//     dependencies of @turf/turf (turf is a monorepo of ~150 standalone packages); resolving the ESM
//     entry point would mean downloading dozens of further packages (themselves possibly importing
//     still more @turf/* packages) and hand-writing an import map for all of them — not "a single
//     self-contained file", and well past "download only, no npm install".
//   - The ONLY self-contained file the package ships is `turf.min.js` (`"browser": "turf.min.js"` in
//     package.json) — but that is a UMD/global bundle (sets `window.turf`), not an ES module; it cannot
//     satisfy `import * as turf from '...'` without editing the example's script (not allowed: "change
//     NOTHING else").
// What WOULD be needed: either (a) esm.sh itself (or an equivalent bundling redirector) reachable at
// test time — not "no network in tests" — or (b) vendoring turf's ~150 individual `@turf/*` packages
// plus an import map rewriting every bare `@turf/*` specifier to a local file, which is far beyond "one
// exact file, license-checked, downloaded by hand".
const MAPBOX_GL_DRAW = fileURLToPath(new URL('../../node_modules/@mapbox/mapbox-gl-draw/dist/', import.meta.url));
const routes: Routes = [
  ...brightBasemap([-91.874, 42.76]),
  ['https://www.unpkg.com/@mapbox/mapbox-gl-draw@1.5.0/dist/mapbox-gl-draw.js', MAPBOX_GL_DRAW + 'mapbox-gl-draw.js'],
  ['https://www.unpkg.com/@mapbox/mapbox-gl-draw@1.5.0/dist/mapbox-gl-draw.css', MAPBOX_GL_DRAW + 'mapbox-gl-draw.css'],
];

test.describe('wild: draw-polygon-with-mapbox-gl-draw', () => {
  test.fixme(
    'the page cannot be made to load: `import … from esm.sh/@turf/turf@7.1.0` has no single-file, no-network, no-npm-install substitute (see comment above)',
    async ({ wild }) => {
      const map = await wild.open(example('draw-polygon-with-mapbox-gl-draw'), { routes });
      await expect(map).toHaveFeature({ layer: 'gl-draw-polygon-fill-inactive.cold' });
    },
  );
});

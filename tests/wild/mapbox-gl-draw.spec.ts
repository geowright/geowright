import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { brightBasemap } from './basemap';
import { example, expect, test, type Routes } from './harness';

// MapLibre example "Draw polygon with mapbox-gl-draw": @mapbox/mapbox-gl-draw 1.5.0 from unpkg (a classic
// script) + turf as an ES MODULE from esm.sh (`import * as turf from 'https://esm.sh/@turf/turf@7.1.0'`).
//
// Fixtures: mapbox-gl-draw comes from node_modules (1.5.2 — same 1.5.x line). turf was the hard one: the
// example run stopped here ("cannot be made to load": esm.sh serves a module graph, and the npm package's
// ESM entry imports ~150 separate @turf/* packages). The only self-contained file turf ships is the UMD
// bundle `turf.min.js` (MIT, already vendored for measure-distances). So the esm.sh URL is answered with
// that REAL bundle wrapped as a module: the UMD text, then `export const { area, … } = globalThis.turf` with
// the export names read from the bundle itself. Real turf code (7.4 rather than 7.1), nothing hand-written.
const MAPBOX_GL_DRAW = fileURLToPath(new URL('../../node_modules/@mapbox/mapbox-gl-draw/dist/', import.meta.url));
const TURF_UMD = fileURLToPath(new URL('../../wild/fixtures/vendor/turf@7/turf.min.js', import.meta.url));

let turfModule: Promise<string> | undefined;
const turfAsEsModule = () =>
  (turfModule ??= (async () => {
    const umd = await readFile(TURF_UMD, 'utf8');
    const sandbox: { turf?: Record<string, unknown> } = {};
    vm.runInNewContext(umd, { self: sandbox, globalThis: sandbox, window: sandbox });
    const names = Object.keys(sandbox.turf ?? {}).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== 'default');
    if (!names.includes('area')) throw new Error('turf UMD bundle did not expose its API as expected');
    return `${umd}\nconst __turf = globalThis.turf;\nexport const { ${names.join(', ')} } = __turf;\nexport default __turf;\n`;
  })());

const CENTER: [number, number] = [-91.874, 42.76];
const routes: Routes = [
  ...brightBasemap(CENTER),
  ['https://www.unpkg.com/@mapbox/mapbox-gl-draw@1.5.0/dist/mapbox-gl-draw.js', MAPBOX_GL_DRAW + 'mapbox-gl-draw.js'],
  ['https://www.unpkg.com/@mapbox/mapbox-gl-draw@1.5.0/dist/mapbox-gl-draw.css', MAPBOX_GL_DRAW + 'mapbox-gl-draw.css'],
  ['https://esm.sh/@turf/turf@7.1.0', async (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'text/javascript', body: await turfAsEsModule() })],
];

// A ~1.1 km square around the map centre (zoom 12 in the example).
const d = 0.005;
const SQUARE = [
  { lng: CENTER[0] - d, lat: CENTER[1] - d },
  { lng: CENTER[0] + d, lat: CENTER[1] - d },
  { lng: CENTER[0] + d, lat: CENTER[1] + d },
  { lng: CENTER[0] - d, lat: CENTER[1] + d },
];
const FILL = ['gl-draw-polygon-fill-inactive.cold', 'gl-draw-polygon-fill-active.hot', 'gl-draw-polygon-fill-inactive.hot', 'gl-draw-polygon-fill-active.cold'];

test.describe('wild: draw-polygon-with-mapbox-gl-draw', () => {
  test('drawing a polygon with the control shows its area, computed by turf', async ({ wild, page }) => {
    const map = await wild.open(example('draw-polygon-with-mapbox-gl-draw'), { routes });
    await page.locator('button.mapbox-gl-draw_polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'dblclick' });
    await expect(map.feature({ layer: FILL })).toHaveGeometry(SQUARE, { tolerancePx: 2 });
    // 0.01° x 0.01° at 42.76°N ≈ 1113 m x 817 m ≈ 0.909 km²
    const text = await page.locator('#calculated-area').innerText();
    const m2 = Number(/([\d.]+)/.exec(text.replace(/,/g, ''))![1]);
    expect(m2).toBeGreaterThan(880_000);
    expect(m2).toBeLessThan(940_000);
  });

  test('the trash button deletes the selected polygon and the area read-out goes away', async ({ wild, page }) => {
    const map = await wild.open(example('draw-polygon-with-mapbox-gl-draw'), { routes });
    await page.locator('button.mapbox-gl-draw_polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'dblclick' });
    // Real input, real tool behaviour: the SECOND click of the finishing double-click lands on the new polygon and
    // puts mapbox-gl-draw into direct_select (vertex editing), where the trash button only deletes selected
    // vertices — for a real user too. So: click away (deselect), click the polygon (select it), then trash.
    await map.clickAt({ lng: CENTER[0] + 0.02, lat: CENTER[1] + 0.012 });
    await expect(map).toHaveFeature({ layer: FILL, where: { active: 'false' } });
    await map.feature({ layer: FILL }).click();
    await expect(map).toHaveFeature({ layer: FILL, where: { active: 'true' } });
    await page.locator('button.mapbox-gl-draw_trash').click();
    await expect(map).not.toHaveFeature({ layer: FILL });
    await expect(page.locator('#calculated-area')).toBeEmpty();
  });
});

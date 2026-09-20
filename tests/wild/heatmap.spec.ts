import type { MapHandle } from '../../src/playwright';
import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Create a heatmap layer": earthquakes rendered as a heatmap ('earthquakes-heat',
// maxzoom 9), fading into a circle layer ('earthquakes-point', minzoom 7) as you zoom in
// (heatmap-opacity 1->0 and circle-opacity 0->1, both over zoom 7-9/7-8). Neither layer has a click
// or hover handler in the app.
const routes: Routes = [
  ...DEMOTILES,
  ['https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson', 'earthquakes.geojson'],
];

// mag 7.1, in the initial viewport (center [-120, 50], zoom 2).
const bigQuake = { lng: -98.4952, lat: 18.5539 };
const bigQuakeQuery = { where: { id: 'us2000ar20' } };

// Double-click zooms in exactly one level per call (README: "double-click zooms in one level").
// waitForIdle gets a generous budget: this suite is exercised alongside other agents' Playwright
// runs on one shared machine, and a chain of N idle-waits multiplies the chance any single one
// lands on a slow frame — a real wait-until-idle, just with more headroom, not a fixed sleep.
async function zoomInOn(map: MapHandle, at: { lng: number; lat: number }, times: number) {
  for (let i = 0; i < times; i++) {
    await map.dblclickAt(at);
    await map.waitForIdle({ timeout: 20000 });
  }
}

test.describe('wild: create-a-heatmap-layer', () => {
  test('the heatmap layer is addressable at the initial zoom; the circle layer is not drawn yet (minzoom 7)', async ({ wild }) => {
    const map = await wild.open(example('create-a-heatmap-layer'), { routes });
    await expect(map).toHaveFeature({ layer: 'earthquakes-heat', ...bigQuakeQuery });
    const quake = await map.feature({ layer: 'earthquakes-heat', ...bigQuakeQuery }).info();
    expect(quake.properties.mag).toBe(7.1);
    await expect(map.features({ layer: 'earthquakes-point' })).toHaveFeatureCount(0);
  });

  // geowright has no per-feature visibility rule for `heatmap` layers (maplibre-paint.ts's switch has
  // no 'heatmap' case, so it falls to the safe default: "counts as visible — never a false invisible").
  // toHaveFeature therefore cannot tell a dense hot spot from a lone point about to fade past maxzoom;
  // only the pixel probe (toBeVisibleOnMap) proves paint actually reached the canvas. FRICTION: this is
  // a real gap for a team testing a heatmap-only page (no fallback circle layer) at its fade-out edge.
  test('toHaveFeature calls a heatmap point visible unconditionally; toBeVisibleOnMap proves it actually painted something', async ({ wild }) => {
    const map = await wild.open(example('create-a-heatmap-layer'), { routes });
    const quake = map.feature({ layer: 'earthquakes-heat', ...bigQuakeQuery });
    expect((await quake.info()).visible).toBe(true);
    await expect(quake).toBeVisibleOnMap();
  });

  test('zooming in on a quake crosses the heatmap-to-circle handoff: at zoom 8 both layers draw it', async ({ wild }) => {
    const map = await wild.open(example('create-a-heatmap-layer'), { routes });
    await zoomInOn(map, bigQuake, 6);
    await expect(map).toHaveView({ zoom: 8 });
    await expect(map).toHaveFeature({ layer: 'earthquakes-heat', ...bigQuakeQuery });
    await expect(map).toHaveFeature({ layer: 'earthquakes-point', ...bigQuakeQuery });
  });

  test('past the heatmap layer maxzoom (9) it stops rendering; the circle layer (no maxzoom) keeps drawing', async ({ wild }) => {
    const map = await wild.open(example('create-a-heatmap-layer'), { routes });
    await zoomInOn(map, bigQuake, 7);
    await expect(map).toHaveView({ zoom: 9 });
    await expect(map).not.toHaveFeature({ layer: 'earthquakes-heat', ...bigQuakeQuery });
    await expect(map).toHaveFeature({ layer: 'earthquakes-point', ...bigQuakeQuery });
  });

  test('the text snapshot lists heatmap entities without a colour, unlike the circle layer once it appears', async ({ wild }) => {
    const map = await wild.open(example('create-a-heatmap-layer'), { routes });
    const atZoom2 = await map.snapshot({ layers: ['earthquakes-heat'] });
    expect(atZoom2).toMatch(/\[earthquakes-heat\] \d+ heatmap entities/);
    expect(atZoom2).not.toMatch(/Point @\([^)]+\) drawn/); // no paintColour case for 'heatmap': no per-point colour reported
    expect(atZoom2).not.toContain('-color is data-driven');

    await zoomInOn(map, bigQuake, 6);
    const atZoom8 = await map.snapshot({ layers: ['earthquakes-point'] });
    expect(atZoom8).toContain('circle-color is data-driven');
    expect(atZoom8).toMatch(/drawn (red|blue)/);
  });
});

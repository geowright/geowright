import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * Failures that EXPLAIN invisibility: when the style hides a feature or a whole layer, the failure
 * message names the layer, the style property, its value, the expression branch that produced it, and the zoom.
 * The demo is at zoom 12. Each test adds one layer over two polygons near the centre: #1 kind "park", #2 kind "forest".
 */
const WHY = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 1, properties: { kind: 'park' }, geometry: { type: 'Polygon', coordinates: [[[34.76, 32.07], [34.775, 32.07], [34.775, 32.085], [34.76, 32.085], [34.76, 32.07]]] } },
    { type: 'Feature', id: 2, properties: { kind: 'forest' }, geometry: { type: 'Polygon', coordinates: [[[34.785, 32.07], [34.8, 32.07], [34.8, 32.085], [34.785, 32.085], [34.785, 32.07]]] } },
  ],
};

async function addLayer(page: Page, layer: Record<string, unknown>, globalState?: Record<string, unknown>) {
  await page.evaluate(
    ({ data, layer, globalState }) => {
      const m = (window as any).__geowright_maps.main;
      for (const [k, v] of Object.entries(globalState ?? {})) m.setGlobalStateProperty(k, v);
      m.addSource('why', { type: 'geojson', data });
      m.addLayer({ id: 'why', source: 'why', ...layer });
    },
    { data: WHY, layer, globalState },
  );
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

test.describe('failures explain invisibility', () => {
  test('data-driven: the match on a property took its fallback', async ({ map, page }) => {
    await addLayer(page, { type: 'fill', paint: { 'fill-color': '#2e7d32', 'fill-opacity': ['match', ['get', 'kind'], 'forest', 0.7, 0] } });
    await expect(map.feature({ layer: 'why', id: 2 })).toBeVisibleOnMap({ pixels: false });
    const msg = await failure(expect(map.feature({ layer: 'why', id: 1 })).toBeVisibleOnMap({ timeout: 800 }));
    expect(msg).toContain('Received: paint: fill-opacity evaluates to 0');
    expect(msg).toContain('-> why#1 is not visible at zoom 12: fill-opacity is 0 because the match on ["get","kind"] took its fallback for kind="park"');
  });

  test('data-driven: the case took the branch whose condition was true', async ({ map, page }) => {
    await addLayer(page, { type: 'fill', paint: { 'fill-color': ['case', ['==', ['get', 'kind'], 'park'], 'rgba(0,0,0,0)', '#6d4c41'] } });
    await expect(map).toHaveFeature({ layer: 'why', id: 2 });
    const msg = await failure(expect(map).toHaveFeature({ layer: 'why', where: { kind: 'park' } }, { timeout: 800 }));
    expect(msg).toContain('1 feature(s) match but are NOT VISIBLE: why#1 (fill-color is fully transparent');
    expect(msg).toContain('-> why#1 is not visible at zoom 12: fill-color is "rgba(0,0,0,0)" because the case took its branch 1 (the first true condition: ["==",["get","kind"],"park"])');
  });

  test('zoom-driven: the step on zoom used the stop at 12', async ({ map, page }) => {
    await addLayer(page, { type: 'fill', paint: { 'fill-color': '#1565c0', 'fill-opacity': ['step', ['zoom'], 0.8, 12, 0] } });
    await expect(map).toHaveFeature({ layer: 'why', id: 1, visible: 'any' });
    const msg = await failure(expect(map.feature({ layer: 'why', id: 1 })).toBeVisibleOnMap({ timeout: 800 }));
    expect(msg).toContain('-> why#1 is not visible at zoom 12: fill-opacity is 0 because the step on zoom used the stop at 12 (zoom 12)');
  });

  test('zoom-driven: an interpolate on zoom, below its first stop, is clamped to it', async ({ map, page }) => {
    await addLayer(page, { type: 'line', paint: { 'line-color': '#c62828', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0, 16, 6] } });
    await expect(map).toHaveFeature({ layer: 'why', id: 1, visible: 'any' });
    const msg = await failure(map.feature({ layer: 'why', id: 1 }).click({ timeout: FAIL_FAST_MS }));
    expect(msg).toContain('invisible: feature is rendered but not visible: line-width evaluates to 0');
    expect(msg).toContain('-> why#1 is not visible at zoom 12: line-width is 0 because the interpolate on zoom used its stop at 13 (zoom 12;');
  });

  test('zoom range: a layer below its minzoom, or at its maxzoom, is not drawn', async ({ map, page }) => {
    await addLayer(page, { type: 'fill', minzoom: 13, paint: { 'fill-color': '#2e7d32' } });
    const below = await failure(expect(map).toHaveFeature({ layer: 'why', id: 1 }, { timeout: 800 }));
    expect(below).toContain('layer "why" is not drawn at zoom 12: its minzoom is 13 (drawn from zoom 13)');

    await page.evaluate(() => (window as any).__geowright_maps.main.setLayerZoomRange('why', 0, 12));
    const at = await failure(expect(map.feature({ layer: 'why', id: 1 })).toBeVisibleOnMap({ timeout: 800 }));
    expect(at).toContain('layer "why" is not drawn at zoom 12: its maxzoom is 12 (drawn below zoom 12 only)');

    await page.evaluate(() => (window as any).__geowright_maps.main.setLayerZoomRange('why', 0, 24));
    await expect(map.feature({ layer: 'why', id: 1 })).toBeVisibleOnMap({ pixels: false });
  });

  test('visibility "none": a constant, or an expression on global state', async ({ map, page }) => {
    await addLayer(page, { type: 'fill', layout: { visibility: 'none' }, paint: { 'fill-color': '#2e7d32' } });
    const constant = await failure(expect(map).toHaveFeature({ layer: 'why', id: 1 }, { timeout: 800 }));
    expect(constant).toContain('layer "why" is not drawn at zoom 12: layout property visibility is "none" (a constant in the style)');

    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.setGlobalStateProperty('showWhy', false);
      m.setLayoutProperty('why', 'visibility', ['case', ['global-state', 'showWhy'], 'visible', 'none']);
    });
    const expression = await failure(expect(map).toHaveFeature({ layer: 'why', id: 1 }, { timeout: 800 }));
    expect(expression).toContain('layer "why" is not drawn at zoom 12: layout property visibility is "none" because the case took its fallback (no condition was true)');

    await page.evaluate(() => (window as any).__geowright_maps.main.setGlobalStateProperty('showWhy', true));
    await expect(map).toHaveFeature({ layer: 'why', id: 1 });
  });

  test('a layer hidden by a visibility expression is hidden in the layer list and the snapshot', async ({ map, page }) => {
    // The layer list compared visibility with the constant "none", so a layer hidden through global state counted as visible.
    await addLayer(page, { type: 'fill', layout: { visibility: ['case', ['global-state', 'showWhy'], 'visible', 'none'] }, paint: { 'fill-color': '#2e7d32' } }, { showWhy: false });
    await expect(map).not.toHaveFeature({ layer: 'why', visible: 'any' });
    expect((await map.layers()).find((l) => l.id === 'why')?.visible).toBe(false);
    const hidden = await map.snapshot();
    expect(hidden).toMatch(/^hidden layers: .*\bwhy\b/m);
    expect(hidden).not.toMatch(/^visible but empty in this view: .*\bwhy\b/m);

    await page.evaluate(() => (window as any).__geowright_maps.main.setGlobalStateProperty('showWhy', true));
    await expect(map).toHaveFeature({ layer: 'why', id: 1 });
    expect((await map.layers()).find((l) => l.id === 'why')?.visible).toBe(true);
    expect(await map.snapshot()).toMatch(/^layers with content, top to bottom: .*\bwhy\(fill,geojson\)/m);
  });
});

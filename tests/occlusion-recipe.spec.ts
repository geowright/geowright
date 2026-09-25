import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import type { MapHandle } from '../src/playwright';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * docs/RECIPES.md, "A raster or image layer is drawn over my features": the recipe, run against the three states an
 * app's overlay can be in when the test acts — up, hidden, and removed. (The docs example itself runs against the demo,
 * which has no overlay.) Keep `recipe` the same code as the docs block.
 */
async function recipe(map: MapHandle, timeout?: number): Promise<void> {
  const alert = map.feature({ layer: 'alerts', id: 1 });
  const at = await alert.lngLat(); // where click() will press: on a line or a polygon, not just any point of it
  if ((await map.layers()).some((l) => l.id === 'veil')) {
    await expect(map).not.toHaveLayerPixels('veil', { at, timeout }); // hidden, or painting nothing there
  }
  await alert.click();
}

/** An opaque image layer over the whole view, drawn above everything: a loading veil. */
async function veil(page: Page, map: MapHandle): Promise<void> {
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const g = c.getContext('2d')!; g.fillStyle = '#888'; g.fillRect(0, 0, 4, 4);
    const b = m.getBounds();
    m.addSource('veil', { type: 'image', url: c.toDataURL(), coordinates: [[b.getWest(), b.getNorth()], [b.getEast(), b.getNorth()], [b.getEast(), b.getSouth()], [b.getWest(), b.getSouth()]] });
    m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } });
  });
  await expect(map).toHaveLayerPixels('veil', { at: await map.feature({ layer: 'alerts', id: 1 }).lngLat() }); // it is up
}

test('with the overlay up, the recipe stops before the click', async ({ map, page }) => {
  await veil(page, map);
  const e = await recipe(map, FAIL_FAST_MS).then(() => null, (e: Error) => e);
  expect(e?.message).toContain('toHaveLayerPixels');
  await expect(page.getByTestId('popup')).toHaveCount(0); // nothing was clicked
});

test('with the overlay hidden, the recipe clicks', async ({ map, page }) => {
  await veil(page, map);
  await page.evaluate(() => (window as any).__geowright_maps.main.setLayoutProperty('veil', 'visibility', 'none'));
  await recipe(map);
  await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 } });
});

test('with the overlay removed (removeLayer), the recipe clicks', async ({ map, page }) => {
  await veil(page, map);
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    m.removeLayer('veil'); // loading done: the app takes its veil away, as terra-draw does with its layers
    m.removeSource('veil');
  });
  await recipe(map);
  await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 } });
});

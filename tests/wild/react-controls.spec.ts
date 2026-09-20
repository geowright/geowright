import { cartoBasemap } from './basemap';
import { expect, test } from './harness';

// visgl/react-map-gl example "controls": 20 React-rendered <Marker>s (SVG pins, anchor "bottom"), a <Popup>
// driven by React state, and the stock MapLibre controls. Nothing is on the canvas except the basemap.
const routes = cartoBasemap('dark-matter', [-100, 40]);
const APP = '/apps/react-map-gl/controls/';
const CHICAGO = { lng: -87.6818, lat: 41.8376 };
const HOUSTON = { lng: -95.3863, lat: 29.7805 };

test.describe('wild: react-map-gl / controls', () => {
  test.beforeEach(({ wild }) => wild.allowAbort(/upload\.wikimedia\.org/)); // city photos in the popup: not ours to commit, not needed

  test('a marker found by LOCATION is a normal Locator; clicking it opens that city\'s popup at the city', async ({ wild }) => {
    const map = await wild.open(APP, { routes });
    const pin = await map.marker({ at: CHICAGO });
    await pin.click();
    await expect(map).toHavePopup({ at: CHICAGO, text: 'Chicago, Illinois' });
    await expect(await map.popup()).toContainText('Wikipedia');
  });

  test('the popup moves when another pin is clicked, and closes on its × button', async ({ wild }) => {
    const map = await wild.open(APP, { routes });
    await (await map.marker({ at: CHICAGO })).click();
    await expect(map).toHavePopup({ at: CHICAGO });
    await (await map.marker({ at: HOUSTON })).click();
    await expect(map).toHavePopup({ at: HOUSTON, text: 'Houston, Texas' });
    await expect(map).not.toHavePopup({ at: CHICAGO });
    await (await map.popup()).getByRole('button', { name: /close/i }).click();
    await expect(map).not.toHavePopup();
  });

  test('all 20 pins are on the map; asking for a marker where there is none says what IS there', async ({ wild, page }) => {
    const map = await wild.open(APP, { routes });
    await expect(page.locator('.maplibregl-marker')).toHaveCount(20);
    const err = await map.marker({ at: { lng: -100, lat: 48 } }, { timeout: 800 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/no marker there; 20 marker\(s\) on the map/);
  });

  test('the zoom control zooms, and markers stay glued to their cities', async ({ wild, page }) => {
    const map = await wild.open(APP, { routes });
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(map).toHaveView({ zoom: 4.5 });
    await (await map.marker({ at: CHICAGO })).click();
    await expect(map).toHavePopup({ at: CHICAGO, text: 'Chicago' });
  });
});

import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Show polygon information on click": US state polygons (Natural Earth admin-1,
// 110m, public domain: 51 fill entities — the 50 states + DC), fill-color rgba(200,100,240,0.4).
// Click opens a popup with the raw `name` property; cursor becomes a pointer on hover.
const routes: Routes = [
  ...DEMOTILES,
  ['https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_1_states_provinces_shp.geojson', 'ne_110m_admin_1_states_provinces_shp.geojson'],
];

test.describe('wild: show-polygon-information-on-click', () => {
  test('clicking a state opens a popup anchored on it, with its name', async ({ wild }) => {
    const map = await wild.open(example('show-polygon-information-on-click'), { routes });
    const kansas = { layer: 'states-layer', where: { name: 'Kansas' } };
    await map.feature(kansas).click();
    await expect(map).toHavePopup({ feature: kansas, text: 'Kansas' });
  });

  test('each state is independently addressable and shows its own name', async ({ wild }) => {
    const map = await wild.open(example('show-polygon-information-on-click'), { routes });
    await map.feature({ layer: 'states-layer', where: { name: 'Texas' } }).click();
    await expect(await map.popup()).toContainText('Texas');
    await map.feature({ layer: 'states-layer', where: { name: 'Colorado' } }).click();
    await expect(await map.popup()).toContainText('Colorado');
    await expect(await map.popup()).not.toContainText('Texas');
  });

  test('the cursor is a pointer over a state and reverts once it leaves', async ({ wild, page }) => {
    const map = await wild.open(example('show-polygon-information-on-click'), { routes });
    await map.feature({ layer: 'states-layer', where: { name: 'Nebraska' } }).hover();
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'pointer');
    await map.hoverAt({ lng: -140, lat: 40 }); // Pacific Ocean: off every state polygon
    await expect(page.locator('canvas.maplibregl-canvas')).not.toHaveCSS('cursor', 'pointer');
  });

  test('clicking outside every state opens no popup', async ({ wild }) => {
    const map = await wild.open(example('show-polygon-information-on-click'), { routes });
    await map.clickAt({ lng: -140, lat: 40 }); // Pacific Ocean
    await expect(map).not.toHavePopup({});
  });

  test('the states are drawn in the same translucent purple everywhere (constant, not data-driven, fill-color)', async ({ wild }) => {
    const map = await wild.open(example('show-polygon-information-on-click'), { routes });
    const snap = await map.snapshot({ layers: ['states-layer'] });
    expect(snap).toMatch(/\[states-layer\] \d+ fill entities, all drawn purple\(#c864f0\)/);
  });
});

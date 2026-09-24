import { test, expect } from './fixtures';
import { geowright } from '../src/playwright';

/**
 * "Rendered is not visible": MapLibre's queryRenderedFeatures also returns features that the style
 * paints invisibly. The demo's sensors layer hides archived / muted sensors through a data-driven
 * paint expression (NOT a filter), keeps an opacity-0 hit area, and has an icon that is transparent.
 */
test.describe('visibility', () => {
  test.beforeEach(async ({ page, map }) => {
    await page.getByTestId('toggle-sensors').check();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 501 });
  });

  test('visible is the default; MapLibre\'s looser "rendered" is { visible: \'any\' }', async ({ map }) => {
    // The trap this feature exists for: the archived sensor is "there" as far as MapLibre is concerned.
    await expect(map).toHaveFeature({ layer: 'sensors', id: 502 }, { visible: 'any' });
    await expect(map).not.toHaveFeature({ layer: 'sensors', id: 502 }); // a user cannot see it
    await expect(map).toHaveFeature({ layer: 'sensors', id: 502, visible: false });
    await expect(map.features({ layer: 'sensors' })).toHaveFeatureCount(2);
    await expect(map.features({ layer: 'sensors', visible: 'any' })).toHaveFeatureCount(3);
    await expect(map.features({ layer: 'sensor-zones' })).toHaveFeatureCount(0); // fill-opacity: 0
    await expect(map.features({ layer: 'sensor-zones', visible: 'any' })).toHaveFeatureCount(1);

    const [archived] = await map.features({ layer: 'sensors', id: 502, visible: 'any' }).all();
    expect(archived.visible).toBe(false);
    expect(archived.invisibleBecause).toContain('circle-opacity evaluates to 0');
  });

  test('toBeVisibleOnMap follows data-driven paint after an async UI action', async ({ map, page }) => {
    const sensor = map.feature({ layer: 'sensors', id: 501 });
    await expect(sensor).toBeVisibleOnMap();
    await page.getByTestId('sensor-archive-501').click(); // async setData, 100–400ms
    await expect(sensor).not.toBeVisibleOnMap();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 501, visible: 'any' }); // still "rendered"
    await page.getByTestId('sensor-archive-501').click();
    await expect(sensor).toBeVisibleOnMap();
  });

  test('feature-state driven paint is evaluated too', async ({ map, page }) => {
    const sensor = map.feature({ layer: 'sensors', id: 503 });
    await expect(sensor).toBeVisibleOnMap();
    await page.getByTestId('sensor-mute-503').click();
    await expect(sensor).not.toBeVisibleOnMap();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 503, visible: false });
  });

  test('pixel probe catches what paint evaluation cannot: a fully transparent icon', async ({ map }) => {
    const ghost = map.feature({ layer: 'sensors-ghost', id: 504 });
    expect((await ghost.info()).visible).toBe(true); // the style does ask for an icon
    await expect(ghost).toBeVisibleOnMap({ pixels: false });
    await expect(ghost).not.toBeVisibleOnMap();
    const err = await expect(ghost).toBeVisibleOnMap({ timeout: 800 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('hiding layer "sensors-ghost" changes nothing');
  });

  test('the pixel probe leaves the map as it found it', async ({ map, page }) => {
    await expect(map.feature({ layer: 'alerts', id: 1 })).toBeVisibleOnMap();
    await expect(map.feature({ layer: 'parcels', id: 101 })).toBeVisibleOnMap();
    await expect(map.feature({ layer: 'stations-points', where: { name: 'Substation Alpha' } })).toBeVisibleOnMap();
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
    await expect(map.features({ layer: 'parcels' })).toHaveFeatureCount(6);
    await map.feature({ layer: 'alerts', id: 1 }).click();
    await expect(page.getByTestId('popup')).toContainText('Gas leak');
  });

  test('the pixel probe restores a visibility EXPRESSION, not the constant "visible"', async ({ map, page }) => {
    // MapLibre >= 5.16: layout visibility may be an expression on global state. The probe hides the layer and shows
    // it again; it used to write back "visible", which replaced the app's expression (and turned ON a layer the
    // app had hidden, for toHaveLayerPixels).
    const visibility = ['case', ['global-state', 'showCover'], 'visible', 'none'];
    await page.evaluate((visibility) => {
      const m = (window as any).__geowright_maps.main;
      m.setGlobalStateProperty('showCover', true);
      m.addSource('cover', { type: 'geojson', data: { type: 'Feature', id: 9, properties: {}, geometry: { type: 'Polygon', coordinates: [[[34.76, 32.07], [34.775, 32.07], [34.775, 32.085], [34.76, 32.085], [34.76, 32.07]]] } } });
      m.addLayer({ id: 'cover', type: 'fill', source: 'cover', layout: { visibility }, paint: { 'fill-color': '#000' } });
    }, visibility);
    await expect(map.feature({ layer: 'cover', id: 9 })).toBeVisibleOnMap();
    expect(await page.evaluate(() => (window as any).__geowright_maps.main.getLayoutProperty('cover', 'visibility'))).toEqual(visibility);

    await page.evaluate(() => (window as any).__geowright_maps.main.setGlobalStateProperty('showCover', false));
    await expect(map).not.toHaveLayerPixels('cover', { at: { lng: 34.7675, lat: 32.0775 }, timeout: 1000 });
    expect(await page.evaluate(() => (window as any).__geowright_maps.main.getLayoutProperty('cover', 'visibility'))).toEqual(visibility);
    await expect(map).not.toHaveFeature({ layer: 'cover', id: 9 }); // still hidden, as the app wants
  });

  test('actions refuse an invisible feature and say why; force overrides', async ({ map, page }) => {
    const err = await map
      .feature({ layer: 'sensors', id: 502 })
      .click({ timeout: 700 })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toContain('invisible: feature is rendered but not visible: circle-opacity evaluates to 0');
    expect(err?.message).toContain('[NOT VISIBLE: circle-opacity evaluates to 0');
    await map.feature({ layer: 'sensors', id: 502 }).click({ force: true }); // real click still lands
    await expect(page.getByTestId('popup')).toHaveCount(0); // (the demo has no popup for sensors)
  });

  test('failure message explains that a match exists but cannot be seen', async ({ map }) => {
    const err = await expect(map)
      .toHaveFeature({ layer: 'sensors', where: { name: 'Sensor Birch' } }, { timeout: 600 })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toContain('1 feature(s) match but are NOT VISIBLE: sensors#502 (circle-opacity evaluates to 0');
    // …and WHY: the property, its value, the expression branch, the zoom (tests/why-invisible.spec.ts has one per kind)
    expect(err?.message).toContain('-> sensors#502 is not visible at zoom 12: circle-opacity is 0 because the case took its branch 1 (the first true condition: ["any",["==",["get","status"],"archived"]');
  });

  test('an INVISIBLE feature on top is not an occluder; a visible one is', async ({ map, page }) => {
    // What many apps do: a transparent hit area / highlight layer from ANOTHER source lying over the data.
    const cover = (opacity: number) =>
      page.evaluate((o) => {
        const m = (window as any).__geowright_maps.main;
        if (m.getLayer('cover')) m.removeLayer('cover');
        if (!m.getSource('cover')) {
          m.addSource('cover', { type: 'geojson', data: { type: 'Feature', properties: { what: 'cover' }, geometry: { type: 'Polygon', coordinates: [[[34.6, 32.0], [34.95, 32.0], [34.95, 32.2], [34.6, 32.2], [34.6, 32.0]]] } } });
        }
        m.addLayer({ id: 'cover', type: 'fill', source: 'cover', paint: { 'fill-color': '#000', 'fill-opacity': o } });
      }, opacity);
    await cover(0);
    await expect(map).toHaveFeature({ layer: 'cover', visible: 'any' });
    await map.feature({ layer: 'parcels', id: 101 }).click(); // nobody can SEE the cover: the parcel is what the user clicks
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '101');
    expect(await map.snapshot({ layers: ['parcels'] })).not.toContain('covered-by:cover');

    await cover(0.6);
    const err = await map.feature({ layer: 'parcels', id: 102 }).click({ timeout: 800 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/covered by another feature; topmost is cover/);
  });

  test('a layer hidden by fill-layer-opacity / line-layer-opacity 0 (MapLibre 6) is not visible, and the message says so', async ({ map, page }) => {
    await expect(map).toHaveFeature({ layer: 'parcels', id: 101 });
    await expect(map).toHaveFeature({ layer: 'parcels-outline', id: 101 });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.setPaintProperty('parcels', 'fill-layer-opacity', 0);
      m.setPaintProperty('parcels-outline', 'line-layer-opacity', 0);
    });
    await expect(map).not.toHaveFeature({ layer: 'parcels', id: 101 });
    await expect(map).not.toHaveFeature({ layer: 'parcels-outline', id: 101 });
    await expect(map).toHaveFeature({ layer: 'parcels', id: 101, visible: false });
    const err = await expect(map).toHaveFeature({ layer: 'parcels', id: 101 }, { timeout: 600 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('NOT VISIBLE: parcels#101 (fill-layer-opacity evaluates to 0');
    const [outline] = await map.features({ layer: 'parcels-outline', id: 101, visible: 'any' }).all();
    expect(outline.invisibleBecause).toContain('line-layer-opacity evaluates to 0');
  });

  test('snapshot marks invisible entities', async ({ map }) => {
    const snap = await map.snapshot();
    expect(snap).toMatch(/#502 Point .*NOT-VISIBLE\(circle-opacity evaluates to 0/);
    expect(snap).not.toMatch(/#501 Point .*NOT-VISIBLE/);
    expect(snap).toMatch(/#601 Polygon .*NOT-VISIBLE\(fill-opacity evaluates to 0\)/);
  });

  // "could not decide" is not "not visible"
  test('.not.toBeVisibleOnMap on a query matching several VISIBLE features fails (strict mode)', async ({ map }) => {
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
    const e = await expect(map.feature({ layer: 'alerts' })).not.toBeVisibleOnMap({ timeout: 800 }).then(() => null, (e: Error) => e);
    expect(e, '.not.toBeVisibleOnMap passed while 3 alerts are visible').not.toBeNull();
    expect(e?.message).toContain('strict mode violation: 3 features match');
  });

  test('.not.toHaveLayerPixels on a layer that does not exist fails, and says so', async ({ map }) => {
    const e = await expect(map).not.toHaveLayerPixels('no-such-layer', { at: { lng: 34.78, lat: 32.08 }, timeout: 800 }).then(() => null, (e: Error) => e);
    expect(e, '.not.toHaveLayerPixels passed for a layer that does not exist').not.toBeNull();
    expect(e?.message).toContain('layer "no-such-layer" does not exist');
  });

  test('the pixel probe of toBeVisibleOnMap honours the map-level ignoreLayers', async ({ map, page }) => {
    // a translucent highlight drawn over parcel 106: the parcel shows through it, and the app declares the highlight
    // a layer that never counts as an occluder
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('veil', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[34.79, 32.05], [34.81, 32.05], [34.81, 32.07], [34.79, 32.07], [34.79, 32.05]]] } } });
      m.addLayer({ id: 'veil', type: 'fill', source: 'veil', paint: { 'fill-color': '#fff', 'fill-opacity': 0.3 } });
    });
    await map.waitForIdle();
    const lenient = geowright(page, { ignoreLayers: ['veil'] });
    await expect(lenient.feature({ layer: 'parcels', id: 106 })).toBeVisibleOnMap({ timeout: 3000 });
  });
});

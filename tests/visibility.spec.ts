import { test, expect } from './fixtures';

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
  });

  test('snapshot marks invisible entities', async ({ map }) => {
    const snap = await map.snapshot();
    expect(snap).toMatch(/#502 Point .*NOT-VISIBLE\(circle-opacity evaluates to 0/);
    expect(snap).not.toMatch(/#501 Point .*NOT-VISIBLE/);
    expect(snap).toMatch(/#601 Polygon .*NOT-VISIBLE\(fill-opacity evaluates to 0\)/);
  });
});

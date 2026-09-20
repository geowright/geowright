import { test, expect } from './fixtures';

/**
 * ASSERT gap: an action in the regular DOM UI must be verifiable ON THE MAP.
 * The demo's save/remove are async with a random 100–400ms delay, like a real backend call.
 */
test.describe('assert gap', () => {
  test('initial map content', async ({ map }) => {
    await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
    await expect(map).toHaveFeature({ layer: 'parcels', id: 105 });
    await expect(map.features({ layer: 'alerts' })).toHaveCount(3); // 4 exists but is off-screen
    await expect(map.features({ layer: 'parcels' })).toHaveCount(6);
    await expect(map.features({ layer: 'parcels', where: { zoning: 'nope' } })).toHaveCount(0);
  });

  test('form submit adds a feature to the map', async ({ map, page }) => {
    await expect(map).not.toHaveFeature({ layer: 'alerts', where: { name: 'Flooded underpass' } });
    await page.getByTestId('alert-name').fill('Flooded underpass');
    await page.getByTestId('alert-severity').selectOption('high');
    await page.getByTestId('alert-lng').fill('34.805');
    await page.getByTestId('alert-lat').fill('32.100');
    await page.getByTestId('alert-submit').click();

    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Flooded underpass', severity: 'high' } });
    await expect(map.features({ layer: 'alerts', where: { severity: 'high' } })).toHaveCount(2);
    await expect(map.features({ layer: 'alerts' })).toHaveCount(4);

    // and it is where the form said it should be
    const f = await map.feature({ layer: 'alerts', where: { name: 'Flooded underpass' } }).info();
    const box = (await page.locator('#map canvas').boundingBox())!;
    const at = await map.lngLatAt({ x: box.x + f.pixel!.x, y: box.y + f.pixel!.y });
    expect(at.lng).toBeCloseTo(34.805, 3);
    expect(at.lat).toBeCloseTo(32.1, 3);
  });

  test('removing in the UI removes from the map', async ({ map, page }) => {
    await expect(map).toHaveFeature({ layer: 'alerts', id: 2 });
    await page.getByTestId('alert-remove-2').click();
    await expect(map).not.toHaveFeature({ layer: 'alerts', id: 2 });
    await expect(map.features({ layer: 'alerts' })).toHaveCount(2);
  });

  test('layer toggle hides and shows features', async ({ map, page }) => {
    await page.getByTestId('toggle-parcels').uncheck();
    await expect(map).not.toHaveFeature({ layer: 'parcels' });
    await expect(map.features({ layer: 'parcels-outline' })).toHaveCount(0);
    await expect(map).toHaveFeature({ layer: 'alerts', id: 1 }); // others untouched
    await page.getByTestId('toggle-parcels').check();
    await expect(map.features({ layer: 'parcels' })).toHaveCount(6);
  });

  test('failure message says what WAS on the map', async ({ map }) => {
    const err = await expect(map)
      .toHaveFeature({ layer: 'alerts', where: { severity: 'critical' } }, { timeout: 600 })
      .then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    const msg = err!.message;
    expect(msg).toContain('What is on the map');
    expect(msg).toContain('layer "alerts": 3 feature(s) rendered in viewport');
    expect(msg).toContain('"name":"Gas leak"');
    expect(msg).toContain('"zoom":12');
  });

  test('failure message distinguishes off-screen from missing, and hidden layers', async ({ map, page }) => {
    const offscreen = await expect(map).toHaveFeature({ layer: 'alerts', id: 4 }, { timeout: 600 }).then(() => null, (e: Error) => e);
    expect(offscreen!.message).toContain('exist in the source but are not rendered');

    await page.getByTestId('toggle-alerts').uncheck();
    const hidden = await expect(map).toHaveFeature({ layer: 'alerts', id: 1 }, { timeout: 600 }).then(() => null, (e: Error) => e);
    expect(hidden!.message).toContain('visibility is "none"');

    const typo = await expect(map).toHaveFeature({ layer: 'alertz' }, { timeout: 600 }).then(() => null, (e: Error) => e);
    expect(typo!.message).toContain('layer "alertz": does not exist');
  });

  test("Playwright's own locator toHaveCount still works through our expect", async ({ map, page }) => {
    await expect(page.locator('[data-testid^="alert-row-"]')).toHaveCount(4);
    await expect(page.locator('[data-testid^="alert-row-"]')).not.toHaveCount(3);
    await expect(map.features({ layer: 'alerts' })).not.toHaveCount(4);
  });
});

import { test, expect } from './fixtures';

/**
 * Vector-tile sources: the browser only ever holds the tiles in view, so the library cannot know
 * what exists off-screen. Everything in view works exactly like GeoJSON.
 */
test.describe('vector tile layer', () => {
  test('assert and act on features that come from tiles', async ({ map, page }) => {
    await expect(map.features({ layer: 'buildings' })).toHaveFeatureCount(25);
    await expect(map.features({ layer: 'buildings', where: { kind: 'office' } })).toHaveFeatureCount(8);
    await expect(map).toHaveFeature({ layer: 'buildings', id: 1013, where: { floors: { gte: 1 } } });

    await map.feature({ layer: 'buildings', id: 1013 }).click();
    const popup = page.getByTestId('popup');
    await expect(popup).toHaveAttribute('data-kind', 'building');
    await expect(popup).toHaveAttribute('data-id', '1013');
  });

  test('layer toggle', async ({ map, page }) => {
    await page.getByTestId('toggle-buildings').uncheck();
    await expect(map).not.toHaveFeature({ layer: 'buildings' });
    await page.getByTestId('toggle-buildings').check();
    await expect(map.features({ layer: 'buildings' })).toHaveFeatureCount(25);
  });

  test('off-screen: honest about what cannot be known; autoPan takes a location', async ({ map, page }) => {
    const far = map.feature({ layer: 'buildings', id: 1028 });
    const err = await far.click({ timeout: 700 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('uses a tiled (vector) source');
    expect(err?.message).toContain('{ autoPan: { lng, lat } }');

    // `autoPan: true` has nothing to look up for tiles: same clear failure, not a hang or a wrong click
    const err2 = await far.click({ timeout: 700, autoPan: true }).then(() => null, (e: Error) => e);
    expect(err2?.message).toContain('uses a tiled (vector) source');

    await far.click({ autoPan: { lng: 35.2, lat: 32.092 } });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1028');
  });

  test('tiles load while we wait: fly to an area whose tiles were never fetched', async ({ map, page }) => {
    await page.getByTestId('fly-east').click();
    // no waitForIdle on purpose: the assertion must ride out the animation AND the tile fetches
    await expect(map.features({ layer: 'buildings' })).toHaveFeatureCount(6);
    await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 } });
  });

  test('snapshot says which layers are tiled and therefore blind off-screen', async ({ map }) => {
    const snap = await map.snapshot({ perLayer: 3 });
    expect(snap).toContain('buildings(fill,vector)');
    expect(snap).toMatch(/\[buildings\] 25 fill entities/);
    expect(snap).toMatch(/… 22 more not listed \(nearest to the view centre are listed\)\. Summary of all \d+ — .*kind: house×\d+, office×\d+/);
    expect(snap).toContain('note: buildings use tiled sources; features outside the viewport are unknowable from here.');
  });
});

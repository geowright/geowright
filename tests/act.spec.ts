import { test, expect } from './fixtures';

/** ACT gap: actions that originate ON the map, with real mouse input at projected pixels. */
test.describe('act gap', () => {
  test('click a point feature opens its popup', async ({ map, page }) => {
    await map.feature({ layer: 'alerts', where: { severity: 'high' } }).click();
    const popup = page.getByTestId('popup');
    await expect(popup).toHaveAttribute('data-kind', 'alert');
    await expect(popup).toHaveAttribute('data-id', '1');
    await expect(popup).toContainText('Gas leak');
  });

  test('click a concave polygon: point ON the surface, not the centroid', async ({ map, page }) => {
    // Parcel 105 is U-shaped; its centroid / bbox centre is in the notch, outside the polygon.
    await map.feature({ layer: 'parcels', id: 105 }).click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '105');
    await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'parcel');
  });

  test('partially occluded polygon: picks a pixel where it is the topmost hit', async ({ map, page }) => {
    // Drop an alert exactly on the "best" pixel of parcel 101, then click the parcel.
    const parcel = map.feature({ layer: 'parcels', id: 101 });
    const centre = await parcel.lngLat();
    await page.getByTestId('alert-name').fill('On top of 101');
    await page.getByTestId('alert-lng').fill(String(centre.lng));
    await page.getByTestId('alert-lat').fill(String(centre.lat));
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'On top of 101' } });

    await parcel.click();
    // The app gives alerts priority; getting the PARCEL popup proves we avoided the occluder.
    await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'parcel');
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '101');
  });

  test('fully occluded feature: fails with the occluder named; force overrides', async ({ map, page }) => {
    // Parcel 106 is tiny; an alert circle on its centre covers it completely.
    await page.getByTestId('alert-name').fill('Covering 106');
    await page.getByTestId('alert-lng').fill('34.800');
    await page.getByTestId('alert-lat').fill('32.060');
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Covering 106' } });

    const parcel = map.feature({ layer: 'parcels', id: 106 });
    const err = await parcel.click({ timeout: 800 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('occluded');
    expect(err?.message).toContain('Covering 106');

    await parcel.click({ force: true });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'alert'); // what a user would really get

    await page.keyboard.press('Escape');
    await map.clickAt({ lng: 34.83, lat: 32.04 }); // empty spot closes the popup
    await expect(page.getByTestId('popup')).toHaveCount(0);
    await parcel.click({ ignoreLayers: ['alerts'] }); // "I know alerts sit on top, that is fine"
    await expect(page.getByTestId('popup')).toBeVisible();
  });

  test('off-screen feature: clear error by default, opt-in autoPan', async ({ map, page }) => {
    const far = map.feature({ layer: 'alerts', id: 4 });
    const err = await far.click({ timeout: 800 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('not-found');
    expect(err?.message).toContain('exist in the source but are not rendered');

    await far.click({ autoPan: true });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '4');
    await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 } });
  });

  test('strictness: ambiguous query is an error, like a Playwright locator', async ({ map }) => {
    const err = await map.feature({ layer: 'parcels' }).click({ timeout: 600 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('strict mode violation');
    expect(err?.message).toContain('6 features');
  });

  test('auto-waits through a flyTo animation before acting', async ({ map, page }) => {
    await page.getByTestId('fly-east').click(); // starts a multi-second flyTo; do NOT wait here
    await map.feature({ layer: 'alerts', id: 4 }).click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '4');
  });

  test('right-click at a location: context menu acts on that location', async ({ map, page }) => {
    const at = { lng: 34.8123, lat: 32.0712 };
    await map.rightClickAt(at);
    await expect(page.getByTestId('ctx-menu')).toBeVisible();
    const [lng, lat] = (await page.getByTestId('ctx-coords').innerText()).split(',').map(Number);
    expect(lng).toBeCloseTo(at.lng, 3);
    expect(lat).toBeCloseTo(at.lat, 3);

    await page.getByTestId('ctx-add-alert').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Alert from menu' } });
    const where = await map.feature({ layer: 'alerts', where: { name: 'Alert from menu' } }).lngLat();
    expect(where.lng).toBeCloseTo(at.lng, 3);
    expect(where.lat).toBeCloseTo(at.lat, 3);
  });

  test('click a cluster: map zooms in and the cluster breaks apart', async ({ map }) => {
    const clusters = map.features({ layer: 'stations-clusters' });
    const before = await clusters.all();
    expect(before.length).toBeGreaterThan(0);
    const zoomBefore = (await map.viewState()).zoom;
    const target = before[0];
    await map.feature({ layer: 'stations-clusters', where: { cluster_id: target.properties.cluster_id as number } }).click();
    await expect.poll(async () => (await map.viewState()).zoom).toBeGreaterThan(zoomBefore + 0.5);
    await map.waitForIdle();
    // The clicked cluster is gone; it broke into several smaller clusters and/or single stations.
    await expect(map).not.toHaveFeature({ layer: 'stations-clusters', where: { cluster_id: target.properties.cluster_id as number } });
    const pieces = (await clusters.count()) + (await map.features({ layer: 'stations-points' }).count());
    expect(pieces).toBeGreaterThan(1);
  });

  test("a feature's own label on top of it is not an occluder", async ({ map }) => {
    // stations-cluster-count draws the number ON the cluster circle (same source feature).
    const cluster = map.feature({ layer: 'stations-clusters', at: { lng: 34.78, lat: 32.118 } });
    await cluster.hover(); // would time out as "occluded" if labels counted
    const info = await cluster.info();
    expect(info.lngLat!.lng).toBeCloseTo(34.78, 2);
  });

  test('click-time verification: map moved between aiming and clicking -> click is cancelled and retried', async ({ map, page }) => {
    // Sabotage: on the first real mousemove (our aim), the app jumps the map sideways, so the
    // pixel we computed is stale by the time the click lands. A naive tool clicks empty map.
    await page.evaluate(() => {
      const w = window as any;
      w.__sabotaged = 0;
      window.addEventListener(
        'mousemove',
        () => {
          w.__sabotaged++;
          const m = w.__mapwright_maps.main;
          m.jumpTo({ center: [m.getCenter().lng + 0.02, m.getCenter().lat] });
        },
        { capture: true, once: true },
      );
    });
    await map.feature({ layer: 'alerts', id: 1 }).click();
    expect(await page.evaluate(() => (window as any).__sabotaged)).toBe(1);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1'); // right target, after retry
  });

  test('clickAt outside the viewport fails clearly unless autoPan', async ({ map }) => {
    const err = await map.clickAt({ lng: 36, lat: 32 }, { timeout: 500 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('outside the viewport');
    await map.clickAt({ lng: 36, lat: 32 }, { autoPan: true });
    expect((await map.viewState()).center.lng).toBeCloseTo(36, 2);
  });
});

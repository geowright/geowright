import { test, expect } from './fixtures';

/** When something fails, the report gets a picture of the map with the expectation drawn on it. */
test.describe('failure artefacts', () => {
  test('a refused action attaches an annotated screenshot and leaves no overlay behind', async ({ map, page }, testInfo) => {
    await page.getByTestId('toggle-markers').check();
    await map.marker({ at: { lng: 34.8, lat: 32.0595 } });
    const err = await map.feature({ layer: 'parcels', id: 106 }).click({ timeout: 600 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('dom-covered');
    const shot = testInfo.attachments.find((a) => a.name.startsWith('map screenshot — map.feature({"layer":"parcels","id":106}).click()'));
    expect(shot?.contentType).toBe('image/png');
    expect(shot!.body!.length).toBeGreaterThan(5_000);
    expect(shot!.body!.subarray(1, 4).toString()).toBe('PNG');
    await expect(page.locator('[id^="geowright-marks-"]')).toHaveCount(0);
  });

  test('failed assertions and location actions get one too', async ({ map, page }, testInfo) => {
    await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'critical' } }, { timeout: 400 }).catch(() => {});
    await page.getByTestId('fly-east').click();
    await map.clickAt({ lng: 34.0, lat: 32.08 }, { timeout: 400 }).catch(() => {});
    const names = testInfo.attachments.filter((a) => a.contentType === 'image/png').map((a) => a.name);
    expect(names).toEqual(['map screenshot — toHaveFeature', 'map screenshot — map.clickAt']);
    await expect(page.locator('[id^="geowright-marks-"]')).toHaveCount(0);
  });

  test('every action records which pixel it chose and why', async ({ map, page }, testInfo) => {
    await map.feature({ layer: 'alerts', id: 1 }).click();
    await page.getByTestId('toggle-markers').check();
    await map.marker({ feature: { layer: 'parcels', id: 103 } });
    await map.feature({ layer: 'parcels', id: 103 }).click();
    const notes = testInfo.attachments.filter((a) => a.name.startsWith('pixel — ')).map((a) => a.body!.toString());
    expect(notes[0]).toMatch(/^client \(\d+(\.\d)?, \d+(\.\d)?\) · canvas \(.*\) · \{"lng":34\.7\d+,"lat":32\.08\d+\}\ncandidate 1 of \d+ \(centre first, then a ring around it\)$/);
    expect(notes[1]).toMatch(/candidate \d+ of \d+ \(interior points, farthest from the edge first\); skipped before it: 0 under another feature, \d+ under DOM \(<\w+> in <div\.maplibregl-marker.* data-testid="marker-pin-103">\), 0 not on the feature/);
  });

  test('can be switched off', async ({ page }, testInfo) => {
    const { geowright } = await import('../src/playwright');
    const quiet = geowright(page, { failureScreenshots: false });
    await page.goto('/');
    await quiet.waitForIdle();
    const err = await quiet.feature({ layer: 'alerts', id: 99 }).click({ timeout: 300 }).then(() => null, (e: Error) => e);
    expect(err?.message, 'the click failed: otherwise there was no failure to leave a screenshot of').toContain('timed out after 300ms');
    expect(testInfo.attachments.filter((a) => a.contentType === 'image/png')).toHaveLength(0);
  });
});

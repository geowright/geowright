import { test as base, expect } from './fixtures';
import { geowright } from '../src/playwright';

/** Several maps on one page: each handle is bound to a mapId; same layer/ids must not cross over. */
base('two maps on one page are addressed independently', async ({ page }) => {
  await page.goto('/two-maps.html');
  const left = geowright(page, { mapId: 'left' });
  const right = geowright(page, { mapId: 'right' });
  await Promise.all([left.waitForIdle(), right.waitForIdle()]);

  await expect(left.features({ layer: 'sites' })).toHaveFeatureCount(2);
  await expect(right.features({ layer: 'sites' })).toHaveFeatureCount(1);
  await expect(right).not.toHaveFeature({ layer: 'sites', where: { name: 'Left depot' } });

  await right.feature({ layer: 'sites', id: 1 }).click();
  await expect(page.getByTestId('last-click')).toHaveText('right:Right depot');
  await left.feature({ layer: 'sites', id: 1 }).click();
  await expect(page.getByTestId('last-click')).toHaveText('left:Left depot');

  // a location that is on the left map is outside the right map's viewport
  const err = await right.clickAt({ lng: 34.78, lat: 32.08 }, { timeout: 500 }).then(() => null, (e: Error) => e);
  expect(err?.message).toContain('outside the viewport');

  const unknown = await geowright(page, { mapId: 'middle', timeout: 500 }).waitForIdle().then(() => null, (e: Error) => e);
  expect(unknown?.message).toContain('no map registered as "middle" (registered: left, right)');
});

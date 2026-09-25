import { test, expect } from './fixtures';
import { geowright } from '../src/playwright';

/**
 * A map inside a web component's OPEN shadow root. `document.elementFromPoint` stops at the shadow host (<geo-map>), so
 * every pixel of the map read as "covered by DOM element <geo-map>", and a click-time listener on `window` sees the
 * event retargeted to the host, not the canvas.
 */
test('a feature of a map inside an open shadow root is clicked', async ({ page }) => {
  await page.goto('/shadow.html');
  const map = geowright(page);
  await map.waitForIdle();
  await expect(map.features({ layer: 'sites' })).toHaveFeatureCount(2);
  await map.feature({ layer: 'sites', id: 2 }).click({ timeout: 5000 });
  await expect(page.getByTestId('last-click')).toHaveText('Yard');
  await map.clickAt(await map.feature({ layer: 'sites', id: 1 }).lngLat(), { timeout: 5000 });
  await expect(page.getByTestId('last-click')).toHaveText('Depot');
});

test('the snapshot of a map inside an open shadow root lists its features as clickable, not covered by the host', async ({ page }) => {
  await page.goto('/shadow.html');
  const map = geowright(page);
  await map.waitForIdle();
  const snap = await map.snapshot();
  expect(snap).not.toContain('covered-by-dom');
  expect(snap).toMatch(/#1 Point @\(\d+,\d+\)/);
  expect(snap).toMatch(/#2 Point @\(\d+,\d+\)/);
});

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

/**
 * The same web component with a CLOSED shadow root: from outside, `document.elementsFromPoint` stops at the host and a
 * window listener sees the event on the host. The engine reaches the root from its own canvas (`getRootNode()`).
 */
test('a map inside a CLOSED shadow root: its features are clicked, and the snapshot lists them as clickable', async ({ page }) => {
  // the demo's <geo-map> attaches an open root; force it closed (the component keeps its own reference to the root)
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'closed' });
    };
  });
  await page.goto('/shadow.html');
  const map = geowright(page);
  await map.waitForIdle();
  expect(await page.evaluate(() => document.querySelector('geo-map')!.shadowRoot), 'the premise: the root is closed').toBeNull();
  await map.feature({ layer: 'sites', id: 2 }).click({ timeout: 5000 });
  await expect(page.getByTestId('last-click')).toHaveText('Yard');
  const snap = await map.snapshot();
  expect(snap).not.toContain('covered-by-dom');
  expect(snap).toMatch(/#1 Point @\(\d+,\d+\)/);
});

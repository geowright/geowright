import { test, expect } from './fixtures';

test('a map removed during a click explains the detached canvas', async ({ map, page }) => {
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    window.addEventListener('mousemove', () => m.remove(), { capture: true, once: true });
  });
  const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: 1200 }).then(() => null, (e: Error) => e);
  expect(e?.message).toContain('map canvas is detached from the document');
  expect(e?.message).not.toContain('could not inspect the map');
  expect(await map.snapshot()).toContain('canvas is detached from the document');
});

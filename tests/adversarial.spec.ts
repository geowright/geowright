import { test, expect } from './fixtures';

test('a feature click survives a full style reload triggered by its first real mouse move', async ({ map, page }) => {
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    (window as any).__styleReloads = 0;
    window.addEventListener('mousemove', () => {
      (window as any).__styleReloads++;
      m.setStyle(m.getStyle(), { diff: false });
    }, { capture: true, once: true });
  });

  await map.feature({ layer: 'alerts', id: 1 }).click();
  expect(await page.evaluate(() => (window as any).__styleReloads)).toBe(1);
  await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
});

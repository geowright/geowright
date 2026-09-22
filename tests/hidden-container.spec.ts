import { test, expect } from './fixtures';

test('a hidden zero-sized map explains why actions cannot hit it, then recovers after resize', async ({ map, page }) => {
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    m.getContainer().style.display = 'none';
    m.resize();
  });
  const view = await map.viewState();
  const err = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: 750 }).then(() => null, (e: Error) => e);
  expect(view.size).toEqual({ width: 0, height: 0 });
  expect(err?.message).toContain('map canvas is 0x0');
  expect(await map.snapshot()).toContain('zero-sized canvas');
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    m.getContainer().style.display = '';
    m.resize();
  });
  await map.feature({ layer: 'alerts', id: 1 }).click();
  await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
});

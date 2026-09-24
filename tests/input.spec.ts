import { test, expect } from './fixtures';

/** Real input beyond the plain click: modifiers, hover, wheel, double-click, drag-pan. */
test.describe('input', () => {
  test('shift+click selects instead of opening a popup', async ({ map, page }) => {
    await map.feature({ layer: 'alerts', id: 1 }).click({ modifiers: ['Shift'] });
    await map.feature({ layer: 'alerts', id: 3 }).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection')).toHaveText('1,3');
    await expect(page.getByTestId('popup')).toHaveCount(0);
    await map.feature({ layer: 'alerts', id: 1 }).click({ modifiers: ['Shift'] }); // toggle off
    await expect(page.getByTestId('selection')).toHaveText('3');
    await map.feature({ layer: 'alerts', id: 3 }).click(); // modifier was released: normal click again
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '3');
  });

  test('the middle button and the Control, Alt and Meta modifiers reach the page as real mouse events', async ({ map, page }) => {
    await page.evaluate(() => {
      const w = window as any;
      w.__downs = [];
      window.addEventListener('mousedown', (e) => w.__downs.push({ button: e.button, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey }), true);
    });
    const none = { button: 0, ctrl: false, alt: false, meta: false, shift: false };
    await map.feature({ layer: 'alerts', id: 3 }).click({ button: 'middle' });
    for (const modifier of ['Control', 'Alt', 'Meta'] as const) {
      await map.feature({ layer: 'alerts', id: 3 }).click({ modifiers: [modifier] });
      await page.keyboard.press('Escape'); // whatever the click opened (a popup; Control+click is a context menu on macOS)
    }
    expect(await page.evaluate(() => (window as any).__downs)).toEqual([
      { ...none, button: 1 },
      { ...none, ctrl: true },
      { ...none, alt: true },
      { ...none, meta: true },
    ]);
  });

  test('hover drives the app hover state (real mousemove)', async ({ map, page }) => {
    await map.feature({ layer: 'alerts', where: { name: 'Road closure' } }).hover();
    await expect(page.getByTestId('hover-info')).toHaveText('Road closure');
    await expect(page.locator('#map canvas')).toHaveCSS('cursor', 'pointer');
    await map.hoverAt({ lng: 34.83, lat: 32.04 });
    await expect(page.getByTestId('hover-info')).toHaveText('');
  });

  test('wheel zoom happens around the pointer', async ({ map }) => {
    const anchor = { lng: 34.8, lat: 32.1 };
    await map.wheelAt(anchor, -600);
    await expect.poll(async () => (await map.viewState()).zoom).toBeGreaterThan(12.5);
    await map.waitForIdle();
    const view = await map.viewState();
    // the anchor stayed (nearly) where it was on screen, so the centre moved TOWARDS it
    expect(Math.abs(view.center.lng - anchor.lng)).toBeLessThan(Math.abs(34.78 - anchor.lng));
    expect(Math.abs(view.center.lat - anchor.lat)).toBeLessThan(Math.abs(32.08 - anchor.lat));
  });

  test('double-click zooms in one level', async ({ map }) => {
    await map.dblclickAt({ lng: 34.83, lat: 32.04 });
    await expect(map).toHaveView({ zoom: 13 });
  });

  test('drag pans the map by the dragged distance', async ({ map }) => {
    await map.dragAt({ lng: 34.8, lat: 32.1 }, { lng: 34.78, lat: 32.08 });
    await map.waitForIdle(); // inertia
    const c = (await map.viewState()).center;
    // content moved by (-0.02, -0.02) => centre moved by (+0.02, +0.02), plus a little inertia
    expect(c.lng).toBeGreaterThan(34.795);
    expect(c.lat).toBeGreaterThan(32.095);
  });
});

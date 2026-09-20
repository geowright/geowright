import { test, expect } from './fixtures';

/**
 * Touch: Playwright offers tap() only. Pinch / two-finger rotate go through CDP (Chromium only).
 * Keyboard: MapLibre's documented shortcuts, with the map focused.
 */
test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('tap a feature and tap a location', async ({ map }) => {
    await map.feature({ layer: 'alerts', id: 2 }).tap();
    await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 2 }, text: 'Road closure' });
    await map.tapAt({ lng: 34.735, lat: 32.125 }); // empty ground: the app closes the popup
    await expect(map).not.toHavePopup();
  });

  test('pinch zooms around the fingers, two-finger rotate turns the map', async ({ map }) => {
    const before = await map.viewState();
    await map.pinchAt({ lng: 34.78, lat: 32.08 }, { scale: 2 });
    await map.waitForIdle();
    const zoomed = await map.viewState();
    expect(zoomed.zoom - before.zoom).toBeGreaterThan(0.9); // scale 2 = +1 zoom (measured 1.000–1.002)
    expect(zoomed.zoom - before.zoom).toBeLessThan(1.1);
    expect(zoomed.center.lng).toBeCloseTo(34.78, 2); // pinched around the centre: it stays put

    await map.twoFingerRotateAt({ lng: 34.78, lat: 32.08 }, { degrees: 40 });
    await map.waitForIdle();
    const turned = await map.viewState();
    // Measured, stable to ±0.2°: 40° of finger rotation turns the map by -22.5°. MapLibre ignores the
    // rotation until it passes its "is this really a rotate" threshold, then follows the fingers;
    // clockwise fingers = the map content turns clockwise = NEGATIVE bearing.
    expect(turned.bearing).toBeLessThan(-15);
    expect(turned.bearing).toBeGreaterThan(-30);
    // features are still where the library says they are
    await map.feature({ layer: 'alerts', id: 1 }).tap({ autoPan: true });
    await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 } });
  });
});

test.describe('keyboard navigation', () => {
  test('arrows pan 100px, +/- zoom, shift+arrows rotate and pitch', async ({ map }) => {
    const start = await map.viewState();
    await map.keyboard.press('ArrowRight');
    await expect(map).not.toHaveView({ center: start.center });
    const panned = await map.viewState();
    const lngPerPx = 360 / (512 * 2 ** start.zoom);
    expect((panned.center.lng - start.center.lng) / lngPerPx).toBeCloseTo(100, -1); // 100px, give or take easing
    expect(panned.center.lat).toBeCloseTo(start.center.lat, 4);

    await map.keyboard.press('Equal');
    await expect(map).toHaveView({ zoom: start.zoom + 1 });
    await map.keyboard.press('Minus');
    await expect(map).toHaveView({ zoom: start.zoom });
    await map.keyboard.press('Shift+ArrowRight');
    await expect(map).toHaveView({ bearing: 15 });
    await map.keyboard.press('Shift+ArrowUp');
    await expect(map).toHaveView({ pitch: 10 });
  });
});

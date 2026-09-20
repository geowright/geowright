import { test, expect } from './fixtures';

/** Real apps mix canvas features with DOM overlays (maplibregl.Marker / Popup). */
test.describe('DOM markers and popups', () => {
  test('popup is anchored on the clicked feature, at the clicked location', async ({ map }) => {
    await expect(map).not.toHavePopup();
    const alert = map.feature({ layer: 'alerts', id: 1 });
    await alert.click();
    await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 }, text: 'Gas leak' });
    await expect(map).toHavePopup({ at: await alert.lngLat(), text: /Severity: high/ });
    await expect(map).not.toHavePopup({ feature: { layer: 'alerts', id: 2 } });
    await expect(map).not.toHavePopup({ at: { lng: 34.79, lat: 32.095 } }); // alert 2's location
    await expect(await map.popup({ feature: { layer: 'alerts', id: 1 } })).toContainText('Severity: high'); // plain Locator

    const err = await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 2 } }, { timeout: 500 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/popups on the map: "Gas leakSeverity: high" anchored @\(\d+,\d+\)/);
  });

  test('marker by location is a normal Locator: click it, read it, open its popup', async ({ map, page }) => {
    await page.getByTestId('toggle-markers').check();
    const hq = await map.marker({ at: { lng: 34.84, lat: 32.12 } });
    await expect(hq).toHaveText('HQ');
    await expect(hq).toHaveAttribute('data-testid', 'marker-hq');
    await hq.click();
    await expect(map).toHavePopup({ at: { lng: 34.84, lat: 32.12 }, text: 'Depot HQ', tolerancePx: 20 }); // Popup({ offset: 14 })

    const pin = await map.marker({ feature: { layer: 'parcels', id: 103 } }); // the pin whose tip is on parcel 103
    await pin.click();
    await expect(page.getByTestId('marker-info')).toHaveText('pin-103 clicked');

    const err = await map.marker({ at: { lng: 34.7, lat: 32.09 } }, { timeout: 500 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/no marker there; 3 marker\(s\) on the map: "HQ"/);
  });

  test('drag a marker to a coordinate with plain Playwright + map.clientPoint', async ({ map, page }) => {
    await page.getByTestId('toggle-markers').check();
    const hq = await map.marker({ at: { lng: 34.84, lat: 32.12 } });
    const to = await map.clientPoint({ lng: 34.82, lat: 32.11 });
    await hq.hover();
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId('marker-info')).toHaveText(/^hq moved to 34\.82\d\d,32\.1[01]\d\d$/);
    await map.marker({ at: { lng: 34.82, lat: 32.11 }, tolerancePx: 12 });
  });

  test('action points avoid a marker that covers part of a feature', async ({ map, page }) => {
    await page.getByTestId('toggle-markers').check();
    await map.marker({ feature: { layer: 'parcels', id: 103 } }); // the pin is there, over the parcel's middle
    await map.feature({ layer: 'parcels', id: 103 }).click(); // ...so the click goes to an uncovered interior pixel
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '103');
    await expect(page.getByTestId('marker-info')).toHaveText(''); // the marker was NOT clicked
  });

  test('a feature completely under a marker: refused, and the error names the marker', async ({ map, page }) => {
    await page.getByTestId('toggle-markers').check();
    await map.marker({ at: { lng: 34.8, lat: 32.0595 } });
    const err = await map.feature({ layer: 'parcels', id: 106 }).click({ timeout: 700 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/dom-covered: every candidate point is covered by DOM element .*<div\.maplibregl-marker.* data-testid="marker-pin-106">/);
    await expect(page.getByTestId('popup')).toHaveCount(0);
  });
});

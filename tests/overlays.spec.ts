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

  // while the camera moves, whether a popup is anchored on its feature cannot be decided — in either polarity
  test('.not.toHavePopup does not pass while the map is moving and the popup is open', async ({ map, page }) => {
    await map.feature({ layer: 'alerts', id: 1 }).click();
    await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 } });
    await page.evaluate(() => (window as any).__geowright_maps.main.easeTo({ bearing: 60, duration: 3000 })); // the app never closes the popup
    const e = await expect(map).not.toHavePopup({}, { timeout: 1000 }).then(() => null, (e: Error) => e);
    await expect(page.getByTestId('popup')).toBeVisible(); // it really is still open
    expect(e, '.not.toHavePopup passed while the popup was open (map moving)').not.toBeNull();
    expect(e?.message).toContain('the map was moving');
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

  test('a marker Locator stays on ITS element when other markers come and go (it was order-bound once)', async ({ map, page }) => {
    await page.getByTestId('toggle-markers').check();
    const hq = await map.marker({ at: { lng: 34.84, lat: 32.12 } });
    await expect(hq).toHaveAttribute('data-testid', 'marker-hq');
    // Another script puts a marker-classed element BEFORE it in document order: `.maplibregl-marker >> nth=i` would now be a different element.
    await hq.evaluate((el) => {
      const intruder = document.createElement('div');
      intruder.className = 'maplibregl-marker';
      intruder.dataset.testid = 'intruder';
      el.parentElement!.insertBefore(intruder, el.parentElement!.firstChild);
    });
    await expect(hq).toHaveAttribute('data-testid', 'marker-hq');
    await hq.click();
    await expect(page.getByTestId('hq-popup')).toBeVisible(); // HQ's own popup, not a neighbour's
    // removed by the app: the Locator matches nothing (and Playwright says so) instead of pointing at a neighbour
    await page.getByTestId('toggle-markers').uncheck();
    await expect(hq).toHaveCount(0);
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

  // a web component (Lit, Stencil) hosts the map inside its shadow root. A document-wide query does not see
  // into it: no marker or popup was ever found, and `.not.toHavePopup()` always passed.
  test('markers and popups inside a shadow root are found', async ({ map, page }) => {
    await page.getByTestId('toggle-markers').check();
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const container = m.getContainer() as HTMLElement;
      const r = container.getBoundingClientRect();
      const host = document.createElement('div');
      host.style.cssText = `position:absolute; left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px;`;
      container.replaceWith(host);
      const root = host.attachShadow({ mode: 'open' });
      for (const s of document.querySelectorAll('link[rel="stylesheet"], style')) root.appendChild(s.cloneNode(true));
      container.style.cssText = 'position:absolute; inset:0;';
      root.appendChild(container);
      m.resize();
    });
    await map.waitForIdle();
    const hq = await map.marker({ at: { lng: 34.84, lat: 32.12 } });
    await expect(hq).toHaveText('HQ');
    await hq.click();
    await expect(map).toHavePopup({ at: { lng: 34.84, lat: 32.12 }, text: 'Depot HQ', tolerancePx: 20 });
  });

  // the match and the pin were two round trips. A marker inserted in between (markers still loading, another
  // script) shifted the document index, and the Locator was pinned to a different marker. Simulated: every look at the
  // markers schedules another script's marker insertion at the front, for the next task.
  test('the Locator is pinned to the marker that matched, even when markers are inserted during the lookup', async ({ map, page }) => {
    await page.getByTestId('toggle-markers').check();
    await page.evaluate(() => {
      const insertLater = () =>
        setTimeout(() => {
          const holder = document.querySelector('.hq-marker')?.parentElement;
          const intruder = document.createElement('div');
          intruder.className = 'maplibregl-marker';
          intruder.dataset.testid = 'intruder';
          holder?.insertBefore(intruder, holder.firstChild);
        }, 0);
      for (const proto of [Document.prototype, Element.prototype, DocumentFragment.prototype] as any[]) {
        const qsa = proto.querySelectorAll;
        proto.querySelectorAll = function (this: ParentNode, sel: string) {
          if (sel === '.maplibregl-marker') insertLater();
          return qsa.call(this, sel);
        };
      }
    });
    for (let i = 0; i < 5; i++) {
      const hq = await map.marker({ at: { lng: 34.84, lat: 32.12 } });
      await expect(hq).toHaveAttribute('data-testid', 'marker-hq');
    }
  });
});


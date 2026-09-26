import { test, expect } from './fixtures';
import { geowright } from '../src/playwright';
import { FAIL_FAST_MS } from './slow-machine';
import { makeTilePng } from './tile-png';

/** ACT gap: actions that originate ON the map, with real mouse input at projected pixels. */
test.describe('act gap', () => {
  test('click a point feature opens its popup', async ({ map, page }) => {
    await map.feature({ layer: 'alerts', where: { severity: 'high' } }).click();
    const popup = page.getByTestId('popup');
    await expect(popup).toHaveAttribute('data-kind', 'alert');
    await expect(popup).toHaveAttribute('data-id', '1');
    await expect(popup).toContainText('Gas leak');
  });

  test('click a concave polygon: point ON the surface, not the centroid', async ({ map, page }) => {
    // Parcel 105 is U-shaped; its centroid / bbox centre is in the notch, outside the polygon.
    await map.feature({ layer: 'parcels', id: 105 }).click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '105');
    await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'parcel');
  });

  test('partially occluded polygon: picks a pixel where it is the topmost hit', async ({ map, page }) => {
    // Drop an alert exactly on the "best" pixel of parcel 101, then click the parcel.
    const parcel = map.feature({ layer: 'parcels', id: 101 });
    const centre = await parcel.lngLat();
    await page.getByTestId('alert-name').fill('On top of 101');
    await page.getByTestId('alert-lng').fill(String(centre.lng));
    await page.getByTestId('alert-lat').fill(String(centre.lat));
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'On top of 101' } });

    await parcel.click();
    // The app gives alerts priority; getting the PARCEL popup proves we avoided the occluder.
    await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'parcel');
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '101');
  });

  test('fully occluded feature: fails with the occluder named; force overrides', async ({ map, page }) => {
    // Parcel 106 is tiny; an alert circle on its centre covers it completely.
    await page.getByTestId('alert-name').fill('Covering 106');
    await page.getByTestId('alert-lng').fill('34.800');
    await page.getByTestId('alert-lat').fill('32.060');
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Covering 106' } });

    const parcel = map.feature({ layer: 'parcels', id: 106 });
    const err = await parcel.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('occluded');
    expect(err?.message).toContain('Covering 106');

    await parcel.click({ force: true });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'alert'); // what a user would really get

    await page.keyboard.press('Escape');
    await map.clickAt({ lng: 34.83, lat: 32.04 }); // empty spot closes the popup
    await expect(page.getByTestId('popup')).toHaveCount(0);
    await parcel.click({ ignoreLayers: ['alerts'] }); // "I know alerts sit on top, that is fine"
    await expect(page.getByTestId('popup')).toBeVisible();
  });

  test('ignoreLayers per map: every action of that handle looks through those layers', async ({ map, page }) => {
    await page.getByTestId('alert-name').fill('Covering 106');
    await page.getByTestId('alert-lng').fill('34.800');
    await page.getByTestId('alert-lat').fill('32.060');
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Covering 106' } });
    const err = await map.feature({ layer: 'parcels', id: 106 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('occluded');

    const lenient = geowright(page, { mapId: map.mapId, ignoreLayers: ['alerts'] });
    await lenient.feature({ layer: 'parcels', id: 106 }).click({ timeout: 5000 }); // no per-action option
    await expect(page.getByTestId('popup')).toBeVisible();
  });

  test('off-screen feature: clear error by default, opt-in autoPan', async ({ map, page }) => {
    const far = map.feature({ layer: 'alerts', id: 4 });
    const err = await far.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('not-found');
    expect(err?.message).toContain('exist in the source but are not rendered');

    await far.click({ autoPan: true });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '4');
    await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 } });
  });

  // The source holds the feature, but the layer's filter never draws it: autoPan used to jump the camera to it anyway.
  test("autoPan does not pan to a feature the layer's filter never draws", async ({ map, page }) => {
    await page.getByTestId('toggle-sensors').check();
    await map.waitForIdle();
    const before = (await map.viewState()).center;
    const ghost = map.feature({ layer: 'sensors', id: 504 }); // kind "ghost": the sensors layer's filter leaves it out
    const err = await ghost.click({ timeout: FAIL_FAST_MS, autoPan: true }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('not-found');
    expect(err?.message).toContain("the layer's filter leaves them out");
    expect((await map.viewState()).center).toEqual(before);
  });

  test('strictness: ambiguous query is an error, like a Playwright locator', async ({ map }) => {
    const err = await map.feature({ layer: 'parcels' }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('strict mode violation');
    expect(err?.message).toContain('6 features');
  });

  test('auto-waits through a flyTo animation before acting', async ({ map, page }) => {
    await page.getByTestId('fly-east').click(); // starts a multi-second flyTo; do NOT wait here
    await map.feature({ layer: 'alerts', id: 4 }).click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '4');
  });

  test('right-click at a location: context menu acts on that location', async ({ map, page }) => {
    const at = { lng: 34.8123, lat: 32.0712 };
    await map.rightClickAt(at);
    await expect(page.getByTestId('ctx-menu')).toBeVisible();
    const [lng, lat] = (await page.getByTestId('ctx-coords').innerText()).split(',').map(Number);
    expect(lng).toBeCloseTo(at.lng, 3);
    expect(lat).toBeCloseTo(at.lat, 3);

    await page.getByTestId('ctx-add-alert').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Alert from menu' } });
    const where = await map.feature({ layer: 'alerts', where: { name: 'Alert from menu' } }).lngLat();
    expect(where.lng).toBeCloseTo(at.lng, 3);
    expect(where.lat).toBeCloseTo(at.lat, 3);
  });

  test('click a cluster: map zooms in and the cluster breaks apart', async ({ map }) => {
    const clusters = map.features({ layer: 'stations-clusters' });
    const before = await clusters.all();
    expect(before.length).toBeGreaterThan(0);
    const zoomBefore = (await map.viewState()).zoom;
    const target = before[0];
    await map.feature({ layer: 'stations-clusters', where: { cluster_id: target.properties.cluster_id as number } }).click();
    await expect.poll(async () => (await map.viewState()).zoom).toBeGreaterThan(zoomBefore + 0.5);
    await map.waitForIdle();
    // The clicked cluster is gone; it broke into several smaller clusters and/or single stations.
    await expect(map).not.toHaveFeature({ layer: 'stations-clusters', where: { cluster_id: target.properties.cluster_id as number } });
    const pieces = (await clusters.count()) + (await map.features({ layer: 'stations-points' }).count());
    expect(pieces).toBeGreaterThan(1);
  });

  test("a feature's own label on top of it is not an occluder", async ({ map }) => {
    // stations-cluster-count draws the number ON the cluster circle (same source feature).
    const cluster = map.feature({ layer: 'stations-clusters', at: { lng: 34.78, lat: 32.118 } });
    await cluster.hover(); // would time out as "occluded" if labels counted
    const info = await cluster.info();
    expect(info.lngLat!.lng).toBeCloseTo(34.78, 2);
  });

  test('click-time verification: map moved between aiming and clicking -> click is cancelled and retried', async ({ map, page }) => {
    // Sabotage: on the first real mousemove (our aim), the app jumps the map sideways, so the
    // pixel we computed is stale by the time the click lands. A naive tool clicks empty map.
    await page.evaluate(() => {
      const w = window as any;
      w.__sabotaged = 0;
      window.addEventListener(
        'mousemove',
        () => {
          w.__sabotaged++;
          const m = w.__geowright_maps.main;
          m.jumpTo({ center: [m.getCenter().lng + 0.02, m.getCenter().lat] });
        },
        { capture: true, once: true },
      );
    });
    await map.feature({ layer: 'alerts', id: 1 }).click();
    expect(await page.evaluate(() => (window as any).__sabotaged)).toBe(1);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1'); // right target, after retry
  });

  // the two other ways the click-time check (engine armClick) turns a press away. The pixel was clean when it was
  // aimed; the app changes what is on it between the aim's mousemove and the press. The press must be swallowed — the
  // app sees nothing of it — and the retry, once the obstacle is gone again, clicks the target. The app's listeners
  // below are registered before the check's own (armed per attempt), so on window/capture they run first.
  test('click-time verification: a fill drawn over the target as the pointer arrives -> press swallowed, then retried', async ({ map, page }) => {
    const { lngLat } = await map.feature({ layer: 'alerts', id: 1 }).info();
    await page.evaluate(({ lng, lat }) => {
      const m = (window as any).__geowright_maps.main;
      const d = 0.004;
      const ring = [[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]];
      m.addSource('cover', { type: 'geojson', data: { type: 'Feature', properties: { name: 'cover' }, geometry: { type: 'Polygon', coordinates: [ring] } } });
      // drawn but invisible until the pointer arrives: a paint change needs no re-parse, so the fill is there at the press
      m.addLayer({ id: 'cover', type: 'fill', source: 'cover', paint: { 'fill-color': '#000', 'fill-opacity': 0 } });
    }, lngLat!);
    await map.waitForIdle();
    await page.evaluate(() => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      w.__presses = 0;
      window.addEventListener('mousemove', () => m.setPaintProperty('cover', 'fill-opacity', 0.9), { capture: true, once: true });
      window.addEventListener('pointerdown', () => {
        if (w.__presses++ === 0) setTimeout(() => m.setPaintProperty('cover', 'fill-opacity', 0)); // after the check has looked
      }, true);
    });
    await map.feature({ layer: 'alerts', id: 1 }).click();
    expect(await page.evaluate(() => (window as any).__presses), 'two presses: the first one, through the fill, was swallowed').toBe(2);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
  });

  test('click-time verification: a DOM element shown over the pixel as the pointer arrives -> press swallowed, then retried', async ({ map, page }) => {
    await page.evaluate(() => {
      const w = window as any;
      w.__presses = 0;
      w.__bannerClicks = 0;
      window.addEventListener('mousemove', (e) => {
        const banner = document.createElement('div');
        banner.dataset.testid = 'late-banner';
        banner.style.cssText = `position:fixed;left:${e.clientX - 30}px;top:${e.clientY - 30}px;width:60px;height:60px;background:#c00;z-index:10`;
        banner.addEventListener('click', () => w.__bannerClicks++);
        document.body.append(banner);
        w.__banner = banner;
      }, { capture: true, once: true });
      window.addEventListener('pointerdown', () => {
        if (w.__presses++ === 0) setTimeout(() => w.__banner.remove()); // after the check has looked
      }, true);
    });
    await map.feature({ layer: 'alerts', id: 1 }).click();
    const seen = await page.evaluate(() => ({ presses: (window as any).__presses, bannerClicks: (window as any).__bannerClicks }));
    expect(seen, 'the first press landed on the banner, not the map canvas: swallowed, the banner saw no click').toEqual({ presses: 2, bannerClicks: 0 });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
  });

  // the click-time check used to accept any hit that matched the QUERY, so a property-identical, id-less
  // neighbour that slid under the pointer was clicked "successfully". It must be a piece of the resolved target.
  test('click-time verification: a look-alike neighbour that slid under the pointer is not accepted', async ({ map, page }) => {
    const pts = await page.evaluate(() => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      const c = m.project(m.getCenter());
      const at = (dx: number) => m.unproject([c.x + dx, c.y]).toArray();
      const coords = [at(-40), at(0), at(40)];
      m.addSource('look', { type: 'geojson', data: { type: 'FeatureCollection', features: coords.map((co: number[]) => ({ type: 'Feature', properties: { icon: 'music' }, geometry: { type: 'Point', coordinates: co } })) } });
      m.addLayer({ id: 'look', type: 'circle', source: 'look', paint: { 'circle-radius': 8, 'circle-color': '#00f' } });
      w.__lookClicks = [];
      m.on('click', 'look', (e: any) => w.__lookClicks.push(e.features[0].geometry.coordinates));
      return { coords, shiftTo: at(40) };
    });
    await expect(map.features({ layer: 'look' })).toHaveFeatureCount(3);
    await page.evaluate((shiftTo) => {
      // on the first real mousemove (the aim), the app pans exactly one spacing: the east look-alike slides under the pointer
      window.addEventListener('mousemove', () => (window as any).__geowright_maps.main.jumpTo({ center: shiftTo }), { capture: true, once: true });
    }, pts.shiftTo);
    await map.feature({ layer: 'look', at: { lng: pts.coords[1][0], lat: pts.coords[1][1] } }).click({ ignoreLayers: ['alerts', 'alerts-labels', 'parcels', 'roads'] });
    const clicks: number[][] = await page.evaluate(() => (window as any).__lookClicks);
    expect(clicks.length).toBe(1);
    expect(clicks[0][0], `the app received a click on ${JSON.stringify(clicks[0])}, not the middle point ${JSON.stringify(pts.coords[1])}`).toBeCloseTo(pts.coords[1][0], 5);
  });

  // MapLibre divides pointer offsets by the CSS scale of its canvas (rect.width / offsetWidth); geowright used to
  // point at rect.left + surface x, which under scale(0.5) is another place — and the click-time check agreed with it.
  test('a map under a CSS transform: scale() is clicked on the target', async ({ map, page }) => {
    await page.addStyleTag({ content: '#map { transform: scale(0.5); transform-origin: 0 0; }' });
    await page.evaluate(() => (window as any).__geowright_maps.main.resize());
    await map.waitForIdle();
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: 5000 }).then(() => null, (e: Error) => e);
    expect(e?.message.split('\n')[0] ?? null).toBeNull();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
    // a location, too (clientPoint), and the way back (worldAt)
    const two = await map.feature({ layer: 'alerts', id: 2 }).lngLat();
    await map.clickAt(two);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '2');
    const back = await map.lngLatAt(await map.clientPoint(two));
    expect(back.lng).toBeCloseTo(two.lng, 4);
    expect(back.lat).toBeCloseTo(two.lat, 4);
  });

  // a map-level ignoreLayers that lists the target's own layer made the target impossible to act on.
  test("ignoreLayers never hides the target's own layer", async ({ map, page }) => {
    const ignoring = geowright(page, { mapId: map.mapId, ignoreLayers: ['alerts'] }); // the map fixture has loaded the page
    await ignoring.feature({ layer: 'alerts', id: 1 }).click({ timeout: 3000 });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
  });

  // the click-time check is armed in the page; an app that re-creates its map in the click handler used to make
  // the check's answer vanish ("the click never reached the page"), and the click was sent again and again.
  for (const moving of [undefined, 'allow'] as const) {
    test(`a click whose handler re-registers the map reaches the app once (moving: ${moving})`, async ({ map, page }) => {
      await page.evaluate(() => {
        const w = window as any;
        const m = w.__geowright_maps.main;
        w.__alertClicks = 0;
        m.on('click', 'alerts', () => {
          w.__alertClicks++;
          w.__geowright_maps.main = new Proxy(m, {}); // the app "re-creates" its map under the same id (a new instance identity)
        });
      });
      await map.feature({ layer: 'alerts', id: 1 }).click({ moving, timeout: 4000 });
      expect(await page.evaluate(() => (window as any).__alertClicks), 'number of real clicks the app received').toBe(1);
      // nothing of the first map's check lingers: the next click is delivered, once, to the right feature
      await map.feature({ layer: 'alerts', id: 2 }).click({ moving, timeout: 4000 });
      expect(await page.evaluate(() => (window as any).__alertClicks)).toBe(2);
      await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '2');
    });
  }

  // a throw from the real input call went into the retry loop — but the input may have left, and the retry clicked again.
  for (const moving of [undefined, 'allow'] as const) {
    test(`a click whose real input throws ends with that error and is not sent again (moving: ${moving})`, async ({ map, page }) => {
      await page.evaluate(() => {
        const w = window as any;
        w.__alertClicks = 0;
        w.__geowright_maps.main.on('click', 'alerts', () => w.__alertClicks++);
      });
      // The click reaches the page, then the call fails: its answer is lost on the way back.
      const mouse = page.mouse;
      const click = mouse.click.bind(mouse);
      mouse.click = async (...args: Parameters<typeof click>) => {
        await click(...args);
        throw new Error('the answer to the click was lost');
      };
      const err = await map.feature({ layer: 'alerts', id: 1 }).click({ moving, timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      expect(err?.message).toBe('the answer to the click was lost');
      expect(await page.evaluate(() => (window as any).__alertClicks), 'number of real clicks the app received').toBe(1);
    });
  }

  test('a visible feature just across the antimeridian can be clicked', async ({ map, page }) => {
    await page.evaluate(() => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      m.addSource('am', { type: 'geojson', data: { type: 'Feature', id: 1, properties: { name: 'east of 180' }, geometry: { type: 'Point', coordinates: [-179.8, 0] } } });
      m.addLayer({ id: 'am', type: 'circle', source: 'am', paint: { 'circle-radius': 10, 'circle-color': '#f60' } });
      w.__amClicks = 0;
      m.on('click', 'am', () => w.__amClicks++);
      m.jumpTo({ center: [179.5, 0], zoom: 6 });
    });
    await map.waitForIdle();
    await expect(map).toHaveLayerPixels('am', { at: { lng: 180.2, lat: 0 }, radiusPx: 6 }); // it is drawn, 0.7° east of centre
    const e = await map.feature({ layer: 'am' }).click({ timeout: 3000 }).then(() => null, (e: Error) => e);
    expect({ error: e?.message.split('\n')[0] ?? null, clicks: await page.evaluate(() => (window as any).__amClicks) }).toEqual({ error: null, clicks: 1 });
    // the snapshot lists it with a pixel, not as "OUTSIDE the viewport"
    const snap = await map.snapshot({ layers: ['am'] });
    expect(snap).toMatch(/#1 Point @\(\d+,\d+\) /);
    expect(snap).not.toContain('OUTSIDE the viewport');
  });

  test('clickAt outside the viewport fails clearly unless autoPan', async ({ map }) => {
    const err = await map.clickAt({ lng: 36, lat: 32 }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('outside the viewport');
    await map.clickAt({ lng: 36, lat: 32 }, { autoPan: true });
    expect((await map.viewState()).center.lng).toBeCloseTo(36, 2);
  });
});

/**
 * Decision 0022: the hit test never returns pixel-only layers (raster, image, video, canvas, heatmap, hillshade). An action whose
 * chosen pixel is under one that is drawn ABOVE the target probes the target's own layer there: hiding it changes
 * nothing → covered. Decision 0022.
 */
test.describe('pixel-only layers above the target (decision 0022)', () => {
  /**
   * An image layer on top of everything: over the whole view, or over a square of ±`d`° around `around`. Its image is
   * grey, with a transparent `hole` (the centre quarter, or a corner) — what an opaque-styled raster with gaps is.
   */
  const addVeil = (page: import('@playwright/test').Page, o: { opacity: number; around?: { lng: number; lat: number }; d?: number; hole?: 'centre' | 'corner' }) =>
    page.evaluate((o) => {
      const m = (window as any).__geowright_maps.main;
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#888';
      g.fillRect(0, 0, 64, 64);
      if (o.hole === 'centre') g.clearRect(16, 16, 32, 32);
      if (o.hole === 'corner') g.clearRect(0, 0, 24, 24);
      let [w, s, e, n] = [0, 0, 0, 0];
      if (o.around) [w, s, e, n] = [o.around.lng - o.d!, o.around.lat - o.d!, o.around.lng + o.d!, o.around.lat + o.d!];
      else {
        const b = m.getBounds();
        [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      }
      m.addSource('veil', { type: 'image', url: c.toDataURL(), coordinates: [[w, n], [e, n], [e, s], [w, s]] });
      m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': o.opacity, 'raster-fade-duration': 0 } });
    }, o);

  /** Counts, from now on: the app's own layer-scoped clicks (feature ids), and the map's 'styledata' events (a probe fires them). */
  const watch = (page: import('@playwright/test').Page, layer: string) =>
    page.evaluate((layer) => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      w.__layerClicks = [];
      w.__styledata = 0;
      m.on('click', layer, (e: any) => w.__layerClicks.push(e.features[0].id));
      m.on('styledata', () => w.__styledata++);
    }, layer);
  const counts = (page: import('@playwright/test').Page) => page.evaluate(() => ({ clicks: (window as any).__layerClicks, styledata: (window as any).__styledata }));

  test('an opaque image layer drawn above a feature: click() is refused, and the message names it', async ({ map, page }) => {
    await addVeil(page, { opacity: 1 });
    // the premise: the veil really is drawn over alert 1 (34.77, 32.085)
    await expect(map, 'the premise: the opaque veil is drawn over alert 1').toHaveLayerPixels('veil', { at: { lng: 34.77, lat: 32.085 } });
    await watch(page, 'alerts');
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e?.message.split('\n\n')[0]).toMatch(/occluded: .*raster layer "veil", drawn above "alerts".*ignoreLayers: \['veil'\]/);
    expect((await counts(page)).clicks, 'nothing reached the app').toEqual([]);
    // it is the user's call that the veil is see-through: then it costs nothing, and the click lands
    await map.feature({ layer: 'alerts', id: 1 }).click({ ignoreLayers: ['veil'] });
    expect((await counts(page)).clicks).toEqual([1]);
  });

  test('a translucent raster above a feature: the click is checked by a probe, and lands', async ({ map, page }) => {
    await addVeil(page, { opacity: 0.5 });
    await map.waitForIdle(); // the veil's own 'styledata' has fired: from now on only a probe fires one
    await watch(page, 'alerts');
    await map.feature({ layer: 'alerts', id: 1 }).click();
    const c = await counts(page);
    expect(c.clicks, "the app's own click handler on 'alerts' got alert 1").toEqual([1]);
    expect(c.styledata, 'the pixels were probed (a probe changes the style, and puts it back)').toBeGreaterThan(0);
  });

  test('an opaque image with a transparent hole over the feature: the click lands; with the hole elsewhere it is refused', async ({ map, page }) => {
    const alert = { lng: 34.77, lat: 32.085 };
    await addVeil(page, { opacity: 1, around: alert, d: 0.01, hole: 'centre' });
    await expect(map, 'the premise: the image is drawn around alert 1').toHaveLayerPixels('veil', { at: { lng: alert.lng - 0.008, lat: alert.lat + 0.008 } });
    await watch(page, 'alerts');
    await map.feature({ layer: 'alerts', id: 1 }).click();
    expect((await counts(page)).clicks, 'clicked through the hole').toEqual([1]);

    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.removeLayer('veil');
      m.removeSource('veil');
    });
    await addVeil(page, { opacity: 1, around: alert, d: 0.01, hole: 'corner' });
    // the premise: the new image is drawn, over alert 1 (a probe before that sees the target, and is right to)
    await expect(map, 'the premise: the image, opaque at alert 1, is drawn').toHaveLayerPixels('veil', { at: alert });
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e?.message.split('\n\n')[0]).toMatch(/occluded: .*raster layer "veil"/);
    expect((await counts(page)).clicks, 'no second click reached the app').toEqual([1]);
  });

  test('a raster BELOW the features (the demo basemap) costs nothing: no probe, no style change', async ({ map, page }) => {
    await watch(page, 'alerts');
    await map.feature({ layer: 'alerts', id: 1 }).click();
    await map.feature({ layer: 'parcels', id: 105 }).click();
    const c = await counts(page);
    expect(c.clicks).toEqual([1]);
    expect(c.styledata, 'no probe ran').toBe(0);
  });

  test('a target with data-driven opacity (probed by visibility, its source reloads) under a translucent raster: the click lands', async ({ map, page }) => {
    await page.getByTestId('toggle-sensors').check();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 501 });
    await addVeil(page, { opacity: 0.5 });
    await watch(page, 'sensors');
    await page.evaluate(() => {
      const w = window as any;
      w.__sensorReloads = 0;
      w.__geowright_maps.main.on('sourcedataloading', (e: any) => e.sourceId === 'sensors' && w.__sensorReloads++);
      w.__geowright_maps.main.on('sourcedata', (e: any) => e.sourceId === 'sensors' && e.tile && w.__sensorReloads++);
    });
    await map.feature({ layer: 'sensors', id: 501 }).click();
    expect((await counts(page)).clicks, "the app's own click handler on 'sensors' got sensor 501").toEqual([501]);
    expect(await page.evaluate(() => (window as any).__sensorReloads), 'the premise: the probe went the visibility route, and the source reloaded').toBeGreaterThan(0);
  });

  // The reload race (0022): after a probe that hid the target by `visibility`, its source reloads and the target is missing
  // from the hit test until the reload lands (measured: up to 787 ms under load). The action waits for it before it aims
  // again. Sabotage makes the window long and certain: right after the probe puts the layer back, the page takes the
  // layer out for 400 ms (removed and added back as it was: hiding it again would not do, MapLibre's hit test answers
  // from the old tiles until the reload lands). A press sent without the wait would arrive in that window and be
  // swallowed: exactly ONE press is asserted.
  test('the reload race: after a probe that reloads the target, the action waits for the target before it presses (one press)', async ({ map, page }) => {
    await page.getByTestId('toggle-sensors').check();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 501 });
    await addVeil(page, { opacity: 0.5 });
    await map.waitForIdle();
    await watch(page, 'sensors');
    await page.evaluate(() => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      w.__presses = 0;
      window.addEventListener('pointerdown', () => w.__presses++, true);
      const set = m.setLayoutProperty.bind(m);
      let armed = true;
      m.setLayoutProperty = (layer: string, name: string, value: unknown, ...rest: unknown[]) => {
        set(layer, name, value, ...rest);
        if (armed && layer === 'sensors' && name === 'visibility' && value !== 'none') {
          armed = false; // the probe has just put the layer back: keep the target out of the hit test a while longer
          const spec = m.getStyle().layers.find((l: { id: string }) => l.id === 'sensors');
          const ids = m.getStyle().layers.map((l: { id: string }) => l.id);
          const before = ids[ids.indexOf('sensors') + 1];
          setTimeout(() => {
            m.removeLayer('sensors');
            setTimeout(() => m.addLayer(spec, before), 400);
          });
        }
      };
    });
    await map.feature({ layer: 'sensors', id: 501 }).click();
    expect((await counts(page)).clicks).toEqual([501]);
    expect(await page.evaluate(() => (window as any).__presses), 'one press: none was sent while the target was out of the hit test').toBe(1);
  });

  // Sabotage (0019): the aim saw no veil (opacity 0 draws nothing); the app shows it as the pointer arrives. The press
  // must be swallowed — no probe at click time, only the gate — and the retry, once the veil is gone again, clicks.
  test('click-time verification: a raster shown over the target as the pointer arrives -> press swallowed, then retried', async ({ map, page }) => {
    await addVeil(page, { opacity: 0 });
    await map.waitForIdle();
    await watch(page, 'alerts');
    await page.evaluate(() => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      w.__presses = 0;
      window.addEventListener('mousemove', () => m.setPaintProperty('veil', 'raster-opacity', 1), { capture: true, once: true });
      window.addEventListener('pointerdown', () => {
        if (w.__presses++ === 0) setTimeout(() => m.setPaintProperty('veil', 'raster-opacity', 0)); // after the check has looked
      }, true);
    });
    await map.feature({ layer: 'alerts', id: 1 }).click();
    expect(await page.evaluate(() => (window as any).__presses), 'two presses: the first one, under the veil, was swallowed').toBe(2);
    expect((await counts(page)).clicks).toEqual([1]);
  });

  /** A canvas-source veil over ±0.01° around alert 1, above everything; `__paintVeil(opaque)` repaints it (no data event). */
  const addCanvasVeil = (page: import('@playwright/test').Page, opaque: boolean) =>
    page.evaluate(({ a, opaque }) => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      w.__paintVeil = (o: boolean) => {
        const g = c.getContext('2d')!;
        g.clearRect(0, 0, 64, 64);
        if (o) {
          g.fillStyle = '#888';
          g.fillRect(0, 0, 64, 64);
        }
      };
      w.__paintVeil(opaque);
      const d = 0.01;
      m.addSource('veil', { type: 'canvas', canvas: c, animate: true, coordinates: [[a.lng - d, a.lat + d], [a.lng + d, a.lat + d], [a.lng + d, a.lat - d], [a.lng - d, a.lat - d]] });
      m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } });
    }, { a: ALERT1, opaque });
  const ALERT1 = { lng: 34.77, lat: 32.085 };
  const refusal = (e: Error | null) => e?.message.split('\n\n')[0].slice(0, 400) ?? null;

  // A pixel verdict serves the retries of ONE action. What an overlay draws can change without anything its key sees: an
  // animated canvas, a paint transition, a colour. So every new action probes again. (The premises are checked AFTER the
  // second click: a probe between the clicks would change the overlay's stamp and hide the bug.)
  test('a verdict serves one action: a canvas veil that turned opaque after a click refuses the next click', async ({ map, page }) => {
    await addCanvasVeil(page, false);
    await watch(page, 'alerts');
    await map.feature({ layer: 'alerts', id: 1 }).click(); // through the transparent canvas: probed, lands
    expect((await counts(page)).clicks).toEqual([1]);
    await page.evaluate(() => (window as any).__paintVeil(true));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    await expect(map, 'the premise: the canvas veil is drawn, opaque, over alert 1').toHaveLayerPixels('veil', { at: ALERT1 });
    await expect(map.feature({ layer: 'alerts', id: 1 }), 'the premise: alert 1 cannot be seen').not.toBeVisibleOnMap();
    expect({ error: refusal(e), clicks: (await counts(page)).clicks }).toEqual({ error: expect.stringMatching(/occluded: .*veil/s), clicks: [1] });
  });

  test('a verdict serves one action: an overlay faded in by a paint transition refuses a click after the fade', async ({ map, page }) => {
    test.setTimeout(90_000);
    await addVeil(page, { opacity: 0 });
    await page.evaluate(() => (window as any).__geowright_maps.main.setPaintProperty('veil', 'raster-opacity-transition', { duration: 8000, delay: 0 }));
    await map.waitForIdle();
    await watch(page, 'alerts');
    await page.evaluate(() => (window as any).__geowright_maps.main.setPaintProperty('veil', 'raster-opacity', 1)); // the app fades its overlay in
    await map.feature({ layer: 'alerts', id: 1 }).click(); // during the fade the alert shows through: it lands (right, then)
    expect((await counts(page)).clicks).toEqual([1]);
    await map.waitForIdle({ timeout: 60_000 }); // idle waits for paint transitions: the veil is opaque now
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    await expect(map.feature({ layer: 'alerts', id: 1 }), 'the premise: alert 1 cannot be seen').not.toBeVisibleOnMap();
    expect({ error: refusal(e), clicks: (await counts(page)).clicks }).toEqual({ error: expect.stringMatching(/occluded: .*veil/s), clicks: [1] });
  });

  test("a verdict serves one action: a background layer whose colour turned opaque refuses the next click", async ({ map, page }) => {
    await page.evaluate(() => (window as any).__geowright_maps.main.addLayer({ id: 'dim', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)', 'background-color-transition': { duration: 0 } } }));
    await map.waitForIdle();
    await watch(page, 'alerts');
    await map.feature({ layer: 'alerts', id: 1 }).click(); // see-through: probed, lands
    expect((await counts(page)).clicks).toEqual([1]);
    await page.evaluate(() => (window as any).__geowright_maps.main.setPaintProperty('dim', 'background-color', '#000'));
    await map.waitForIdle();
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    await expect(map.feature({ layer: 'alerts', id: 1 }), 'the premise: alert 1 cannot be seen').not.toBeVisibleOnMap();
    expect({ error: refusal(e), clicks: (await counts(page)).clicks }).toEqual({ error: expect.stringMatching(/occluded: .*background layer "dim"/s), clicks: [1] });
  });

  test('a verdict serves one action: a heatmap whose radius grew over the target refuses the next click', async ({ map, page }) => {
    await page.evaluate((a) => {
      const m = (window as any).__geowright_maps.main;
      // a hot spot 0.004° east of alert 1: at radius 5 it does not reach the alert, at radius 150 it covers it
      m.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features: Array.from({ length: 20 }, () => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [a.lng + 0.004, a.lat] } })) } });
      m.addLayer({ id: 'heat', type: 'heatmap', source: 'heat', paint: { 'heatmap-radius': 5, 'heatmap-intensity': 5, 'heatmap-opacity': 1 } });
    }, ALERT1);
    await map.waitForIdle();
    await watch(page, 'alerts');
    await map.feature({ layer: 'alerts', id: 1 }).click();
    expect((await counts(page)).clicks).toEqual([1]);
    await page.evaluate(() => (window as any).__geowright_maps.main.setPaintProperty('heat', 'heatmap-radius', 150));
    await map.waitForIdle();
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    await expect(map.feature({ layer: 'alerts', id: 1 }), 'the premise: alert 1 cannot be seen').not.toBeVisibleOnMap();
    expect({ error: refusal(e), clicks: (await counts(page)).clicks }).toEqual({ error: expect.stringMatching(/occluded: .*heatmap layer "heat"/s), clicks: [1] });
  });

  // The other way round: an 'occluded' verdict must not outlive its action either. A 2px dot: only a handful of its
  // candidate pixels hit-test, so one refused click has probed them all.
  test('a verdict serves one action: once a canvas veil over a small target is cleared, the target can be clicked', async ({ map, page }) => {
    await page.evaluate((a) => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      m.addSource('dot', { type: 'geojson', data: { type: 'Feature', id: 9, properties: { name: 'dot' }, geometry: { type: 'Point', coordinates: [a.lng, a.lat] } } });
      m.addLayer({ id: 'dot', type: 'circle', source: 'dot', paint: { 'circle-radius': 2, 'circle-color': '#e0a' } });
      w.__dotClicks = 0;
      m.on('click', 'dot', () => w.__dotClicks++);
    }, ALERT1);
    await addCanvasVeil(page, true);
    await expect(map, 'the premise: the canvas veil is drawn over the dot').toHaveLayerPixels('veil', { at: ALERT1 });
    const e = await map.feature({ layer: 'dot' }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(refusal(e), 'the premise: every candidate was probed and found covered').toMatch(/occluded: .*veil/s);
    await page.evaluate(() => (window as any).__paintVeil(false)); // the app clears its overlay
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const e2 = await map.feature({ layer: 'dot' }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect({ error: refusal(e2), clicks: await page.evaluate(() => (window as any).__dotClicks) }).toEqual({ error: null, clicks: 1 });
  });

  // MapLibre >= 5 hit-tests a heatmap over its whole radius, drawn or not. Its hit is not an occluder: the gate and the
  // probe decide, as on every other version.
  const addHeat = (page: import('@playwright/test').Page, o: { at: { lng: number; lat: number }; opacity: number; radius?: number; visibility?: 'visible' | 'none' }) =>
    page.evaluate((o) => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 900, properties: { w: 1 }, geometry: { type: 'Point', coordinates: [o.at.lng, o.at.lat] } }] } });
      m.addLayer({ id: 'heat', type: 'heatmap', source: 'heat', layout: { visibility: o.visibility ?? 'visible' }, paint: { 'heatmap-radius': o.radius ?? 30, 'heatmap-opacity': o.opacity } });
    }, o);

  test('a heatmap of another source over a feature, drawing nothing (heatmap-opacity 0): the click lands, no probe', async ({ map, page }) => {
    await addHeat(page, { at: ALERT1, opacity: 0 });
    await map.waitForIdle();
    await watch(page, 'alerts');
    const hits = await page.evaluate((a) => {
      const m = (window as any).__geowright_maps.main;
      return m.queryRenderedFeatures(m.project([a.lng, a.lat])).map((f: any) => f.layer.id);
    }, ALERT1);
    expect(hits, 'the premise: MapLibre 6 hit-tests the heatmap at the alert').toContain('heat');
    await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS });
    expect(await counts(page)).toEqual({ clicks: [1], styledata: 0 });
  });

  test("a heatmap's translucent fringe over a feature: the probe sees the feature through it, and the click lands", async ({ map, page }) => {
    const at = await page.evaluate((a) => {
      const m = (window as any).__geowright_maps.main;
      const p = m.project([a.lng, a.lat]);
      const ll = m.unproject([p.x + 30, p.y]);
      return { lng: ll.lng, lat: ll.lat };
    }, ALERT1);
    await addHeat(page, { at, opacity: 0.3, radius: 40 });
    await map.waitForIdle();
    await watch(page, 'alerts');
    await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS });
    const c = await counts(page);
    expect(c.clicks).toEqual([1]);
    expect(c.styledata, 'the pixels were probed').toBeGreaterThan(0);
  });

  // A heatmap on the TARGET's own source, above it, with the target's opacity data-driven: the probe hides the target by
  // visibility, which reloads the shared source. The heatmap's stamp must not change with that reload, or the verdict
  // just reached is never found again (probe, reload, probe…).
  test("a translucent heatmap of the target's own source above it (target opacity data-driven): the click lands", async ({ map, page }) => {
    await page.getByTestId('toggle-sensors').check();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 501 });
    await page.evaluate(() => (window as any).__geowright_maps.main.addLayer({ id: 'sensor-heat', type: 'heatmap', source: 'sensors', paint: { 'heatmap-radius': 10, 'heatmap-opacity': 0.3 } }));
    await map.waitForIdle();
    await watch(page, 'sensors');
    await map.feature({ layer: 'sensors', id: 501 }).click({ timeout: FAIL_FAST_MS });
    expect((await counts(page)).clicks).toEqual([501]);
  });

  // A raster source with inline `bounds`: MapLibre draws every tile that meets them WHOLE. Alert 1 (34.77) is west of the
  // bounds (34.775) but inside the edge tile: the opaque tile covers it, and the gate must not trust the bounds.
  test('an opaque tiled raster whose bounds end just short of a feature (the edge tile covers it): the click is refused', async ({ map, page }) => {
    const png = makeTilePng();
    await page.route('**/veiltiles/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('veil', { type: 'raster', tiles: [location.origin + '/veiltiles/{z}/{x}/{y}.png'], tileSize: 256, bounds: [34.775, 31.9, 35.0, 32.3] });
      m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-fade-duration': 0 } });
    });
    await map.waitForIdle();
    await expect(map, 'the premise: the opaque tile is drawn over alert 1').toHaveLayerPixels('veil', { at: ALERT1 });
    await watch(page, 'alerts');
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect({ error: refusal(e), clicks: (await counts(page)).clicks }).toEqual({ error: expect.stringMatching(/occluded: .*raster layer "veil"/s), clicks: [] });
  });

  // The snapshot does not probe (four renders per listed entity): a feature under a pixel-only layer is listed with its
  // pixel AND the layer over it, not as a plain "click here".
  test('the snapshot marks a feature under a pixel-only layer (it does not probe); click() refuses it under an opaque one', async ({ map, page }) => {
    await addVeil(page, { opacity: 1 });
    await map.waitForIdle();
    const snap = await map.snapshot();
    expect(snap).toMatch(/#1 Point @\(\d+,\d+\) under-pixel-layer:veil/);
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(refusal(e)).toMatch(/occluded: .*raster layer "veil"/s);
  });
});

/** The press-time check (0019): what the aim approved must still hold at the instant the real press arrives. */
test.describe('press-time check', () => {
  test('a target painted invisibly as the pointer arrives (nothing visible under it) is not clicked', async ({ map, page }) => {
    await page.evaluate(() => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      w.__layerClicks = [];
      m.on('click', 'alerts', (e: any) => w.__layerClicks.push(e.features[0].id));
      window.addEventListener('mousemove', () => {
        for (const p of ['circle-opacity', 'circle-stroke-opacity']) {
          m.setPaintProperty('alerts', `${p}-transition`, { duration: 0, delay: 0 });
          m.setPaintProperty('alerts', p, 0);
        }
      }, { capture: true, once: true });
    });
    const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(await page.evaluate(() => (window as any).__layerClicks), 'no click reached the app').toEqual([]);
    expect(e?.message).toMatch(/painted invisibly|not visible/);
  });
});

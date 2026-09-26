import { test as base, expect as baseExpect } from '@playwright/test';
import { geowright, expect, type MapHandle } from '../../src/playwright';
import { routeVectorTiles } from '../../src/playwright/tiles';
import { guardNetwork } from '../fixtures';
import { LIBS } from './libs';
import { FAIL_FAST_MS } from '../slow-machine';

/**
 * The version matrix: the SAME page and the SAME specs against every MapLibre / Mapbox-GL-v1-API major.
 * What is asserted here is the README's support table. A capability an old version lacks is not skipped
 * silently: the spec asserts WHAT the library says about it (caveats, error text).
 */
const PARCELS = {
  type: 'FeatureCollection' as const,
  features: [0, 1, 2].map((i) => ({
    type: 'Feature' as const,
    id: 500 + i,
    properties: { parcel: `P${i}`, owner: i === 1 ? 'city' : 'private' },
    geometry: { type: 'Polygon' as const, coordinates: [[[34.74 + i * 0.03, 32.125], [34.76 + i * 0.03, 32.125], [34.76 + i * 0.03, 32.135], [34.74 + i * 0.03, 32.135], [34.74 + i * 0.03, 32.125]]] },
  })),
};

for (const lib of LIBS) {
  const test = base.extend<{ map: MapHandle }>({
    map: async ({ page, baseURL }, use) => {
      const guard = await guardNetwork(page, baseURL!); // the exact origin, as in the core suite: :41750 is not :4175
      await routeVectorTiles(page, '**/vt/parcels/**', { parcels: PARCELS });
      await page.goto(`/?lib=${lib.alias}`);
      const map = geowright(page);
      await map.waitForIdle();
      await use(map);
      guard.check();
    },
  });

  test.describe(lib.label, () => {
    test('assert: features appear, change and disappear', async ({ map, page }) => {
      await expect(map.features({ layer: 'places' })).toHaveFeatureCount(5);
      await expect(map.features({ layer: 'places', where: { kind: 'cafe' } })).toHaveFeatureCount(2);
      await expect(map).not.toHaveFeature({ layer: 'places', where: { name: 'Foxtrot' } });
      await page.locator('#add').click();
      await expect(map).toHaveFeature({ layer: 'places', id: 6, where: { name: 'Foxtrot' } });
      await page.locator('#remove').click();
      await expect(map).not.toHaveFeature({ layer: 'places', where: { name: 'Foxtrot' } });
      await page.locator('#toggle-zones').click();
      await expect(map).not.toHaveFeature({ layer: 'zones' });
    });

    test('act: click and hover a point, click a polygon, click a line', async ({ map, page }) => {
      await map.feature({ layer: 'places', where: { name: 'Bravo' } }).click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');
      await map.feature({ layer: 'places', id: 3 }).hover();
      await baseExpect(page.getByTestId('hovered')).toHaveText('Charlie');
      await map.feature({ layer: 'zones', where: { zone: 'south' } }).click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('zones:south');
      await map.feature({ layer: 'roads', id: 30 }).click(); // no handler: must simply not throw
    });

    test('occlusion: a point under a polygon is refused, and says what covers it', async ({ map, page }) => {
      const echo = map.feature({ layer: 'places', where: { name: 'Echo' } });
      const err = await echo.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('occluded');
      expect(err?.message).toContain('cover');
      await echo.click({ force: true });
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Echo');
    });

    test('visibility: an opacity-0 feature is rendered but not visible', async ({ map }) => {
      await expect(map).not.toHaveFeature({ layer: 'ghosts' });
      await expect(map).toHaveFeature({ layer: 'ghosts' }, { visible: 'any' });
      await expect(map.feature({ layer: 'ghosts', visible: 'any' })).not.toBeVisibleOnMap();
      await expect(map.feature({ layer: 'places', id: 1 })).toBeVisibleOnMap();
      const err = await map.feature({ layer: 'ghosts' }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('circle-opacity');
    });

    test('pixel probe: ground truth on every version; a version without redraw() says how it was done', async ({ map, page }) => {
      await expect(map.feature({ layer: 'places', id: 1 })).toBeVisibleOnMap({ pixels: true });
      await expect(map).toHaveLayerPixels('cover', { at: { lng: 34.86, lat: 32.11 } });
      await expect(map).not.toHaveLayerPixels('cover', { at: { lng: 34.8, lat: 32.0 } });
      const sync = await page.evaluate(() => typeof (window as any).__geowright_maps.main.redraw === 'function');
      const note = 'no synchronous redraw()';
      if (sync) expect(await map.snapshot()).not.toContain(note);
      else expect(await map.snapshot()).toContain(note);
    });

    // the probe compares the pixels with and without the layer. Pixels that change by themselves (an animation
    // under the feature; on Mapbox GL v1 the reads are two REAL frames apart) are no evidence: a control read decides.
    test('pixel probe: pixels that change by themselves are no evidence (control read)', async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('b6', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 60, properties: {}, geometry: { type: 'Point', coordinates: [34.77, 32.03] } }] } });
        // no paint transition: the pixels change only when the app changes them (MapLibre 2–4 advance a transition only
        // on a style change, which the probe's own hide is — a residual, docs/DESIGN.md)
        m.addLayer({ id: 'b6-under', type: 'circle', source: 'b6', paint: { 'circle-radius': 24, 'circle-color': '#000', 'circle-color-transition': { duration: 0 } } });
        // paints (alpha > 0) but changes no pixel a user could see
        m.addLayer({ id: 'b6', type: 'circle', source: 'b6', paint: { 'circle-radius': 12, 'circle-color': 'rgba(255, 0, 0, 0.0001)' } });
        let i = 0;
        const tick = () => {
          m.setPaintProperty('b6-under', 'circle-color', i++ % 2 ? '#000' : '#fff');
          requestAnimationFrame(tick);
        };
        tick();
      });
      const e = await expect(map.feature({ layer: 'b6', id: 60 })).toBeVisibleOnMap({ timeout: 3000 }).then(() => null, (e: Error) => e);
      expect(e, 'toBeVisibleOnMap passed for a feature that changes no pixel, because the pixels under it change by themselves').not.toBeNull();
    });

    // Hidden by `visibility`, the probed layer's source reloaded and the feature left the hit test for a while. Hidden
    // by its opacity (with a zero transition, the app's own put back after) nothing reloads, on every version.
    test('pixel probe: hides by opacity — no source reload, the feature is still in the hit test right after', async ({ map, page }) => {
      await page.evaluate(() => (window as any).__geowright_maps.main.setPaintProperty('zones', 'fill-opacity-transition', { duration: 5000, delay: 0 }));
      for (const [q, source] of [[{ layer: 'zones', id: 10 }, 'zones'], [{ layer: 'parcels', id: 500 }, 'parcels']] as const) {
        await map.waitForIdle();
        const r = await page.evaluate(
          async ({ q, source }) => {
            const m = (window as any).__geowright_maps.main;
            let reloads = 0;
            const onData = (e: { sourceId?: string; type: string; tile?: unknown }) => void (e.sourceId === source && (e.type === 'sourcedataloading' || e.tile) && reloads++);
            m.on('sourcedataloading', onData);
            m.on('sourcedata', onData);
            const p = await (window as any).__geowright.pixelProbe('main', q);
            if (!p.ok) throw new Error(p.message);
            const hitRightAfter = m.queryRenderedFeatures([p.surface.x, p.surface.y], { layers: [q.layer] }).length > 0;
            const loadedRightAfter = m.isSourceLoaded(source);
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
            m.off('sourcedataloading', onData);
            m.off('sourcedata', onData);
            return { drawn: p.diff > 0, hitRightAfter, loadedRightAfter, reloads };
          },
          { q, source },
        );
        baseExpect({ layer: q.layer, ...r }).toEqual({ layer: q.layer, drawn: true, hitRightAfter: true, loadedRightAfter: true, reloads: 0 });
      }
      // put back: MapLibre right after its synchronous redraw(), Mapbox GL 1 after the next frame
      const paint = () => page.evaluate(() => ['fill-opacity', 'fill-opacity-transition'].map((p) => (window as any).__geowright_maps.main.getPaintProperty('zones', p)));
      await baseExpect.poll(paint).toEqual([0.8, { duration: 5000, delay: 0 }]);
    });

    // Decision 0022 on every version: an image layer drawn above a feature. (A 64px image: an 8px one with 'raster-resampling': 'nearest'
    // is drawn solid black by MapLibre 2–5 and Mapbox GL 1, hole and all — and the probe then rightly says covered.) Opaque: refused, and named; translucent, or opaque with a
    // transparent hole over the feature: the click lands (a pixel probe decides, not the style).
    test('pixel-only layers above a feature: opaque refused and named; translucent, or a hole, lets the click through', async ({ map, page }) => {
      const bravo = { lng: 34.8, lat: 32.08 };
      const veil = (o: { opacity: number; hole?: boolean }) =>
        page.evaluate(({ o, at }) => {
          const m = (window as any).__geowright_maps.main;
          if (m.getLayer('veil')) m.removeLayer('veil');
          if (m.getSource('veil')) m.removeSource('veil');
          const c = document.createElement('canvas');
          c.width = c.height = 64;
          const g = c.getContext('2d')!;
          g.fillStyle = '#888';
          g.fillRect(0, 0, 64, 64);
          if (o.hole) g.clearRect(16, 16, 32, 32);
          const d = 0.01;
          m.addSource('veil', { type: 'image', url: c.toDataURL(), coordinates: [[at.lng - d, at.lat + d], [at.lng + d, at.lat + d], [at.lng + d, at.lat - d], [at.lng - d, at.lat - d]] });
          m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': o.opacity, 'raster-fade-duration': 0 } });
          document.getElementById('clicked')!.textContent = '-';
        }, { o, at: bravo });
      const target = map.feature({ layer: 'places', where: { name: 'Bravo' } });

      await veil({ opacity: 1 });
      await expect(map, 'the premise: the veil is drawn over Bravo').toHaveLayerPixels('veil', { at: bravo });
      const err = await target.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      baseExpect(err?.message.split('\n\n')[0]).toMatch(/occluded: .*raster layer "veil", drawn above "places"/);
      await baseExpect(page.getByTestId('clicked')).toHaveText('-');

      await veil({ opacity: 0.5 });
      await expect(map).toHaveLayerPixels('veil', { at: bravo });
      await target.click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');

      await veil({ opacity: 1, hole: true });
      await expect(map, 'the premise: the image is drawn around Bravo').toHaveLayerPixels('veil', { at: { lng: bravo.lng - 0.008, lat: bravo.lat + 0.008 } });
      await target.click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');
    });

    // Decision 0022 on every version: a heatmap's hit (MapLibre >= 5 hit-tests its whole radius, drawn or not) is never an
    // occluder; the gate and the probe decide. Drawing nothing (opacity 0) it hides nothing; translucent, the probe sees
    // the target through it. On its target's OWN source, with the target's opacity data-driven (the probe reloads that
    // source), the verdict still holds for the retry.
    test('pixel-only layers: a heatmap over a feature hides it only by its pixels, on any source', async ({ map, page }) => {
      const heat = (o: { opacity: number; shared?: boolean }) =>
        page.evaluate((o) => {
          const m = (window as any).__geowright_maps.main;
          if (m.getLayer('heat')) m.removeLayer('heat');
          if (m.getSource('heat')) m.removeSource('heat');
          if (o.shared) m.setPaintProperty('places', 'circle-opacity', ['case', ['==', ['get', 'kind'], 'none'], 0.5, 1]);
          else m.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 900, properties: { w: 1 }, geometry: { type: 'Point', coordinates: [34.8, 32.08] } }] } });
          m.addLayer({ id: 'heat', type: 'heatmap', source: o.shared ? 'places' : 'heat', paint: { 'heatmap-radius': 30, 'heatmap-opacity': o.opacity } });
          document.getElementById('clicked')!.textContent = '-';
        }, o);
      const bravo = map.feature({ layer: 'places', where: { name: 'Bravo' } });
      for (const o of [{ opacity: 0 }, { opacity: 0.3 }, { opacity: 0.4, shared: true }]) {
        await heat(o);
        await map.waitForIdle();
        const e = await bravo.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e.message.split('\n\n')[0]);
        baseExpect({ ...o, error: e }).toEqual({ ...o, error: null });
        await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');
      }
    });

    // Decision 0022's other cases on every version (Mapbox GL v1 has its own code for them: a probe over real frames, a
    // reload that starts a frame later): a pixel-only layer BELOW the features (the page's background) costs no probe; a
    // veil shown as the pointer arrives is caught at the press; the action waits out a reload after a visibility probe.
    test('pixel-only layers: none above costs nothing; a veil shown at the press is caught; the reload after a probe is waited for', async ({ map, page }) => {
      const bravo = map.feature({ layer: 'places', where: { name: 'Bravo' } });
      await page.evaluate(() => {
        const w = window as any;
        w.__styledata = 0;
        w.__presses = 0;
        w.__geowright_maps.main.on('styledata', () => w.__styledata++);
        window.addEventListener('pointerdown', () => w.__presses++, true);
      });
      await bravo.click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');
      baseExpect(await page.evaluate(() => (window as any).__styledata), 'a background below the features: no probe').toBe(0);

      // a veil at opacity 0 (the gate leaves it out) shown by the app as the pointer arrives
      await page.evaluate(() => {
        const w = window as any;
        const m = w.__geowright_maps.main;
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d')!;
        g.fillStyle = '#888';
        g.fillRect(0, 0, 64, 64);
        const b = m.getBounds();
        m.addSource('veil', { type: 'image', url: c.toDataURL(), coordinates: [[b.getWest(), b.getNorth()], [b.getEast(), b.getNorth()], [b.getEast(), b.getSouth()], [b.getWest(), b.getSouth()]] });
        m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } });
      });
      await map.waitForIdle();
      await page.evaluate(() => {
        const w = window as any;
        const m = w.__geowright_maps.main;
        document.getElementById('clicked')!.textContent = '-';
        w.__presses = 0;
        window.addEventListener('mousemove', () => m.setPaintProperty('veil', 'raster-opacity', 1), { capture: true, once: true });
        window.addEventListener('pointerdown', () => void (w.__presses === 1 && setTimeout(() => m.setPaintProperty('veil', 'raster-opacity', 0))), true);
      });
      await bravo.click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');
      baseExpect(await page.evaluate(() => (window as any).__presses), 'the press under the veil was swallowed, the retry landed').toBe(2);

      // the veil translucent, the target's opacity data-driven: the probe hides it by visibility and its source reloads;
      // right after, the page takes the layer out for 400 ms (removed, added back as it was). One press: none was sent then.
      await page.evaluate(() => {
        const w = window as any;
        const m = w.__geowright_maps.main;
        m.setPaintProperty('veil', 'raster-opacity', 0.5);
        m.setPaintProperty('places', 'circle-opacity', ['case', ['==', ['get', 'kind'], 'none'], 0.5, 1]);
      });
      await map.waitForIdle();
      await page.evaluate(() => {
        const w = window as any;
        const m = w.__geowright_maps.main;
        document.getElementById('clicked')!.textContent = '-';
        w.__presses = 0;
        const set = m.setLayoutProperty.bind(m);
        let armed = true;
        m.setLayoutProperty = (layer: string, name: string, value: unknown, ...rest: unknown[]) => {
          set(layer, name, value, ...rest);
          if (armed && layer === 'places' && name === 'visibility' && value !== 'none') {
            armed = false;
            const spec = m.getStyle().layers.find((l: { id: string }) => l.id === 'places');
            setTimeout(() => {
              m.removeLayer('places');
              setTimeout(() => m.addLayer(spec, 'place-labels'), 400);
            });
          }
        };
      });
      await bravo.click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');
      baseExpect(await page.evaluate(() => (window as any).__presses), 'one press').toBe(1);
    });

    // `timeout: 0` means no timeout: a matcher's probe then has no deadline to take its budget from. On Mapbox GL v1 (no
    // redraw(), the probe waits for real frames) an Infinity budget made every frame "late" at once, and the matcher never
    // concluded (the test timeout ends it, if the fix is gone).
    test('toBeVisibleOnMap({ timeout: 0 }) and toHaveLayerPixels({ timeout: 0 }) conclude', async ({ map }) => {
      await expect(map.feature({ layer: 'places', where: { name: 'Bravo' } })).toBeVisibleOnMap({ timeout: 0 });
      await expect(map).toHaveLayerPixels('cover', { at: { lng: 34.86, lat: 32.11 }, timeout: 0 });
    });

    // A version without getLayersOrder() reports the style's layers from getStyle(), which leaves custom layers out: it
    // says so, since an action cannot check a custom layer drawn over its target there.
    test('a version without getLayersOrder() says that custom layers are not checked', async ({ map, page }) => {
      const has = await page.evaluate(() => typeof (window as any).__geowright_maps.main.getLayersOrder === 'function');
      const note = 'no getLayersOrder()';
      if (has) baseExpect(await map.snapshot()).not.toContain(note);
      else baseExpect(await map.snapshot()).toContain(note);
    });

    // style evaluation on every version — zoom- and feature-state-driven paint, a legacy { stops } function, promoteId.
    test('style evaluation: zoom and feature-state paint, legacy stops, promoteId', async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const pt = (code: number, lng: number, lat: number) => ({ type: 'Feature', properties: { code }, geometry: { type: 'Point', coordinates: [lng, lat] } });
        m.addSource('b16', { type: 'geojson', promoteId: 'code', data: { type: 'FeatureCollection', features: [pt(71, 34.81, 32.07), pt(72, 34.79, 32.07)] } });
        m.addLayer({ id: 'b16-state', type: 'circle', source: 'b16', paint: { 'circle-radius': 8, 'circle-opacity': ['case', ['boolean', ['feature-state', 'gone'], false], 0, 1] } });
        m.addLayer({ id: 'b16-zoom', type: 'circle', source: 'b16', paint: { 'circle-radius': 5, 'circle-opacity': ['step', ['zoom'], 0, 12, 1] } });
        m.addLayer({ id: 'b16-stops', type: 'circle', source: 'b16', paint: { 'circle-radius': { stops: [[10, 0], [11.5, 0], [12, 4]] } } });
      });
      await expect(map).toHaveFeature({ layer: 'b16-state', id: 71 }); // promoteId: the id is the "code" property
      await page.evaluate(() => (window as any).__geowright_maps.main.setFeatureState({ source: 'b16', id: 71 }, { gone: true }));
      await expect(map).not.toHaveFeature({ layer: 'b16-state', id: 71 });
      await expect(map).toHaveFeature({ layer: 'b16-state', id: 71 }, { visible: 'any' });
      await expect(map).toHaveFeature({ layer: 'b16-state', id: 72 });
      await expect(map).not.toHaveFeature({ layer: 'b16-zoom' });
      await expect(map).not.toHaveFeature({ layer: 'b16-stops' });
      await page.evaluate(() => (window as any).__geowright_maps.main.jumpTo({ zoom: 12.5 }));
      await expect(map.features({ layer: 'b16-zoom' })).toHaveFeatureCount(2);
      await expect(map.features({ layer: 'b16-stops' })).toHaveFeatureCount(2);
    });

    test('idle diagnosis: an app that re-sets a source in a loop is told so when it is not idle', async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const data = (t: number) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [34.8 + 0.01 * Math.sin(t / 300), 32.05] } }] });
        m.addSource('loop', { type: 'geojson', data: data(0) });
        m.addLayer({ id: 'loop', type: 'circle', source: 'loop', paint: { 'circle-radius': 6 } });
        const tick = (t: number) => {
          m.getSource('loop').setData(data(t));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      // Measured on this matrix: every version can fire 'idle' between two setData calls of such a loop now and then
      // (Mapbox GL 1.13 and MapLibre 2–5 were each seen idle within 2.5 s in some runs; 6 was not). So: if the map was not idle, the reason
      // given must be the loop — never "loading" or "slow".
      const e = await map.waitForIdle({ timeout: 2500 }).then(() => null, (e: Error) => e);
      if (e) expect(e.message).toMatch(/the app keeps replacing the data of source\(s\) loop \(\d+ times in \d+ms\)/);
    });

    test('snapshot: layers, entities, colours, clickable pixels', async ({ map }) => {
      const text = await map.snapshot();
      expect(text).toContain('[places] 5 circle entities');
      expect(text).toMatch(/circle-color is data-driven: .*blue\(#1976d2\)×3.*red\(#d32f2f\)×2/);
      expect(text).toMatch(/#2 Point @\(\d+,\d+\).* name="Bravo"/);
      expect(text).toMatch(/#5 Point @\(\d+,\d+\) covered-by:cover#20/);
      expect(text).toContain('also drawn by: place-labels');
      expect(text).toContain('[parcels] 3 fill entities');
    });

    test('markers and popups', async ({ map, page }) => {
      const marker = await map.marker({ at: { lng: 34.72, lat: 32.11 } });
      await marker.click();
      await expect(map).toHavePopup({ at: { lng: 34.72, lat: 32.11 }, text: 'Marker popup', tolerancePx: 40 });
      await baseExpect(await map.popup()).toHaveText('Marker popup');
      await page.keyboard.press('Escape');
    });

    test('source data: off-screen features are known, named in failures, and reachable with autoPan', async ({ map, page }) => {
      // GeoJSONSource.getData() is MapLibre >= 4; below that the adapter reads the data back through serialize().
      const golf = map.feature({ layer: 'places', where: { name: 'Golf' } });
      const err = await golf.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('exist in the source but are not rendered');
      expect(await map.snapshot()).toMatch(/1 feature\(s\) OUTSIDE the viewport .*#7 to the north-east/);
      await golf.click({ autoPan: true });
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Golf');
    });

    test('source data given as a URL: off-screen features known where getData() exists, "unknowable" said where not', async ({ map, page }) => {
      const at = (name: string, lng: number, lat: number) => ({ type: 'Feature', id: name.length, properties: { name }, geometry: { type: 'Point', coordinates: [lng, lat] } });
      await page.route('**/url-places.geojson', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [at('Hotel', 34.82, 32.07), at('India', 35.6, 32.45)] }) }));
      const getData = await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('url-places', { type: 'geojson', data: `${location.origin}/url-places.geojson` });
        m.addLayer({ id: 'url-places', type: 'circle', source: 'url-places', paint: { 'circle-radius': 7, 'circle-color': '#6a1b9a' } });
        return typeof m.getSource('url-places').getData === 'function';
      });
      expect(getData, 'GeoJSONSource.getData() is MapLibre >= 4').toBe(!/^(mapbox-gl-1|maplibre-gl-[23])$/.test(lib.alias));
      await expect(map).toHaveFeature({ layer: 'url-places', where: { name: 'Hotel' } });
      await map.waitForIdle();
      const india = map.feature({ layer: 'url-places', where: { name: 'India' } });
      const err = await india.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      const snap = await map.snapshot();
      const note = 'source(s) url-places: this map library version has no GeoJSONSource.getData() and the source was given a URL — features outside the viewport and full geometries are unknowable';
      if (getData) {
        expect(err?.message).toContain('exist in the source but are not rendered');
        expect(snap).not.toContain(note);
        expect(snap).toMatch(/\[source url-places\] 1 feature\(s\) OUTSIDE the viewport .*#5 to the north-east/);
        await india.click({ autoPan: true });
      } else {
        expect(err?.message).not.toContain('exist in the source but are not rendered');
        expect(err?.message).toContain(note);
        expect(snap).toContain(note);
      }
    });

    test('vector tiles: assert and act on features that come from tiles', async ({ map, page }) => {
      await expect(map.features({ layer: 'parcels' })).toHaveFeatureCount(3);
      await map.feature({ layer: 'parcels', where: { owner: 'city' } }).click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('parcels:P1');
    });

    test('camera and locations: toHaveView, clickAt, drag pans, geometry from the source', async ({ map, page }) => {
      await expect(map).toHaveView({ zoom: 11, center: { lng: 34.8, lat: 32.08 } });
      await map.clickAt({ lng: 34.72, lat: 32.035 });
      await baseExpect(page.getByTestId('clicked')).toHaveText('zones:north');
      await map.dragAt({ lng: 34.8, lat: 32.0 }, { lng: 34.78, lat: 32.0 });
      const view = await map.viewState();
      expect(view.center.lng).toBeGreaterThan(34.81);
      await expect(map.feature({ layer: 'zones', id: 10 })).toHaveGeometry({ type: 'Polygon', coordinates: [[[34.7, 32.02], [34.74, 32.02], [34.74, 32.05], [34.7, 32.05], [34.7, 32.02]]] });
    });
  });
}

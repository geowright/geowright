import { test, expect } from './fixtures';
import { geowright } from '../src/playwright';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * "Rendered is not visible": MapLibre's queryRenderedFeatures also returns features that the style
 * paints invisibly. The demo's sensors layer hides archived / muted sensors through a data-driven
 * paint expression (NOT a filter), keeps an opacity-0 hit area, and has an icon that is transparent.
 */
test.describe('visibility', () => {
  test.beforeEach(async ({ page, map }) => {
    await page.getByTestId('toggle-sensors').check();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 501 });
  });

  test('visible is the default; MapLibre\'s looser "rendered" is { visible: \'any\' }', async ({ map }) => {
    // The trap this feature exists for: the archived sensor is "there" as far as MapLibre is concerned.
    await expect(map).toHaveFeature({ layer: 'sensors', id: 502 }, { visible: 'any' });
    await expect(map).not.toHaveFeature({ layer: 'sensors', id: 502 }); // a user cannot see it
    await expect(map).toHaveFeature({ layer: 'sensors', id: 502, visible: false });
    await expect(map.features({ layer: 'sensors' })).toHaveFeatureCount(2);
    await expect(map.features({ layer: 'sensors', visible: 'any' })).toHaveFeatureCount(3);
    await expect(map.features({ layer: 'sensor-zones' })).toHaveFeatureCount(0); // fill-opacity: 0
    await expect(map.features({ layer: 'sensor-zones', visible: 'any' })).toHaveFeatureCount(1);

    const [archived] = await map.features({ layer: 'sensors', id: 502, visible: 'any' }).all();
    expect(archived.visible).toBe(false);
    expect(archived.invisibleBecause).toContain('circle-opacity evaluates to 0');
  });

  test('toBeVisibleOnMap follows data-driven paint after an async UI action', async ({ map, page }) => {
    const sensor = map.feature({ layer: 'sensors', id: 501 });
    await expect(sensor).toBeVisibleOnMap();
    await page.getByTestId('sensor-archive-501').click(); // async setData, 100–400ms
    await expect(sensor).not.toBeVisibleOnMap();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 501, visible: 'any' }); // still "rendered"
    await page.getByTestId('sensor-archive-501').click();
    await expect(sensor).toBeVisibleOnMap();
  });

  test('feature-state driven paint is evaluated too', async ({ map, page }) => {
    const sensor = map.feature({ layer: 'sensors', id: 503 });
    await expect(sensor).toBeVisibleOnMap();
    await page.getByTestId('sensor-mute-503').click();
    await expect(sensor).not.toBeVisibleOnMap();
    await expect(map).toHaveFeature({ layer: 'sensors', id: 503, visible: false });
  });

  test('pixel probe catches what paint evaluation cannot: a fully transparent icon', async ({ map }) => {
    const ghost = map.feature({ layer: 'sensors-ghost', id: 504 });
    expect((await ghost.info()).visible).toBe(true); // the style does ask for an icon
    await expect(ghost).toBeVisibleOnMap({ pixels: false });
    await expect(ghost).not.toBeVisibleOnMap();
    const err = await expect(ghost).toBeVisibleOnMap({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('hiding layer "sensors-ghost" changes nothing');
  });

  test('the pixel probe leaves the map as it found it', async ({ map, page }) => {
    await expect(map.feature({ layer: 'alerts', id: 1 })).toBeVisibleOnMap();
    await expect(map.feature({ layer: 'parcels', id: 101 })).toBeVisibleOnMap();
    await expect(map.feature({ layer: 'stations-points', where: { name: 'Substation Alpha' } })).toBeVisibleOnMap();
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
    await expect(map.features({ layer: 'parcels' })).toHaveFeatureCount(6);
    await map.feature({ layer: 'alerts', id: 1 }).click();
    await expect(page.getByTestId('popup')).toContainText('Gas leak');
  });

  test('the pixel probe restores a visibility EXPRESSION, not the constant "visible"', async ({ map, page }) => {
    // MapLibre >= 5.16: layout visibility may be an expression on global state. The probe hides the layer and shows
    // it again; it used to write back "visible", which replaced the app's expression (and turned ON a layer the
    // app had hidden, for toHaveLayerPixels).
    const visibility = ['case', ['global-state', 'showCover'], 'visible', 'none'];
    await page.evaluate((visibility) => {
      const m = (window as any).__geowright_maps.main;
      m.setGlobalStateProperty('showCover', true);
      m.addSource('cover', { type: 'geojson', data: { type: 'Feature', id: 9, properties: {}, geometry: { type: 'Polygon', coordinates: [[[34.76, 32.07], [34.775, 32.07], [34.775, 32.085], [34.76, 32.085], [34.76, 32.07]]] } } });
      m.addLayer({ id: 'cover', type: 'fill', source: 'cover', layout: { visibility }, paint: { 'fill-color': '#000' } });
    }, visibility);
    await expect(map.feature({ layer: 'cover', id: 9 })).toBeVisibleOnMap();
    expect(await page.evaluate(() => (window as any).__geowright_maps.main.getLayoutProperty('cover', 'visibility'))).toEqual(visibility);

    await page.evaluate(() => (window as any).__geowright_maps.main.setGlobalStateProperty('showCover', false));
    await expect(map).not.toHaveLayerPixels('cover', { at: { lng: 34.7675, lat: 32.0775 } });
    expect(await page.evaluate(() => (window as any).__geowright_maps.main.getLayoutProperty('cover', 'visibility'))).toEqual(visibility);
    await expect(map).not.toHaveFeature({ layer: 'cover', id: 9 }); // still hidden, as the app wants
  });

  test('actions refuse an invisible feature and say why; force overrides', async ({ map, page }) => {
    const err = await map
      .feature({ layer: 'sensors', id: 502 })
      .click({ timeout: FAIL_FAST_MS })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toContain('invisible: feature is rendered but not visible: circle-opacity evaluates to 0');
    expect(err?.message).toContain('[NOT VISIBLE: circle-opacity evaluates to 0');
    await map.feature({ layer: 'sensors', id: 502 }).click({ force: true }); // real click still lands
    await expect(page.getByTestId('popup')).toHaveCount(0); // (the demo has no popup for sensors)
  });

  test('failure message explains that a match exists but cannot be seen', async ({ map }) => {
    const err = await expect(map)
      .toHaveFeature({ layer: 'sensors', where: { name: 'Sensor Birch' } }, { timeout: FAIL_FAST_MS })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toContain('1 feature(s) match but are NOT VISIBLE: sensors#502 (circle-opacity evaluates to 0');
    // …and WHY: the property, its value, the expression branch, the zoom (tests/why-invisible.spec.ts has one per kind)
    expect(err?.message).toContain('-> sensors#502 is not visible at zoom 12: circle-opacity is 0 because the case took its branch 1 (the first true condition: ["any",["==",["get","status"],"archived"]');
  });

  test('an INVISIBLE feature on top is not an occluder; a visible one is', async ({ map, page }) => {
    // What many apps do: a transparent hit area / highlight layer from ANOTHER source lying over the data.
    const cover = (opacity: number) =>
      page.evaluate((o) => {
        const m = (window as any).__geowright_maps.main;
        if (m.getLayer('cover')) m.removeLayer('cover');
        if (!m.getSource('cover')) {
          m.addSource('cover', { type: 'geojson', data: { type: 'Feature', properties: { what: 'cover' }, geometry: { type: 'Polygon', coordinates: [[[34.6, 32.0], [34.95, 32.0], [34.95, 32.2], [34.6, 32.2], [34.6, 32.0]]] } } });
        }
        m.addLayer({ id: 'cover', type: 'fill', source: 'cover', paint: { 'fill-color': '#000', 'fill-opacity': o } });
      }, opacity);
    await cover(0);
    await expect(map).toHaveFeature({ layer: 'cover', visible: 'any' });
    await map.feature({ layer: 'parcels', id: 101 }).click(); // nobody can SEE the cover: the parcel is what the user clicks
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '101');
    expect(await map.snapshot({ layers: ['parcels'] })).not.toContain('covered-by:cover');

    await cover(0.6);
    const err = await map.feature({ layer: 'parcels', id: 102 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/covered by another feature; topmost is cover/);
  });

  test('a layer hidden by fill-layer-opacity / line-layer-opacity 0 (MapLibre 6) is not visible, and the message says so', async ({ map, page }) => {
    await expect(map).toHaveFeature({ layer: 'parcels', id: 101 });
    await expect(map).toHaveFeature({ layer: 'parcels-outline', id: 101 });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.setPaintProperty('parcels', 'fill-layer-opacity', 0);
      m.setPaintProperty('parcels-outline', 'line-layer-opacity', 0);
    });
    await expect(map).not.toHaveFeature({ layer: 'parcels', id: 101 });
    await expect(map).not.toHaveFeature({ layer: 'parcels-outline', id: 101 });
    await expect(map).toHaveFeature({ layer: 'parcels', id: 101, visible: false });
    const err = await expect(map).toHaveFeature({ layer: 'parcels', id: 101 }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('NOT VISIBLE: parcels#101 (fill-layer-opacity evaluates to 0');
    const [outline] = await map.features({ layer: 'parcels-outline', id: 101, visible: 'any' }).all();
    expect(outline.invisibleBecause).toContain('line-layer-opacity evaluates to 0');
  });

  test('snapshot marks invisible entities', async ({ map }) => {
    const snap = await map.snapshot();
    expect(snap).toMatch(/#502 Point .*NOT-VISIBLE\(circle-opacity evaluates to 0/);
    expect(snap).not.toMatch(/#501 Point .*NOT-VISIBLE/);
    expect(snap).toMatch(/#601 Polygon .*NOT-VISIBLE\(fill-opacity evaluates to 0\)/);
  });

  // every probe hides and re-shows the layer (MapLibre then re-prepares it). A `.not` waiting on a visible feature
  // used to probe on every poll (about twice a second); the result is now reused while nothing observable changed.
  test('a waiting .not.toBeVisibleOnMap does not re-probe on every poll', async ({ map, page }) => {
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const set = m.setPaintProperty;
      (window as any).__probes = 0;
      // counted, not changed: the probe hides the layer with exactly this call (its opacity is not data-driven)
      m.setPaintProperty = function (layer: string, name: string, value: unknown, ...rest: unknown[]) {
        if (layer === 'alerts' && name === 'circle-opacity' && value === 0) (window as any).__probes++;
        return set.call(this, layer, name, value, ...rest);
      };
    });
    const e = await expect(map.feature({ layer: 'alerts', id: 1 })).not.toBeVisibleOnMap({ timeout: 4000 }).then(() => null, (e: Error) => e);
    expect(e, '.not.toBeVisibleOnMap passed for a visible alert').not.toBeNull();
    const probes = await page.evaluate(() => (window as any).__probes);
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThanOrEqual(3);
  });

  // "could not decide" is not "not visible"
  test('.not.toBeVisibleOnMap on a query matching several VISIBLE features fails (strict mode)', async ({ map }) => {
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
    const e = await expect(map.feature({ layer: 'alerts' })).not.toBeVisibleOnMap({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e, '.not.toBeVisibleOnMap passed while 3 alerts are visible').not.toBeNull();
    expect(e?.message).toContain('strict mode violation: 3 features match');
  });

  test('.not.toHaveLayerPixels on a layer that does not exist fails, and says so', async ({ map }) => {
    const e = await expect(map).not.toHaveLayerPixels('no-such-layer', { at: { lng: 34.78, lat: 32.08 }, timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e, '.not.toHaveLayerPixels passed for a layer that does not exist').not.toBeNull();
    expect(e?.message).toContain('layer "no-such-layer" does not exist');
  });

  test('the pixel probe of toBeVisibleOnMap honours the map-level ignoreLayers', async ({ map, page }) => {
    // a translucent highlight drawn over parcel 106: the parcel shows through it, and the app declares the highlight
    // a layer that never counts as an occluder
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('veil', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[34.79, 32.05], [34.81, 32.05], [34.81, 32.07], [34.79, 32.07], [34.79, 32.05]]] } } });
      m.addLayer({ id: 'veil', type: 'fill', source: 'veil', paint: { 'fill-color': '#fff', 'fill-opacity': 0.3 } });
    });
    await map.waitForIdle();
    const lenient = geowright(page, { ignoreLayers: ['veil'] });
    await expect(lenient.feature({ layer: 'parcels', id: 106 })).toBeVisibleOnMap({ timeout: 3000 });
  });
});

/**
 * the evaluator must agree with what MapLibre DRAWS. Ground truth is the pixel probe (toHaveLayerPixels).
 * A zoom-and-data ("composite") paint expression is evaluated by MapLibre at the TILE zoom and z+1 and blended by
 * the camera zoom; `within` / `distance` need the tile geometry, which the evaluator does not have.
 */
test.describe('the paint evaluator agrees with the renderer', () => {
  // `drawn`: what the canvas shows, and only a verdict counts: toHaveLayerPixels passing says drawn, .not passing says
  // not drawn. A probe that reaches no verdict (the page did not answer, the point is off the surface) fails the test with
  // its own message; it used to read as "the canvas shows nothing", and a `false` case passed unchecked.
  const agree = async (map: import('../src/playwright').MapHandle, layer: string, at: { lng: number; lat: number }, drawn: boolean) => {
    await map.waitForIdle();
    // counted BEFORE the probe: a probe hides and re-shows the layer, and MapLibre then reloads its source
    const found = await map.features({ layer }).count();
    if (drawn) await expect(map, 'the canvas shows it').toHaveLayerPixels(layer, { at, radiusPx: 6 });
    else await expect(map, 'the canvas does not show it').not.toHaveLayerPixels(layer, { at, radiusPx: 6 });
    expect(found > 0, `geowright says ${layer} is ${found > 0 ? 'visible' : 'invisible'}; the canvas ${drawn ? 'shows it' : 'does not'}`).toBe(drawn);
  };

  test('B2: a zoom-and-data step expression is judged at the tile zoom, as MapLibre draws it', async ({ map, page }) => {
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('b2', { type: 'geojson', data: { type: 'Feature', properties: { o: 1 }, geometry: { type: 'Point', coordinates: [34.8, 32.09] } } });
      m.addLayer({ id: 'b2', type: 'circle', source: 'b2', paint: { 'circle-radius': 12, 'circle-color': '#f00', 'circle-opacity': ['step', ['zoom'], 0, 11.5, ['get', 'o']] } });
      m.jumpTo({ zoom: 11.7 });
    });
    await agree(map, 'b2', { lng: 34.8, lat: 32.09 }, false); // tile zoom 11: the step's base output, 0
  });

  test('B2: a zoom-and-data interpolate is blended between tile zooms, not read at the camera zoom', async ({ map, page }) => {
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('b2i', { type: 'geojson', data: { type: 'Feature', properties: { o: 1 }, geometry: { type: 'Point', coordinates: [34.8, 32.09] } } });
      m.addLayer({ id: 'b2i', type: 'circle', source: 'b2i', paint: { 'circle-radius': 12, 'circle-color': '#f00', 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 11.6, ['get', 'o']] } });
      m.jumpTo({ zoom: 11.2 });
    });
    await agree(map, 'b2i', { lng: 34.8, lat: 32.09 }, true); // 0 at z11, 1 at z12, blended at 0.2
  });

  test('B5: `within` in paint is evaluated like MapLibre (points inside the area are drawn)', async ({ map, page }) => {
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const area = { type: 'Polygon', coordinates: [[[34.7, 32.0], [34.9, 32.0], [34.9, 32.2], [34.7, 32.2], [34.7, 32.0]]] };
      m.addSource('b5', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [34.8, 32.1] } } });
      m.addLayer({ id: 'b5', type: 'circle', source: 'b5', paint: { 'circle-radius': 12, 'circle-color': '#00f', 'circle-opacity': ['case', ['within', area], 1, 0] } });
    });
    await agree(map, 'b5', { lng: 34.8, lat: 32.1 }, true);
    expect(await map.snapshot()).toContain('visibility unknown for layer b5: circle-opacity');
  });
});


/**
 * The pixel probe hides the layer by its opacity. Hidden by `visibility: none`, MapLibre reloads the layer's
 * source, and the tiles that come back lack the layer: right after the probe the feature was missing from the hit test.
 * A paint change reloads nothing unless the value is data-driven; only then does the probe still hide by visibility.
 */
test.describe('the pixel probe hides a layer by its opacity', () => {
  test.beforeEach(async ({ page, map }) => {
    await page.getByTestId('toggle-sensors').check();
    await map.waitForIdle();
  });

  type Q = { layer: string; id: number };
  /** Probe `q` (as toBeVisibleOnMap does) and say what the probed source did, and what the hit test sees right after. */
  const probe = (page: import('@playwright/test').Page, q: Q, source: string) =>
    page.evaluate(
      async ({ q, source }) => {
        const m = (window as any).__geowright_maps.main;
        // a reload shows as 'sourcedataloading' (tiled sources) or as tiles arriving again ('sourcedata' with a tile)
        let reloads = 0;
        const onLoading = (e: { sourceId?: string; type: string; tile?: unknown }) => void (e.sourceId === source && (e.type === 'sourcedataloading' || e.tile) && reloads++);
        m.on('sourcedataloading', onLoading);
        m.on('sourcedata', onLoading);
        const r = await (window as any).__geowright.pixelProbe('main', q);
        if (!r.ok) throw new Error(`${q.layer} ${q.id}: ${r.message}`);
        const hitRightAfter = m.queryRenderedFeatures([r.surface.x, r.surface.y], { layers: [q.layer] }).length > 0;
        const loadedRightAfter = m.isSourceLoaded(source);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        m.off('sourcedataloading', onLoading);
        m.off('sourcedata', onLoading);
        return { drawn: r.diff > 0, hitRightAfter, loadedRightAfter, reloads };
      },
      { q, source },
    );

  // its own source and footprint: extruded over the parcels, it would hide them (and the probe would rightly say so)
  const addExtrusion = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const box = [[34.74, 32.1], [34.746, 32.1], [34.746, 32.104], [34.74, 32.104], [34.74, 32.1]];
      m.addSource('blocks', { type: 'geojson', data: { type: 'Feature', id: 88, properties: {}, geometry: { type: 'Polygon', coordinates: [box] } } });
      m.addLayer({ id: 'blocks', type: 'fill-extrusion', source: 'blocks', paint: { 'fill-extrusion-color': '#37474f', 'fill-extrusion-height': 40 } });
    });
  const TARGETS = [
    { q: { layer: 'parcels', id: 101 }, source: 'parcels', opacity: 'fill-opacity', what: 'GeoJSON fill' },
    { q: { layer: 'buildings', id: 1013 }, source: 'buildings', opacity: 'fill-opacity', what: 'vector-tile fill' },
    { q: { layer: 'roads', id: 201 }, source: 'roads', opacity: 'line-opacity', what: 'line' },
    { q: { layer: 'alerts', id: 1 }, source: 'alerts', opacity: 'circle-opacity', what: 'circle' },
    { q: { layer: 'stations-points', id: 329 }, source: 'stations', opacity: 'icon-opacity', what: 'symbol (icon)' },
    { q: { layer: 'blocks', id: 88 }, source: 'blocks', opacity: 'fill-extrusion-opacity', what: 'fill-extrusion' },
  ];

  test('a probe reloads no source, and the feature is still in the hit test right after it', async ({ map, page }) => {
    await addExtrusion(page);
    await map.waitForIdle();
    for (const t of TARGETS) {
      await map.waitForIdle();
      expect({ target: t.what, ...(await probe(page, t.q, t.source)) }).toEqual({ target: t.what, drawn: true, hitRightAfter: true, loadedRightAfter: true, reloads: 0 });
    }
  });

  test('hiding by opacity and hiding by visibility give the same verdict, for every layer type', async ({ map, page }) => {
    await addExtrusion(page);
    // not fill-extrusion: its opacity cannot be data-driven, so it is always hidden by opacity — and at 0 MapLibre 2–6 and
    // Mapbox GL 1 return from drawing it before drawing anything, as for a hidden layer
    const cases = [
      ...TARGETS.filter((t) => t.what !== 'fill-extrusion').map((t) => ({ ...t, drawn: true })),
      { q: { layer: 'sensors-ghost', id: 504 }, source: 'sensors', opacity: 'icon-opacity', what: 'a transparent icon', drawn: false },
    ];
    for (const t of cases) {
      await map.waitForIdle();
      const byOpacity = await probe(page, t.q, t.source);
      // the same value, made data-driven: now only `visibility` can hide the layer, and the source reloads
      await page.evaluate(({ layer, opacity }) => {
        const m = (window as any).__geowright_maps.main;
        m.setPaintProperty(layer, opacity, ['coalesce', ['get', '__not_a_property'], m.getPaintProperty(layer, opacity) ?? 1]);
      }, { layer: t.q.layer, opacity: t.opacity });
      await map.waitForIdle();
      const byVisibility = await probe(page, t.q, t.source);
      expect({ target: t.what, byOpacity: byOpacity.drawn, byVisibility: byVisibility.drawn, visibilityReloaded: byVisibility.reloads > 0 }).toEqual({ target: t.what, byOpacity: t.drawn, byVisibility: t.drawn, visibilityReloaded: true });
    }
  });

  test('the probe puts back the opacity and its transition, and the layer is drawn at full opacity right after', async ({ map, page }) => {
    const paint = {
      'circle-radius': 14,
      'circle-color': '#6a1b9a',
      'circle-opacity': 0.9,
      'circle-opacity-transition': { duration: 5000, delay: 0 },
      'circle-stroke-width': 3,
      'circle-stroke-color': '#000',
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 22, 0.8], // zoom-only: still no reload
    };
    await page.evaluate((paint) => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('fade', { type: 'geojson', data: { type: 'Feature', id: 77, properties: {}, geometry: { type: 'Point', coordinates: [34.745, 32.075] } } });
      m.addLayer({ id: 'fade', type: 'circle', source: 'fade', paint });
    }, paint);
    await map.waitForIdle();
    const first = await probe(page, { layer: 'fade', id: 77 }, 'fade');
    const after = await page.evaluate(async () => {
      const m = (window as any).__geowright_maps.main;
      // a second probe right away: had the restore faded in (over the app's 5 s), the layer would be drawn fainter now
      const diffs = [];
      for (let i = 0; i < 2; i++) diffs.push((await (window as any).__geowright.pixelProbe('main', { layer: 'fade', id: 77 })).diff);
      const read = (p: string) => m.getPaintProperty('fade', p);
      return {
        sameDiff: diffs[0] === diffs[1],
        'circle-opacity': read('circle-opacity'),
        'circle-opacity-transition': read('circle-opacity-transition'),
        'circle-stroke-opacity': read('circle-stroke-opacity'),
        'circle-stroke-opacity-transition': read('circle-stroke-opacity-transition') ?? null,
      };
    });
    expect(first).toEqual({ drawn: true, hitRightAfter: true, loadedRightAfter: true, reloads: 0 });
    expect(after).toEqual({
      sameDiff: true,
      'circle-opacity': 0.9,
      'circle-opacity-transition': { duration: 5000, delay: 0 },
      'circle-stroke-opacity': paint['circle-stroke-opacity'],
      'circle-stroke-opacity-transition': null,
    });
  });
});

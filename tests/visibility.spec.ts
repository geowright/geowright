import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { geowright, type MapHandle } from '../src/playwright';
import { FAIL_FAST_MS, PROBE_FAIL_FAST_MS } from './slow-machine';

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
    // The probe hides a layer by `visibility` only where its opacity cannot do it without a reload: a data-driven opacity,
    // or a type with no opacity the probe sets (a raster). With a constant opacity this test never reached the restore it
    // is named for, and passed with the expression replaced by "visible".
    const visibility = ['case', ['global-state', 'showCover'], 'visible', 'none'];
    const basemapVisibility = ['case', ['global-state', 'showBasemap'], 'visible', 'none'];
    const layout = (layer: string) => page.evaluate((layer) => (window as any).__geowright_maps.main.getLayoutProperty(layer, 'visibility'), layer);
    await page.evaluate(({ visibility, basemapVisibility }) => {
      const m = (window as any).__geowright_maps.main;
      m.setGlobalStateProperty('showCover', true);
      m.setGlobalStateProperty('showBasemap', true);
      m.setLayoutProperty('basemap', 'visibility', basemapVisibility);
      m.addSource('cover', { type: 'geojson', data: { type: 'Feature', id: 9, properties: { o: 1 }, geometry: { type: 'Polygon', coordinates: [[[34.76, 32.07], [34.775, 32.07], [34.775, 32.085], [34.76, 32.085], [34.76, 32.07]]] } } });
      m.addLayer({ id: 'cover', type: 'fill', source: 'cover', layout: { visibility }, paint: { 'fill-color': '#000', 'fill-opacity': ['get', 'o'] } });
      // counted, not changed: the layers the probes hide by `visibility`
      const set = m.setLayoutProperty;
      (window as any).__hiddenByVisibility = [];
      m.setLayoutProperty = function (layer: string, name: string, value: unknown, ...rest: unknown[]) {
        if (name === 'visibility' && value === 'none') (window as any).__hiddenByVisibility.push(layer);
        return set.call(this, layer, name, value, ...rest);
      };
    }, { visibility, basemapVisibility });
    await expect(map.feature({ layer: 'cover', id: 9 })).toBeVisibleOnMap();
    await expect(map).toHaveLayerPixels('basemap', { at: { lng: 34.78, lat: 32.08 } });
    const hidden: string[] = await page.evaluate(() => (window as any).__hiddenByVisibility);
    expect([...new Set(hidden)], 'the premise: both probes hide their layer by visibility').toEqual(['cover', 'basemap']);
    expect([await layout('cover'), await layout('basemap')], "the app's visibility expressions after the probes").toEqual([visibility, basemapVisibility]);

    await page.evaluate(() => (window as any).__geowright_maps.main.setGlobalStateProperty('showCover', false));
    await expect(map).not.toHaveLayerPixels('cover', { at: { lng: 34.7675, lat: 32.0775 } });
    expect(await layout('cover')).toEqual(visibility);
    await expect(map).not.toHaveFeature({ layer: 'cover', id: 9 }); // still hidden, as the app wants
  });

  test('the pixel probe leaves a visibility the app never set unset', async ({ map, page }) => {
    // Where the probe hides a layer by `visibility` (a pixel-only layer such as the raster basemap, or a layer whose
    // opacity is data-driven), it used to write back an explicit "visible" on a layer defined without one: the app's
    // getLayoutProperty() and getStyle() then answered differently after an assertion, and a toggle written
    // `=== 'visible' ? 'none' : 'visible'`, whose first click does nothing in the app, hid the layer on its first click.
    const styleLayers = () => page.evaluate(() => JSON.stringify((window as any).__geowright_maps.main.getStyle().layers));
    const visibility = (layer: string) => page.evaluate((layer) => (window as any).__geowright_maps.main.getLayoutProperty(layer, 'visibility') ?? 'unset', layer);
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      // as an app writes it: no layout.visibility, and an opacity that fades the low-severity alerts
      m.addLayer({ id: 'fleet', type: 'circle', source: 'alerts', paint: { 'circle-radius': 6, 'circle-color': '#222', 'circle-opacity': ['case', ['==', ['get', 'severity'], 'low'], 0.4, 1] } });
    });
    await map.waitForIdle();
    const before = await styleLayers();
    expect([await visibility('basemap'), await visibility('fleet')], 'the premise: neither layer sets a visibility').toEqual(['unset', 'unset']);

    await expect(map).toHaveLayerPixels('basemap', { at: { lng: 34.78, lat: 32.08 } });
    await expect(map.feature({ layer: 'fleet', id: 1 })).toBeVisibleOnMap();
    expect([await visibility('basemap'), await visibility('fleet')]).toEqual(['unset', 'unset']);
    expect(await styleLayers()).toBe(before);
    // and both are drawn again
    await expect(map).toHaveLayerPixels('basemap', { at: { lng: 34.78, lat: 32.08 } });
    await expect(map).toHaveFeature({ layer: 'fleet', id: 1 });
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

  // README: "Could not look" never passes as "absent". toHaveLayerPixels has two more ways of not looking: a location
  // outside the viewport (refused before any probe; timeouts.spec holds the positive polarity) and a probe that reached
  // no verdict. Read as "hiding the layer changes nothing", either would let a .not pass.
  test('.not.toHaveLayerPixels at a location outside the viewport fails, and says so', async ({ map }) => {
    const outside = { lng: 35.2, lat: 32.08 }; // east of the demo's view (centre 34.78, zoom 12)
    const e = await expect(map).not.toHaveLayerPixels('basemap', { at: outside, timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e, '.not.toHaveLayerPixels passed for a location outside the viewport').not.toBeNull();
    expect(e?.message).toContain('outside the viewport');
  });

  test('toHaveLayerPixels fails in either polarity when the probe cannot read the pixels, and says so', async ({ map, page }) => {
    const at = { lng: 34.78, lat: 32.08 };
    await expect(map, 'the premise: the basemap is drawn there').toHaveLayerPixels('basemap', { at });
    // Nothing to read from: the map canvas answers getContext() with null when the probe asks for it. MapLibre keeps the
    // context it already has and goes on drawing, so the layer is still drawn there; only the probe is blind.
    await page.evaluate(() => {
      (window as any).__geowright_maps.main.getCanvas().getContext = () => null;
    });
    for (const not of [true, false]) {
      const e = await (not ? expect(map).not : expect(map)).toHaveLayerPixels('basemap', { at, timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      expect(e, `${not ? '.not.' : ''}toHaveLayerPixels passed on a map whose pixels could not be read`).not.toBeNull();
      expect(e?.message).toContain('no verdict: this map could not be probed: no WebGL context to read from');
    }
  });

  // The probe looks only at a point where the feature is on top, as an action aims: a feature that another feature covers
  // at every candidate point is not visible, even when that cover is translucent and the feature's pixels show through
  // it. A layer the app names in ignoreLayers never occludes, so the probe looks through it there.
  test("the pixel probe of toBeVisibleOnMap: under another feature's translucent fill, not visible, unless ignoreLayers names that layer", async ({ map, page }) => {
    // a translucent highlight drawn over the whole of parcel 106: the parcel shows through it
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('veil', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[34.79, 32.05], [34.81, 32.05], [34.81, 32.07], [34.79, 32.07], [34.79, 32.05]]] } } });
      m.addLayer({ id: 'veil', type: 'fill', source: 'veil', paint: { 'fill-color': '#fff', 'fill-opacity': 0.3 } });
    });
    await map.waitForIdle();
    const parcel = map.feature({ layer: 'parcels', id: 106 });
    await expect(parcel, 'covered by another feature at every point').not.toBeVisibleOnMap();
    const e = await expect(parcel).toBeVisibleOnMap({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e, 'toBeVisibleOnMap passed for a feature that another feature covers').not.toBeNull();
    expect(e?.message).toMatch(/no clean point to probe — occluded: .*topmost is veil/s);
    // the app declares the highlight a layer that never counts as an occluder: the probe looks through it
    const lenient = geowright(page, { ignoreLayers: ['veil'] });
    await expect(lenient.feature({ layer: 'parcels', id: 106 })).toBeVisibleOnMap({ timeout: 3000 });
  });
});

/**
 * Within one toBeVisibleOnMap, a conclusive pixel probe is reused while the feature looks the same (position, properties,
 * state, paint verdict) and taken again after 1, 2, 4… s, since pixels can change with nothing else changing; a changed
 * feature is probed again at once. The test 'a waiting .not.toBeVisibleOnMap does not re-probe on every poll' holds only
 * the reuse. A matcher that never probed an unchanged feature again, or that reused a probe for a changed one, passed every
 * other spec. Here the icon changes in the task right after the
 * probe that saw it transparent, so that probe always comes first.
 */
test.describe('toBeVisibleOnMap probes again when the pixels may have changed', () => {
  /** A 16 px icon at a clear spot of the demo, layer and source "icon", feature 5, whose `img` property is "clear". */
  const addIcon = (page: Page, iconImage: unknown) =>
    page.evaluate((iconImage) => {
      const m = (window as any).__geowright_maps.main;
      const w = window as any;
      const dot = (alpha: number) => ({ width: 16, height: 16, data: new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? alpha : i % 4 === 0 ? 200 : 0)) });
      w.__opaque = () => dot(255);
      w.__icon = (img: string) => ({ type: 'Feature', id: 5, properties: { img }, geometry: { type: 'Point', coordinates: [34.745, 32.06] } });
      m.addImage('dot', dot(0));
      m.addImage('clear', dot(0));
      m.addImage('solid', dot(255));
      m.addSource('icon', { type: 'geojson', data: w.__icon('clear') });
      m.addLayer({ id: 'icon', type: 'symbol', source: 'icon', layout: { 'icon-image': iconImage, 'icon-allow-overlap': true } });
      // counted, not changed: a probe of this layer hides it with exactly this call (its opacity is not data-driven).
      // `__afterNextProbe`, once set, runs in the task after the next probe.
      w.__probes = 0;
      const set = m.setPaintProperty;
      m.setPaintProperty = function (layer: string, name: string, value: unknown, ...rest: unknown[]) {
        if (layer === 'icon' && name === 'icon-opacity' && value === 0) {
          w.__probes++;
          const after = w.__afterNextProbe;
          w.__afterNextProbe = undefined;
          if (after) setTimeout(after, 0);
        }
        return set.call(this, layer, name, value, ...rest);
      };
    }, iconImage);

  test('an unchanged feature is probed again: an icon whose image becomes opaque is seen', async ({ map, page }) => {
    await addIcon(page, 'dot');
    await map.waitForIdle();
    const icon = map.feature({ layer: 'icon', id: 5 });
    await expect(icon, 'the premise: a transparent icon is not visible').not.toBeVisibleOnMap();
    // the app replaces the image: nothing the matcher compares changes, only the pixels
    await page.evaluate(() => {
      const w = window as any;
      w.__probes = 0;
      w.__afterNextProbe = () => w.__geowright_maps.main.updateImage('dot', w.__opaque());
    });
    // two looks and the 1 s between them, at the slowest look measured (4.6 s: tests/slow-machine.ts)
    await expect(icon, 'the image became opaque after the first probe').toBeVisibleOnMap({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__probes), 'the first probe saw the transparent image; a later one saw the opaque one').toBeGreaterThanOrEqual(2);
  });

  test('a changed feature is probed again at once: .not does not pass on a probe taken before the change', async ({ map, page }) => {
    // the icon's image is its property: "clear" (transparent), then "solid"
    await addIcon(page, ['get', 'img']);
    await map.waitForIdle();
    const icon = map.feature({ layer: 'icon', id: 5 });
    await expect(icon, 'the premise: a transparent icon is not visible').not.toBeVisibleOnMap();
    // A source whose request is answered only once the icon has changed: until then the map is loading, so the first
    // poll of the .not probes the transparent icon but may not conclude from it. Once the map has settled, the icon is
    // opaque, with another `img`: a probe taken before must not decide.
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    await page.route('**/held/empty.geojson', async (route) => {
      await answered;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    });
    await page.evaluate(() => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      m.addSource('held', { type: 'geojson', data: `${location.origin}/held/empty.geojson` });
      w.__probes = 0;
      w.__afterNextProbe = () => {
        w.__loadedAtProbe = m.loaded();
        m.getSource('icon').setData(w.__icon('solid'));
        w.__changed = true;
      };
    });
    // Expected to fail, so it runs to its end. The look after the change ended about 1 s in, both at rest and at 4x CPU
    // throttle (measured); the budget is the one for an action expected to fail after a look, which allows for load.
    const waiting = expect(icon).not.toBeVisibleOnMap({ timeout: PROBE_FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    await page.waitForFunction(() => (window as any).__changed === true);
    answer();
    const e = await waiting;
    expect(await page.evaluate(() => (window as any).__loadedAtProbe), 'the premise: the first probe was taken while the map was loading').toBe(false);
    expect(e, '.not.toBeVisibleOnMap passed on a probe taken before the icon became opaque').not.toBeNull();
    expect(e?.message).toContain('Received: visible');
  });
});

/**
 * The pixel probe of toBeVisibleOnMap reads the pixels at a point of the feature's geometry that the hit test gives back to
 * the feature: a point and rings of 3, 6 and 10 px around it, a line's vertices and midpoints, a polygon's interior. A
 * feature drawn more than a few pixels away from its geometry has no such point: a label under its point (text-offset), a
 * line with line-offset, a circle with circle-translate. The probe could not look, and that is no verdict either way. It
 * used to read "not visible": `.not.toBeVisibleOnMap()` passed on the demo's own label while it was drawn, so a check that
 * the labels are hidden after a toggle passed whether they were hidden or not. A feature covered by another feature or by
 * DOM is still "not visible": a user cannot see it.
 */
test.describe('a feature drawn away from its geometry', () => {
  const failure = (p: Promise<unknown>) => p.then(() => 'passed', (e: Error) => e.message);
  const NO_VERDICT = /no verdict: pixels: .*not-found/s;

  test("the demo's label under its point: no verdict while it is drawn, and .not passes once the toggle hides it", async ({ map, page }) => {
    const q = { layer: 'alerts-labels', where: { name: 'Gas leak' } };
    await expect(map, 'premise: the label is placed, and painted visibly').toHaveFeature(q);
    const point = (await map.feature({ layer: 'alerts', where: { name: 'Gas leak' } }).info()).pixel!;
    const drawn = await page.evaluate((p) => {
      const m = (window as any).__geowright_maps.main;
      const dys: number[] = [];
      for (let dy = 0; dy <= 40; dy += 2) if (m.queryRenderedFeatures([p.x, p.y + dy], { layers: ['alerts-labels'] }).some((f: any) => f.properties.name === 'Gas leak')) dys.push(dy);
      const { lng, lat } = m.unproject([p.x, p.y + (dys[dys.length >> 1] ?? 0)]);
      return { dys, at: { lng, lat } };
    }, point);
    expect(drawn.dys, 'premise: the hit test finds the label below its point').not.toEqual([]);
    expect(Math.min(...drawn.dys), `premise: and only more than 10 px below it (dy ${drawn.dys.join(', ')})`).toBeGreaterThan(10);
    await expect(map, 'premise: the label draws pixels there').toHaveLayerPixels('alerts-labels', { at: drawn.at, radiusPx: 6 });

    const label = map.feature(q);
    expect(await failure(expect(label).not.toBeVisibleOnMap({ timeout: FAIL_FAST_MS })), '.not.toBeVisibleOnMap on a drawn label').toMatch(NO_VERDICT);
    expect(await failure(expect(label).toBeVisibleOnMap({ timeout: FAIL_FAST_MS })), 'toBeVisibleOnMap on a drawn label').toMatch(NO_VERDICT);
    await expect(label, 'its paint says visible').toBeVisibleOnMap({ pixels: false });
    // the README's limit: an action aims at the geometry too, and says it found no pixel of the feature there; clickAt
    // where the label is drawn reaches it
    expect(await failure(label.click({ timeout: FAIL_FAST_MS }))).toContain('not-found');
    await page.evaluate(() => {
      const w = window as any;
      w.__labelClicks = [];
      w.__geowright_maps.main.on('click', 'alerts-labels', (e: any) => w.__labelClicks.push(e.features[0].properties.name));
    });
    await map.clickAt(drawn.at);
    expect(await page.evaluate(() => (window as any).__labelClicks)).toEqual(['Gas leak']);

    await page.getByTestId('toggle-alerts').uncheck();
    await expect(label).not.toBeVisibleOnMap();
  });

  for (const c of [
    { name: 'line-offset', type: 'line', paint: { 'line-width': 4, 'line-color': '#f0f', 'line-offset': 14 }, line: true },
    { name: 'circle-translate', type: 'circle', paint: { 'circle-radius': 6, 'circle-color': '#f0f', 'circle-translate': [0, 24] }, line: false },
  ]) {
    test(`a feature drawn with ${c.name}: .not.toBeVisibleOnMap does not pass`, async ({ map, page }) => {
      const at = await page.evaluate((c) => {
        const m = (window as any).__geowright_maps.main;
        const { lng, lat } = m.getCenter();
        const geometry = c.line ? { type: 'LineString', coordinates: [[lng - 0.02, lat + 0.01], [lng + 0.02, lat + 0.01]] } : { type: 'Point', coordinates: [lng, lat + 0.01] };
        m.addSource('shifted', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 7, properties: {}, geometry }] } });
        m.addLayer({ id: 'shifted', type: c.type, source: 'shifted', paint: c.paint });
        return { lng, lat: lat + 0.01 };
      }, c);
      await map.waitForIdle();
      await expect(map, 'premise: the layer draws pixels near its geometry').toHaveLayerPixels('shifted', { at, radiusPx: 40 });
      const hits = await page.evaluate((at) => {
        const m = (window as any).__geowright_maps.main;
        const p = m.project(at);
        const n = (dy: number) => m.queryRenderedFeatures([p.x, p.y + dy], { layers: ['shifted'] }).length;
        return { onGeometry: n(0), below: [12, 14, 16, 20, 24, 28].filter((dy) => n(dy) > 0) };
      }, at);
      expect(hits.onGeometry, 'premise: the hit test does not find it on its geometry').toBe(0);
      expect(hits.below, 'premise: it does where it is drawn').not.toEqual([]);
      const f = map.feature({ layer: 'shifted', id: 7 });
      expect(await failure(expect(f).not.toBeVisibleOnMap({ timeout: FAIL_FAST_MS })), `.not.toBeVisibleOnMap on a drawn ${c.name}`).toMatch(NO_VERDICT);
    });
  }

  test('covered by another feature or by DOM is still a verdict: not visible', async ({ map, page }) => {
    const alert = map.feature({ layer: 'alerts', id: 1 });
    await expect(alert).toBeVisibleOnMap();
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const b = m.getBounds();
      const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      m.addSource('cover', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } } });
      m.addLayer({ id: 'cover', type: 'fill', source: 'cover', paint: { 'fill-color': '#000', 'fill-opacity': 1 } });
    });
    await expect(alert, 'under an opaque fill the hit test sees').not.toBeVisibleOnMap();
    expect(await failure(expect(alert).toBeVisibleOnMap({ timeout: FAIL_FAST_MS }))).toContain('occluded:');

    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.removeLayer('cover');
      const veil = document.createElement('div');
      veil.style.cssText = 'position:absolute;inset:0;z-index:10;background:#000;';
      m.getContainer().appendChild(veil);
    });
    await expect(alert, 'under an opaque DOM element').not.toBeVisibleOnMap();
    expect(await failure(expect(alert).toBeVisibleOnMap({ timeout: FAIL_FAST_MS }))).toContain('dom-covered:');
  });
});

/**
 * The pixel probe reads a patch of about 5×5 CSS pixels at the feature's action point: a point's own location (then rings
 * of 3, 6 and 10 px), a polygon's interior point far from its edge. A feature that draws nothing there — a ring marker
 * (transparent fill, opaque stroke), a polygon drawn only by its outline — is still a candidate there, because the hit test
 * covers the whole disc and the whole polygon, and hiding its layer changes nothing in the patch. These tests pin that
 * limit as README "Limits" states it: toBeVisibleOnMap fails, `.not.toBeVisibleOnMap()` PASSES on a feature a user sees,
 * and an action under a translucent pixel-only layer is refused "occluded". They also check what the README offers instead.
 * A fix that probes where the feature is drawn turns the pinned lines around; the filled control shows the difference.
 */
test.describe('a feature that draws nothing at its action point', () => {
  const failure = (p: Promise<unknown>) => p.then(() => 'passed', (e: Error) => e.message);
  const box = (x: number) => [[[x, 32.1], [x + 0.02, 32.1], [x + 0.02, 32.115], [x, 32.115], [x, 32.1]]];
  for (const c of [
    {
      name: 'a ring marker (transparent fill, opaque stroke)',
      type: 'circle',
      filled: { geometry: { type: 'Point', coordinates: [34.72, 32.05] }, paint: { 'circle-radius': 14, 'circle-color': '#f0f', 'circle-opacity': 1, 'circle-stroke-width': 4, 'circle-stroke-color': '#f0f' } },
      hollow: { geometry: { type: 'Point', coordinates: [34.84, 32.05] }, paint: { 'circle-radius': 14, 'circle-color': '#f0f', 'circle-opacity': 0, 'circle-stroke-width': 4, 'circle-stroke-color': '#f0f' } },
      drawn: { lng: 34.84, lat: 32.05 }, // the ring is 14-18 px from its centre, inside the default 24 px radius
    },
    {
      name: 'a polygon drawn only by its outline',
      type: 'fill',
      filled: { geometry: { type: 'Polygon', coordinates: box(34.72) }, paint: { 'fill-color': '#f0f', 'fill-outline-color': '#f0f' } },
      hollow: { geometry: { type: 'Polygon', coordinates: box(34.8) }, paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-outline-color': '#f0f' } },
      drawn: { lng: 34.8, lat: 32.1075 }, // its west edge
    },
  ]) {
    test(`${c.name}: the probe reads its empty middle; { pixels: false }, toHaveLayerPixels and .not.toHaveFeature see it`, async ({ map, page }) => {
      await page.evaluate((c) => {
        const m = (window as any).__geowright_maps.main;
        for (const id of ['filled', 'hollow'] as const) {
          m.addSource(id, { type: 'geojson', data: { type: 'Feature', id: 7, properties: { name: id }, geometry: c[id].geometry } });
          m.addLayer({ id, type: c.type, source: id, paint: c[id].paint });
        }
      }, c);
      await map.waitForIdle();
      const hollow = map.feature({ layer: 'hollow', id: 7 });
      await expect(map, 'premise: its paint says visible').toHaveFeature({ layer: 'hollow', id: 7 });
      await expect(map, 'premise, and the README check of its pixels: the layer draws it').toHaveLayerPixels('hollow', { at: c.drawn });
      await expect(map.feature({ layer: 'filled', id: 7 }), 'control: the same feature drawn in its middle').toBeVisibleOnMap();

      // the limit, pinned: the probe's patch is in the empty middle
      expect(await failure(expect(hollow).toBeVisibleOnMap({ timeout: FAIL_FAST_MS })), 'toBeVisibleOnMap on a drawn feature').toMatch(/pixels: hiding layer "hollow" changes nothing at/);
      expect(await failure(expect(hollow).not.toBeVisibleOnMap({ timeout: FAIL_FAST_MS })), '.not.toBeVisibleOnMap on a drawn feature').toBe('passed');
      // what the README offers instead
      await expect(hollow, 'its paint').toBeVisibleOnMap({ pixels: false });
      expect(await failure(expect(map).not.toHaveFeature({ layer: 'hollow', id: 7 }, { timeout: FAIL_FAST_MS })), 'the absence check').not.toBe('passed');

      // an action reads the same patch for a pixel-only layer above its target (decision 0022): under a translucent veil the
      // empty middle reads as covered; ignoreLayers for the veil lets the click through
      await page.evaluate(() => {
        const w = window as any;
        const m = w.__geowright_maps.main;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const g = canvas.getContext('2d')!;
        g.fillStyle = '#888';
        g.fillRect(0, 0, 64, 64);
        const b = m.getBounds();
        const [west, south, east, north] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        m.addSource('veil', { type: 'image', url: canvas.toDataURL(), coordinates: [[west, north], [east, north], [east, south], [west, south]] });
        m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': 0.5, 'raster-fade-duration': 0 } });
        w.__clicks = [];
        for (const id of ['filled', 'hollow']) m.on('click', id, (e: any) => w.__clicks.push(`${id}#${e.features[0].id}`));
      });
      await map.waitForIdle();
      await expect(map, 'premise: it is drawn through the veil').toHaveLayerPixels('hollow', { at: c.drawn });
      await map.feature({ layer: 'filled', id: 7 }).click({ timeout: PROBE_FAIL_FAST_MS });
      expect(await failure(hollow.click({ timeout: PROBE_FAIL_FAST_MS })), 'click() under the veil').toMatch(/occluded: .*raster layer "veil"/s);
      await hollow.click({ ignoreLayers: ['veil'] });
      expect(await page.evaluate(() => (window as any).__clicks)).toEqual(['filled#7', 'hollow#7']);

      // the app removes it: the absence check passes
      await page.evaluate(() => (window as any).__geowright_maps.main.getSource('hollow').setData({ type: 'FeatureCollection', features: [] }));
      await expect(map).not.toHaveFeature({ layer: 'hollow', id: 7 });
    });
  }
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

  // Each on its own source and footprint, clear of the demo's targets: extruded over the parcels, the blocks would hide
  // them (and the probe would rightly say so).
  const addOwnLayers = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const add = (id: string, fid: number, geometry: object, layer: object) => {
        m.addSource(id, { type: 'geojson', data: { type: 'Feature', id: fid, properties: {}, geometry } });
        m.addLayer({ id, source: id, ...layer });
      };
      const box = [[34.74, 32.1], [34.746, 32.1], [34.746, 32.104], [34.74, 32.104], [34.74, 32.1]];
      add('blocks', 88, { type: 'Polygon', coordinates: [box] }, { type: 'fill-extrusion', paint: { 'fill-extrusion-color': '#37474f', 'fill-extrusion-height': 40 } });
      // a label with no icon: only text-opacity hides it
      add('label', 89, { type: 'Point', coordinates: [34.72, 32.05] }, {
        type: 'symbol',
        layout: { 'text-field': 'MMMM', 'text-font': ['Noto Sans Regular'], 'text-size': 28, 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': '#000', 'text-halo-color': '#f0f', 'text-halo-width': 6 },
      });
      // a dot drawn by its stroke alone (radius 0): only circle-stroke-opacity hides it
      add('dot', 90, { type: 'Point', coordinates: [34.74, 32.055] }, { type: 'circle', paint: { 'circle-radius': 0, 'circle-stroke-width': 10, 'circle-stroke-color': '#f0f' } });
    });
  // A row for every opacity property the probe sets to 0 (OPACITY_PROPERTIES in src/inpage/maplibre-paint.ts), each with
  // a target drawn at its action point by that property alone. Were the list short of text-opacity or
  // circle-stroke-opacity, the probe would leave the label's text or the dot's stroke drawn, see no change, and
  // `.not.toBeVisibleOnMap()` would pass on a feature a user can see; the filled circle and the icon rows do not notice
  // that.
  const TARGETS = [
    { q: { layer: 'parcels', id: 101 }, source: 'parcels', opacity: 'fill-opacity', what: 'GeoJSON fill' },
    { q: { layer: 'buildings', id: 1013 }, source: 'buildings', opacity: 'fill-opacity', what: 'vector-tile fill' },
    { q: { layer: 'roads', id: 201 }, source: 'roads', opacity: 'line-opacity', what: 'line' },
    { q: { layer: 'alerts', id: 1 }, source: 'alerts', opacity: 'circle-opacity', what: 'circle' },
    { q: { layer: 'dot', id: 90 }, source: 'dot', opacity: 'circle-stroke-opacity', what: 'circle (stroke only)' },
    { q: { layer: 'stations-points', id: 329 }, source: 'stations', opacity: 'icon-opacity', what: 'symbol (icon)' },
    { q: { layer: 'label', id: 89 }, source: 'label', opacity: 'text-opacity', what: 'symbol (text only)' },
    { q: { layer: 'blocks', id: 88 }, source: 'blocks', opacity: 'fill-extrusion-opacity', what: 'fill-extrusion' },
  ];

  test('a probe reloads no source, and the feature is still in the hit test right after it', async ({ map, page }) => {
    await addOwnLayers(page);
    await map.waitForIdle();
    for (const t of TARGETS) {
      await map.waitForIdle();
      expect({ target: t.what, ...(await probe(page, t.q, t.source)) }).toEqual({ target: t.what, drawn: true, hitRightAfter: true, loadedRightAfter: true, reloads: 0 });
    }
  });

  test('hiding by opacity and hiding by visibility give the same verdict, for every layer type', async ({ map, page }) => {
    await addOwnLayers(page);
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

  // Where the opacity is data-driven the probe hides the layer by `visibility`, and until its source has reloaded (and a
  // symbol has been placed again) the feature is missing from the rendering and the hit test. An action waits for that; a
  // matcher did not, so a one-shot read right after it (a snapshot, a count) could miss the feature the matcher had just
  // seen: 1 run in 15 of the "not drawn by the renderer" test below failed so. A matcher's probe now returns once the layer
  // is back.
  test('a read right after a matcher whose probe reloaded the source sees the map as the matcher found it', async ({ map, page }) => {
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const point = (properties: object, lng: number, id?: number) => ({ type: 'Feature', id, properties, geometry: { type: 'Point', coordinates: [lng, 32.07] } });
      // A source big enough that its reload takes a while, as an app's often is: 50,000 points the layer's filter leaves out,
      // which the worker reads again on every reload. (With one feature, on a quiet machine, the reload had landed by the
      // read 89 times in 90.)
      const source = (id: number, o: number, lng: number) => ({ type: 'geojson', data: { type: 'FeatureCollection', features: [point({ o }, lng, id), ...Array.from({ length: 50000 }, () => point({ bulk: 1 }, lng))] } });
      const layer = (id: string) => ({ id, type: 'circle', source: id, filter: ['!', ['has', 'bulk']], paint: { 'circle-radius': 12, 'circle-color': '#c0f', 'circle-opacity': ['get', 'o'], 'circle-stroke-width': 0 } });
      // drawn, drawn invisibly (opacity 0, still in the hit test), and a symbol (hit-tested again only once placed again):
      // each opacity is data-driven, so each probe reloads the source
      m.addSource('q', source(7, 1, 34.8));
      m.addLayer(layer('q'));
      m.addSource('q0', source(8, 0, 34.77));
      m.addLayer(layer('q0'));
      const symbol = (id: string) => ({ id, type: 'symbol', source: id, filter: ['!', ['has', 'bulk']], layout: { 'icon-image': 'station-icon', 'icon-allow-overlap': true }, paint: { 'icon-opacity': ['get', 'o'] } });
      m.addSource('s', source(9, 1, 34.83));
      m.addLayer(symbol('s'));
      m.addSource('s2', source(10, 1, 34.74));
      m.addLayer(symbol('s2'));
    });
    await map.waitForIdle();
    const circles = [
      { layer: 'q', run: () => expect(map.feature({ layer: 'q', id: 7 })).toBeVisibleOnMap(), what: 'toBeVisibleOnMap' },
      { layer: 'q', run: () => expect(map).toHaveLayerPixels('q', { at: { lng: 34.8, lat: 32.07 }, radiusPx: 4 }), what: 'toHaveLayerPixels' },
      { layer: 'q0', run: () => expect(map).not.toHaveLayerPixels('q0', { at: { lng: 34.77, lat: 32.07 }, radiusPx: 4 }), what: '.not.toHaveLayerPixels' },
    ];
    const symbols = [
      { layer: 's', run: () => expect(map.feature({ layer: 's', id: 9 })).toBeVisibleOnMap(), what: 'toBeVisibleOnMap (symbol)' },
      { layer: 's2', run: () => expect(map).toHaveLayerPixels('s2', { at: { lng: 34.74, lat: 32.07 }, radiusPx: 4 }), what: 'toHaveLayerPixels (symbol)' },
    ];
    const missed: string[] = [];
    for (let i = 0; i < 2; i++) {
      // Waiting for the source alone, the symbol probed first in a round was missing from the read every time, and the
      // one probed second never (MapLibre 6): each goes first once.
      for (const c of [...circles, ...(i ? [...symbols].reverse() : symbols)]) {
        await c.run();
        const n = await map.features({ layer: c.layer, visible: 'any' }).count(); // one-shot: no waiting
        if (n !== 1) missed.push(`${c.what} #${i + 1}: ${n} feature(s) of layer "${c.layer}" right after it`);
        await map.waitForIdle(); // each read is about the probe just before it
      }
    }
    expect(missed).toEqual([]);
  });

  // The same on a map with a longer fade duration (an app's `new Map({ fadeDuration })`), which goes idle: MapLibre places
  // a symbol again no sooner than its fade duration after the placement before. The wait gave up 600 ms after the source
  // had loaded, a bound meant for a map that never goes idle, and a read right after the matcher missed the symbol about
  // every second time (it was back about 1000 ms after the probe).
  test('a read right after a matcher whose probe reloaded a symbol layer sees it, on a map with a 1000 ms fade', async ({ page }) => {
    await page.evaluate(async () => {
      const main = (window as any).__geowright_maps.main;
      const el = Object.assign(document.createElement('div'), { id: 'slowfade' });
      el.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:300px;z-index:5';
      document.body.appendChild(el);
      const style = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#fff' } }] };
      const m = new main.constructor({ container: el, style, center: [34.8, 32.07], zoom: 12, fadeDuration: 1000, attributionControl: false });
      await new Promise((resolve) => m.once('load', resolve));
      const icon = new Uint8Array(16 * 16 * 4).map((_, i) => [200, 40, 40, 255][i % 4]);
      m.addImage('square', { width: 16, height: 16, data: icon });
      m.addSource('s', { type: 'geojson', data: { type: 'Feature', id: 9, properties: { o: 1 }, geometry: { type: 'Point', coordinates: [34.8, 32.07] } } });
      // data-driven opacity: the probe hides the layer by visibility, and its source reloads
      m.addLayer({ id: 's', type: 'symbol', source: 's', layout: { 'icon-image': 'square', 'icon-allow-overlap': true }, paint: { 'icon-opacity': ['get', 'o'] } });
      (window as any).__geowright_maps.slowfade = m;
    });
    const slow = geowright(page, { mapId: 'slowfade' });
    await slow.waitForIdle();
    const missed: string[] = [];
    for (let i = 0; i < 6; i++) {
      await expect(slow.feature({ layer: 's', id: 9 })).toBeVisibleOnMap();
      const n = await slow.features({ layer: 's', visible: 'any' }).count(); // one-shot: no waiting
      if (n !== 1) missed.push(`#${i + 1}: ${n} feature(s) right after it`);
      await slow.waitForIdle(); // each read is about the probe just before it
    }
    expect(missed).toEqual([]);
  });

  // The same where the app changes something while the probe's reload runs, though nothing is taken away: a hair's camera
  // move (an easeTo settling, a resize), global state set on every frame for another layer, the same marker set again
  // (a fetch that lands then), a new filter that keeps it. Taken as the app's change, each ended the wait on the first
  // frame with the source loaded, before the symbol was placed again, and a read right after the matcher missed it
  // (global state: 18 reads in 18; the camera: 15 in 18; the data and the filter: 4 in 6 each).
  for (const how of ['global state set on every frame', 'the camera nudged during the reload', 'the same data set again during the reload', 'a filter that keeps it set during the reload'] as const) {
    test(`a read right after a matcher whose probe reloaded a symbol layer sees it: ${how}`, async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const c = m.getCenter();
        (window as any).__marker = { type: 'Feature', id: 9, properties: { o: 1 }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } };
        m.addSource('s', { type: 'geojson', data: (window as any).__marker });
        // data-driven opacity: the probe hides the layer by visibility, and its source reloads
        m.addLayer({ id: 's', type: 'symbol', source: 's', layout: { 'icon-image': 'station-icon', 'icon-allow-overlap': true, 'icon-size': 2 }, paint: { 'icon-opacity': ['get', 'o'] } });
      });
      await map.waitForIdle();
      await page.evaluate((how) => {
        const m = (window as any).__geowright_maps.main;
        if (how === 'global state set on every frame') {
          // an app's animation, away from the symbol: a layer whose paint reads the global state
          m.addSource('ticker', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [34.74, 32.04] } } });
          m.addLayer({ id: 'ticker', type: 'circle', source: 'ticker', paint: { 'circle-radius': ['+', 6, ['%', ['global-state', 't'], 4]], 'circle-color': '#000' } });
          let t = 0;
          const tick = () => (m.setGlobalStateProperty('t', t++), requestAnimationFrame(tick));
          requestAnimationFrame(tick);
          return;
        }
        // the probe has hidden the layer: while its source reloads, the camera moves by a hair (the symbol stays in view),
        // the app sets the same data again, or a filter that keeps the symbol (another one each time)
        let flip = false;
        m.on('styledata', () => {
          if (m.getLayoutProperty('s', 'visibility') !== 'none') return;
          const c = m.getCenter();
          setTimeout(() => {
            if (how === 'the camera nudged during the reload') m.jumpTo({ center: [c.lng + 1e-7, c.lat] });
            else if (how === 'the same data set again during the reload') m.getSource('s').setData((window as any).__marker);
            else m.setFilter('s', (flip = !flip) ? ['has', 'o'] : ['!=', ['get', 'o'], 5]);
          });
        });
      }, how);
      const missed: string[] = [];
      for (let i = 0; i < 6; i++) {
        await expect(map.feature({ layer: 's', id: 9 })).toBeVisibleOnMap();
        const n = await map.features({ layer: 's', visible: 'any' }).count(); // one-shot: no waiting
        if (n !== 1) missed.push(`#${i + 1}: ${n} feature(s) right after it`);
        // each read is about the probe just before it (the map with the ticker never goes idle)
        await expect.poll(() => map.features({ layer: 's', visible: 'any' }).count()).toBe(1);
      }
      expect(missed).toEqual([]);
    });
  }

  // The other side of that wait: the app may take the layer's features away while it reloads (a selected marker removed
  // after a click: a filter, new data, the layer hidden). They never come back then, and the wait for them lasted the
  // matcher's whole timeout, after which it reported the probe's "visible" from before the change: .not.toBeVisibleOnMap
  // failed on a feature that was gone. The wait now ends at once with the layer hidden, when the map goes idle, or, on a
  // map seen never to go idle (`repaint` on), once the source has been loaded again for 600 ms and 8 frames; and the
  // next poll sees the feature gone. A map the app animates with a paint property set on every frame never goes idle
  // either, with `repaint` off: there a change of the layer's filter, its source's data, the global state or the camera
  // starts that give-up (none ends the wait by itself, since it need not take anything away: the tests above), and a
  // change none of the checks see (the zoom range) waits out the timeout. These tests expect a verdict: the timeout
  // only bounds how long a failure takes, and the repainting map's "never idle" needs enough frames after the probe's
  // reload on a loaded machine.
  for (const c of [
    { how: 'a filter', repaint: true },
    { how: 'a filter', repaint: 'animated' },
    { how: 'new data', repaint: true },
    { how: 'new data', repaint: 'animated' },
    { how: 'the layer hidden', repaint: true },
    { how: 'a filter on global state', repaint: false },
    { how: 'a filter on global state', repaint: true },
    { how: 'a filter on global state', repaint: 'animated' },
    { how: 'the camera moved away', repaint: true },
    { how: 'the camera moved away', repaint: 'animated' },
    { how: 'the zoom range', repaint: false },
    { how: 'the zoom range', repaint: true },
  ] as const) {
    const where = c.repaint === 'animated' ? ', on a map the app animates (repaint off)' : c.repaint ? ', on a map that repaints every frame' : '';
    test(`.not.toBeVisibleOnMap on a feature the app takes away while its probe's reload runs: ${c.how}${where}`, async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.setGlobalStateProperty('shown', true);
        m.addSource('picked', { type: 'geojson', data: { type: 'Feature', id: 7, properties: { o: 1 }, geometry: { type: 'Point', coordinates: [34.8, 32.07] } } });
        // data-driven opacity: the probe hides the layer by visibility, and its source reloads
        m.addLayer({ id: 'picked', type: 'circle', source: 'picked', filter: ['==', ['global-state', 'shown'], true], paint: { 'circle-radius': 10, 'circle-color': '#c0f', 'circle-opacity': ['get', 'o'] } });
      });
      await map.waitForIdle();
      await expect(map, 'the premise: drawn').toHaveLayerPixels('picked', { at: { lng: 34.8, lat: 32.07 }, radiusPx: 4 });
      await map.waitForIdle();
      await page.evaluate((c) => {
        const m = (window as any).__geowright_maps.main;
        m.repaint = c.repaint === true;
        if (c.repaint === 'animated') {
          // an app's animation, away from the feature: a paint property set on every frame
          m.addSource('ticker', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [34.74, 32.04] } } });
          m.addLayer({ id: 'ticker', type: 'circle', source: 'ticker', paint: { 'circle-radius': 6, 'circle-color': '#000' } });
          let t = 0;
          const tick = () => (m.setPaintProperty('ticker', 'circle-radius', 6 + (t++ % 4)), requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }
        let done = false;
        m.on('styledata', () => {
          if (done || m.getLayoutProperty('picked', 'visibility') !== 'none') return;
          done = true; // the probe has hidden the layer: the app's change lands while its source reloads
          // (global state at once: set a moment later, it landed after the probe's own reload, which brought the feature back)
          if (c.how === 'a filter on global state') return m.setGlobalStateProperty('shown', false);
          if (c.how === 'the zoom range') return m.setLayerZoomRange('picked', 20, 24);
          // the camera, as the first tile of the reload arrives: the reload is not over, and no frame has been drawn since
          const onTile = (e: { sourceId?: string; tile?: unknown }) => {
            if (e.sourceId !== 'picked' || !e.tile) return;
            m.off('sourcedata', onTile);
            m.jumpTo({ center: [10, 50] });
          };
          if (c.how === 'the camera moved away') return m.on('sourcedata', onTile);
          setTimeout(() => {
            if (c.how === 'a filter') m.setFilter('picked', ['==', ['get', 'o'], 2]);
            else if (c.how === 'new data') m.getSource('picked').setData({ type: 'FeatureCollection', features: [] });
            else m.setLayoutProperty('picked', 'visibility', 'none');
          });
        });
      }, c);
      await expect(map.feature({ layer: 'picked', id: 7 })).not.toBeVisibleOnMap({ timeout: 2 * PROBE_FAIL_FAST_MS });
      expect(await page.evaluate(() => (window as any).__geowright_maps.main.queryRenderedFeatures({ layers: ['picked'] }).length), 'the premise: the app took it away').toBe(0);
    });
  }

  // The same where the app keeps changing the layer or the camera, on a map that never goes idle: a live feed that sets
  // the source's data every 250 ms (feature 7 gone, 3000 other points out of view), a filter animation (a time slider
  // playing) that sets a new filter every 250 ms (one that matches none of feature 7 and the 3000 points in view beside
  // it), or a camera tour that takes feature 7 out of view and moves on to new tiles every 250 ms (a pan, or a zoom
  // step). Each step reloads the source again. The give-up's count restarted on every frame with the source not
  // loaded, and a step every 250 ms kept it from completing: the wait lasted the matcher's whole timeout, and `.not`
  // failed with "visible" on a feature the app had taken away (in every run measured, with a 5, 12 or 15 s timeout).
  // Any change that starts the give-up now restarts the count once, at the first reload after it, and the later
  // reloads do not.
  for (const c of [
    { how: 'a live feed (new data every 250 ms)', step: 'data', repaint: true },
    { how: 'a live feed (new data every 250 ms)', step: 'data', repaint: 'animated' },
    { how: 'a filter animation (a new filter every 250 ms)', step: 'filter', repaint: true },
    { how: 'a filter animation (a new filter every 250 ms)', step: 'filter', repaint: 'animated' },
    { how: 'a camera tour away from it (a pan to new tiles every 250 ms)', step: 'pan', repaint: true },
    { how: 'a camera tour away from it (a pan to new tiles every 250 ms)', step: 'pan', repaint: 'animated' },
    { how: 'a camera tour away from it (a zoom step to new tiles every 250 ms)', step: 'zoom', repaint: true },
    { how: 'a camera tour away from it (a zoom step to new tiles every 250 ms)', step: 'zoom', repaint: 'animated' },
  ] as const) {
    const where = c.repaint === 'animated' ? ', on a map the app animates (repaint off)' : ', on a map that repaints every frame';
    test(`.not.toBeVisibleOnMap on a feature the app keeps taking away while its probe's reload runs: ${c.how}${where}`, async ({ map, page }) => {
      await page.evaluate((step) => {
        const m = (window as any).__geowright_maps.main;
        const point = (id: number, coordinates: number[]) => ({ type: 'Feature', id, properties: { o: 1 }, geometry: { type: 'Point', coordinates } });
        const features = [point(7, [34.8, 32.07])];
        // the filter's case: 3000 more points in view west of feature 7, which each step's reload reads again
        if (step === 'filter') for (let i = 0; i < 3000; i++) features.push(point(100 + i, [34.7 + (i % 60) * 0.0007, 32.09 + Math.floor(i / 60) * 0.0004]));
        m.addSource('picked', { type: 'geojson', data: { type: 'FeatureCollection', features } });
        // data-driven opacity: the probe hides the layer by visibility, and its source reloads
        m.addLayer({ id: 'picked', type: 'circle', source: 'picked', paint: { 'circle-radius': 10, 'circle-color': '#c0f', 'circle-opacity': ['get', 'o'] } });
        // The camera's tour runs without the demo's tiled layers. Their tiles, answered by page.route, must all have
        // arrived for `.not` to conclude absence, and on a loaded machine they did not between two steps of a pan:
        // "no verdict: the map had not settled" (3 runs in 6, beside a compat run). That is the matcher's rule for
        // absence, not the wait under test. Hidden, their sources load no tiles.
        if (step === 'pan' || step === 'zoom') for (const id of ['basemap', 'buildings']) m.setLayoutProperty(id, 'visibility', 'none');
      }, c.step);
      await map.waitForIdle();
      await expect(map, 'the premise: drawn').toHaveLayerPixels('picked', { at: { lng: 34.8, lat: 32.07 }, radiusPx: 4 });
      await map.waitForIdle();
      await page.evaluate((c) => {
        const m = (window as any).__geowright_maps.main;
        m.repaint = c.repaint === true;
        if (c.repaint === 'animated') {
          // an app's animation, away from the feature: a paint property set on every frame
          m.addSource('ticker', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [34.74, 32.04] } } });
          m.addLayer({ id: 'ticker', type: 'circle', source: 'ticker', paint: { 'circle-radius': 6, 'circle-color': '#000' } });
          let t = 0;
          const tick = () => (m.setPaintProperty('ticker', 'circle-radius', 6 + (t++ % 4)), requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }
        // the feed's data once it has taken feature 7 away: the rest of a fleet, far out of view
        const rest = { type: 'FeatureCollection', features: [] as object[] };
        for (let i = 0; i < 3000; i++) rest.features.push({ type: 'Feature', id: 100 + i, properties: { o: 1 }, geometry: { type: 'Point', coordinates: [5 + (i % 60) * 0.2, 45 + Math.floor(i / 60) * 0.2] } });
        // the animation's filters match no feature (none has `k`), another one at each step
        let flip = false;
        // the tour, where the layer has nothing: on by most of the view's width at zoom 12, or through zoom levels
        let lng = 20;
        let z = 12;
        const steps = {
          data: () => m.getSource('picked').setData(rest),
          filter: () => m.setFilter('picked', ['==', ['get', 'k'], (flip = !flip) ? 'a' : 'b']),
          pan: () => m.jumpTo({ center: [(lng += 0.35), 45] }),
          zoom: () => m.jumpTo({ center: [20, 45], zoom: (z = z >= 16 ? 9 : z + 1) }),
        };
        const step = steps[c.step];
        let started = false;
        m.on('styledata', () => {
          if (started || m.getLayoutProperty('picked', 'visibility') !== 'none') return;
          started = true; // the probe has hidden the layer: the app's first step lands while its source reloads
          setTimeout(step);
          setInterval(step, 250);
        });
      }, c);
      await expect(map.feature({ layer: 'picked', id: 7 })).not.toBeVisibleOnMap({ timeout: 2 * PROBE_FAIL_FAST_MS });
      expect(await page.evaluate(() => (window as any).__geowright_maps.main.queryRenderedFeatures({ layers: ['picked'] }).length), 'the premise: the app took it away (or out of view)').toBe(0);
    });
  }

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

/**
 * Pixels that change by themselves are no evidence that a layer is drawn. Over an OPAQUE overlay, hiding the target
 * changes nothing; but an overlay whose colour is in a paint transition moves the pixels by itself between the probe's
 * reads, one 8-bit level at a time. A level that moved between the read with the target and the read without it, and
 * not between the two reads with it before, read as "the target shows through" (and a click was sent through the
 * overlay). The probe is asked again and again, back to back, for as long as the transition runs, as an action asks
 * it candidate after candidate.
 */
test.describe('the pixel probe over an overlay that changes colour by itself', () => {
  type Overlay = 'opaque image' | 'opaque background' | 'translucent image';
  /** An overlay over the whole view, above everything, that then changes colour over `ms` (as opaque as it was). */
  const overlay = async (map: MapHandle, page: import('@playwright/test').Page, kind: Overlay, ms: number) => {
    await page.evaluate((kind) => {
      const m = (window as any).__geowright_maps.main;
      if (kind === 'opaque background') {
        m.addLayer({ id: 'over', type: 'background', paint: { 'background-color': '#202020', 'background-opacity': 1 } });
        return;
      }
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ddd';
      g.fillRect(0, 0, 64, 64);
      const b = m.getBounds();
      const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      m.addSource('over', { type: 'image', url: c.toDataURL(), coordinates: [[w, n], [e, n], [e, s], [w, s]] });
      m.addLayer({ id: 'over', type: 'raster', source: 'over', paint: { 'raster-opacity': kind === 'opaque image' ? 1 : 0.5, 'raster-fade-duration': 0 } });
    }, kind);
    await expect(map, 'the premise: the overlay is drawn over alert 1').toHaveLayerPixels('over', { at: { lng: 34.77, lat: 32.085 } });
    await page.evaluate(
      ({ kind, ms }) => {
        const m = (window as any).__geowright_maps.main;
        const [name, to] = kind === 'opaque background' ? ['background-color', '#e0e0e0'] : ['raster-brightness-max', 0];
        m.setPaintProperty('over', `${name}-transition`, { duration: ms, delay: 0 });
        m.setPaintProperty('over', name, to);
      },
      { kind, ms },
    );
  };
  /** Probe alert 1 back to back for `ms`, as toBeVisibleOnMap and an action do (about 5x5 px at its action point). */
  const probeFor = (page: import('@playwright/test').Page, ms: number) =>
    page.evaluate(async (ms) => {
      const out: string[] = [];
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const p = await (window as any).__geowright.pixelProbe('main', { layer: 'alerts', id: 1 });
        out.push(!p.ok ? `failed: ${p.message}` : p.inconclusive !== undefined ? 'no verdict' : `diff ${p.diff}`);
      }
      return out;
    }, ms);
  const tally = (seen: string[]) => `${seen.length} probes: ${[...new Set(seen)].map((s) => `${s} x${seen.filter((t) => t === s).length}`).join(' | ')}`;

  for (const kind of ['opaque image', 'opaque background'] as const) {
    test(`an ${kind} changing colour: hiding the target under it is never a contribution`, async ({ map, page }) => {
      await overlay(map, page, kind, 6000);
      const seen = await probeFor(page, 6500);
      expect(seen.filter((s) => s !== 'diff 0' && s !== 'no verdict'), tally(seen)).toEqual([]);
      expect(seen, `the premise: the overlay's pixels moved between the probe's reads (${tally(seen)})`).toContain('no verdict');
    });
  }

  // The other side: a target that does show through an overlay changing colour is still seen, every time.
  test('a translucent image changing colour: the target under it is seen through it, every time', async ({ map, page }) => {
    await overlay(map, page, 'translucent image', 6000);
    const seen = await probeFor(page, 3000);
    expect(seen.filter((s) => !/^diff [1-9]/.test(s)), tally(seen)).toEqual([]);
  });
});

/**
 * MapLibre draws a GeoJSON feature from the worker's copy, which keeps a property whose value is null; the hit test decodes
 * the tile, which drops it. So `['has', key]` on such a property is not the same question for the renderer and for us: a
 * verdict that rests on it is uncertain. Visible, never a false "invisible", and said in the notes.
 */
test.describe("paint that tests ['has', key] on a GeoJSON property whose value is null", () => {
  const add = (page: import('@playwright/test').Page, opacity: unknown) =>
    page.evaluate((opacity) => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('quakes', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 7, properties: { name: 'q7', felt: null }, geometry: { type: 'Point', coordinates: [34.8, 32.07] } }] } });
      m.addLayer({ id: 'quakes', type: 'circle', source: 'quakes', paint: { 'circle-radius': 12, 'circle-color': '#c0f', 'circle-opacity': opacity, 'circle-stroke-width': 0 } });
    }, opacity);
  const note = "visibility uncertain for layer quakes: circle-opacity — it tests ['has', …]";

  test('drawn by the renderer (the key is there, null): visible, not "circle-opacity evaluates to 0"', async ({ map, page }) => {
    await add(page, ['case', ['has', 'felt'], 1, 0]);
    await map.waitForIdle();
    await expect(map, 'the premise: the pixels are drawn').toHaveLayerPixels('quakes', { at: { lng: 34.8, lat: 32.07 }, radiusPx: 4 });
    await expect(map).toHaveFeature({ layer: 'quakes', id: 7 });
    expect(await map.snapshot()).toContain(note);
  });

  // The other way round the renderer draws nothing and the verdict is still "visible" (the data is not read here): a
  // stated limit, and the notes say it.
  test('not drawn by the renderer: the verdict is visible, and the notes say it is uncertain', async ({ map, page }) => {
    await add(page, ['case', ['has', 'felt'], 0, 1]);
    await map.waitForIdle();
    await expect(map, 'the premise: nothing is drawn').not.toHaveLayerPixels('quakes', { at: { lng: 34.8, lat: 32.07 }, radiusPx: 4 });
    expect(await map.snapshot()).toContain(note);
  });
});

/**
 * toHaveLayerPixels' `radiusPx` is in CSS pixels, as its message says, on a HiDPI screen too; left out, it is 24 (README).
 * Every other assertion that leaves it out probes inside its layer, or far from it: nothing else would notice a smaller
 * default, under which the `.not` passes for a layer drawn a few pixels from `at`.
 */
for (const dpr of [1, 2]) {
  test.describe(`deviceScaleFactor ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test(`an image 18 CSS px from 'at' is within radiusPx 24, and within the default radius (device pixel ratio ${dpr})`, async ({ map, page }) => {
      // a 6x6 CSS px opaque image whose centre is 18 CSS px east of the view centre
      const at = await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d')!;
        g.fillStyle = '#000';
        g.fillRect(0, 0, 64, 64);
        const cx = m.getCanvas().clientWidth / 2, cy = m.getCanvas().clientHeight / 2;
        const ll = (x: number, y: number) => { const p = m.unproject([x, y]); return [p.lng, p.lat]; };
        m.addSource('speck', { type: 'image', url: c.toDataURL(), coordinates: [ll(cx + 15, cy - 3), ll(cx + 21, cy - 3), ll(cx + 21, cy + 3), ll(cx + 15, cy + 3)] });
        m.addLayer({ id: 'speck', type: 'raster', source: 'speck', paint: { 'raster-fade-duration': 0 } });
        const p = m.unproject([cx, cy]);
        return { lng: p.lng, lat: p.lat };
      });
      await map.waitForIdle();
      await expect(map).toHaveLayerPixels('speck', { at, radiusPx: 24, timeout: FAIL_FAST_MS });
      await expect(map).not.toHaveLayerPixels('speck', { at, radiusPx: 12, timeout: FAIL_FAST_MS });
      // no radiusPx: the default (24) sees the image, and the .not fails because of what it sees
      await expect(map, 'no radiusPx').toHaveLayerPixels('speck', { at, timeout: FAIL_FAST_MS });
      const not = await expect(map).not.toHaveLayerPixels('speck', { at, timeout: FAIL_FAST_MS }).then(() => 'passed', (e: Error) => e.message);
      expect(not, '.not.toHaveLayerPixels with no radiusPx, for an image 18 CSS px away').toContain('pixels differ by');
    });
  });
}

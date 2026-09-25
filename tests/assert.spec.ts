import { test, expect } from './fixtures';
import { geowright, type MapHandle } from '../src/playwright';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * ASSERT gap: an action in the regular DOM UI must be verifiable ON THE MAP.
 * The demo's save/remove are async with a random 100–400ms delay, like a real backend call.
 */
test.describe('assert gap', () => {
  test('initial map content', async ({ map }) => {
    await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
    await expect(map).toHaveFeature({ layer: 'parcels', id: 105 });
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3); // 4 exists but is off-screen
    await expect(map.features({ layer: 'parcels' })).toHaveFeatureCount(6);
    await expect(map.features({ layer: 'parcels', where: { zoning: 'nope' } })).toHaveFeatureCount(0);
  });

  test('form submit adds a feature to the map', async ({ map, page }) => {
    await expect(map).not.toHaveFeature({ layer: 'alerts', where: { name: 'Flooded underpass' } });
    await page.getByTestId('alert-name').fill('Flooded underpass');
    await page.getByTestId('alert-severity').selectOption('high');
    await page.getByTestId('alert-lng').fill('34.805');
    await page.getByTestId('alert-lat').fill('32.100');
    await page.getByTestId('alert-submit').click();

    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Flooded underpass', severity: 'high' } });
    await expect(map.features({ layer: 'alerts', where: { severity: 'high' } })).toHaveFeatureCount(2);
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(4);

    // and it is where the form said it should be
    const at = await map.feature({ layer: 'alerts', where: { name: 'Flooded underpass' } }).lngLat();
    expect(at.lng).toBeCloseTo(34.805, 3);
    expect(at.lat).toBeCloseTo(32.1, 3);
  });

  test('removing in the UI removes from the map', async ({ map, page }) => {
    await expect(map).toHaveFeature({ layer: 'alerts', id: 2 });
    await page.getByTestId('alert-remove-2').click();
    await expect(map).not.toHaveFeature({ layer: 'alerts', id: 2 });
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(2);
  });

  test('layer toggle hides and shows features', async ({ map, page }) => {
    await page.getByTestId('toggle-parcels').uncheck();
    await expect(map).not.toHaveFeature({ layer: 'parcels' });
    await expect(map.features({ layer: 'parcels-outline' })).toHaveFeatureCount(0);
    await expect(map).toHaveFeature({ layer: 'alerts', id: 1 }); // others untouched
    await page.getByTestId('toggle-parcels').check();
    await expect(map.features({ layer: 'parcels' })).toHaveFeatureCount(6);
  });

  test('failure message says what WAS on the map', async ({ map }) => {
    const err = await expect(map)
      .toHaveFeature({ layer: 'alerts', where: { severity: 'critical' } }, { timeout: FAIL_FAST_MS })
      .then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    const msg = err!.message;
    expect(msg).toContain('What is on the map');
    expect(msg).toContain('layer "alerts": 3 feature(s) rendered in viewport');
    expect(msg).toContain('"name":"Gas leak"');
    expect(msg).toContain('"zoom":12');
  });

  test('failure message distinguishes off-screen from missing, and hidden layers', async ({ map, page }) => {
    const offscreen = await expect(map).toHaveFeature({ layer: 'alerts', id: 4 }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(offscreen!.message).toContain('exist in the source but are not rendered');

    await page.getByTestId('toggle-alerts').uncheck();
    const hidden = await expect(map).toHaveFeature({ layer: 'alerts', id: 1 }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(hidden!.message).toContain('visibility is "none"');

    const typo = await expect(map).toHaveFeature({ layer: 'alertz' }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(typo!.message).toContain('layer "alertz": does not exist');
  });

  test("Playwright's built-in matchers are untouched by our expect", async ({ map, page }) => {
    await expect(page.locator('[data-testid^="alert-row-"]')).toHaveCount(4);
    await expect(page.locator('[data-testid^="alert-row-"]')).not.toHaveCount(3);
    await expect(map.features({ layer: 'alerts' })).not.toHaveFeatureCount(4);
  });

  test('where: operators and RegExp', async ({ map }) => {
    await expect(map.features({ layer: 'alerts', where: { severity: { in: ['high', 'medium'] } } })).toHaveFeatureCount(2);
    await expect(map.features({ layer: 'alerts', where: { name: /^gas/i } })).toHaveFeatureCount(1);
    await expect(map.features({ layer: 'alerts', where: { severity: { ne: 'low' }, id: { gte: 2 } } })).toHaveFeatureCount(1);
    await expect(map.features({ layer: 'parcels', where: { id: { gt: 102, lte: 105 } } })).toHaveFeatureCount(3);
    await expect(map.features({ layer: 'stations-clusters', where: { point_count: { gte: 5 } } })).not.toHaveFeatureCount(0);
    await expect(map).not.toHaveFeature({ layer: 'alerts', where: { nonexistent: { exists: true } } });
  });

  test('where: an array or an unknown operator is no verdict, not "matches everything"', async ({ map }) => {
    for (const where of [{ severity: ['high', 'medium'] }, { severity: { equals: 'high' } }] as any[]) {
      for (const not of [false, true]) {
        const m = not ? expect(map).not : expect(map);
        const e = await m.toHaveFeature({ layer: 'alerts', where }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
        expect(e, `${not ? '.not.' : ''}toHaveFeature passed with where ${JSON.stringify(where)}`).not.toBeNull();
        expect(e?.message).toMatch(/no verdict: .*unknown where operator/);
      }
    }
  });

  test('text labels (symbol layers, fixture glyphs) are assertable', async ({ map }) => {
    await expect(map).toHaveFeature({ layer: 'alerts-labels', where: { name: 'Gas leak' } });
    await expect(map.features({ layer: 'alerts-labels' })).toHaveFeatureCount(3);
    await expect(map).toHaveFeature({ layer: 'stations-cluster-count', where: { point_count: 10 } });
    // a label has a real, hit-testable position that is not the point's own pixel (text-offset)
    const label = await map.feature({ layer: 'alerts-labels', where: { name: 'Gas leak' } }).info();
    const circle = await map.feature({ layer: 'alerts', id: 1 }).info();
    expect(label.pixel).toBeDefined();
    expect(circle.pixel).toBeDefined();
  });

  test('a label hidden by collision is explained, not just "missing"', async ({ map, page }) => {
    // Two alerts 3px apart: the second label collides with the first and MapLibre hides it.
    await page.getByTestId('alert-name').fill('Twin of gas leak');
    await page.getByTestId('alert-lng').fill('34.7702');
    await page.getByTestId('alert-lat').fill('32.0851');
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Twin of gas leak' } }); // circle is there
    await expect(map.features({ layer: 'alerts-labels', where: { name: /gas leak/i } })).toHaveFeatureCount(1); // one label lost
    const hidden = (await map.features({ layer: 'alerts-labels' }).all()).some((f) => f.properties.name === 'Gas leak') ? 'Twin of gas leak' : 'Gas leak';
    const err = await expect(map).toHaveFeature({ layer: 'alerts-labels', where: { name: hidden } }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err!.message).toContain('or hidden by label/icon collision');
  });

  test('near-miss diagnostics: says which values ARE present', async ({ map }) => {
    const err = await expect(map)
      .toHaveFeature({ layer: 'alerts', where: { severity: 'critical', name: /leak/ } }, { timeout: FAIL_FAST_MS })
      .then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/"severity" wanted "critical"; rendered values: ("(high|medium|low)"(, )?){3}/);
    expect(err!.message).toContain('"name" wanted /leak/; rendered values:');

    const at = await expect(map)
      .toHaveFeature({ layer: 'alerts', at: { lng: 34.771, lat: 32.09 } }, { timeout: FAIL_FAST_MS })
      .then(() => null, (e: Error) => e);
    expect(at!.message).toMatch(/nearest match without "at": alerts#1 .* \d+px away/);
  });

  // bearing and pitch had a fixed 0.1° tolerance while the message printed the CENTRE tolerance, and a bearing was
  // not wrapped: MapLibre reports 270° as -90°.
  test('toHaveView: a bearing is an angle (270 = -90), and the message states the tolerances it used', async ({ map, page }) => {
    await page.evaluate(() => (window as any).__geowright_maps.main.jumpTo({ bearing: 270 }));
    await expect(map).toHaveView({ bearing: 270 });
    await expect(map).toHaveView({ bearing: -90 });
    await expect(map).toHaveView({ bearing: 269.95 });
    const e = await rejects(expect(map).toHaveView({ bearing: 260, zoom: 12 }, { timeout: FAIL_FAST_MS }));
    expect(e?.message).toContain('(±0.01 zoom, ±0.0005° centre, ±0.1° bearing and pitch)');
  });

  // the message said "rendered" for a query that matches only what a user can SEE.
  test('toHaveFeature says "visible" when it looks for visible features; toHaveGeometry says what is on the map', async ({ map }) => {
    const e = await rejects(expect(map).toHaveFeature({ layer: 'alerts', id: 999 }, { timeout: FAIL_FAST_MS }));
    expect(e?.message).toContain(`Expected: at least one visible feature matching, within ${FAIL_FAST_MS}ms`);
    const any = await rejects(expect(map).toHaveFeature({ layer: 'alerts', id: 999 }, { timeout: FAIL_FAST_MS, visible: 'any' }));
    expect(any?.message).toContain('Expected: at least one rendered feature matching');
    const g = await rejects(expect(map.feature({ layer: 'alerts', id: 1 })).toHaveGeometry({ type: 'Point', coordinates: [0, 0] }, { timeout: FAIL_FAST_MS }));
    expect(g?.message).toContain('What is on the map');
    expect(g?.message).toContain('"name":"Gas leak"');
  });

  test('toHaveView: zoomTolerance and degreesTolerance widen the match, and the message states them', async ({ map }) => {
    // the demo is at rest at 34.78,32.08 zoom 12
    const zoom = await rejects(expect(map).toHaveView({ zoom: 12.2 }, { timeout: FAIL_FAST_MS }));
    expect(zoom?.message).toContain('±0.01 zoom');
    await expect(map).toHaveView({ zoom: 12.2 }, { zoomTolerance: 0.25 });
    const centre = await rejects(expect(map).toHaveView({ center: { lng: 34.79, lat: 32.08 } }, { timeout: FAIL_FAST_MS }));
    expect(centre?.message).toContain('±0.0005° centre');
    await expect(map).toHaveView({ center: { lng: 34.79, lat: 32.08 } }, { degreesTolerance: 0.02 });
    const narrow = await rejects(expect(map).toHaveView({ center: { lng: 34.79, lat: 32.08 } }, { timeout: FAIL_FAST_MS, degreesTolerance: 0.005 }));
    expect(narrow?.message).toContain('±0.005° centre');
  });

  test('toHaveView waits for the camera to come to rest', async ({ map, page }) => {
    await expect(map).toHaveView({ zoom: 12, center: { lng: 34.78, lat: 32.08 } });
    await page.getByTestId('fly-east').click();
    await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 }, zoom: 12 });
    await expect(map).not.toHaveView({ center: { lng: 34.78, lat: 32.08 } });
  });
});

const rejects = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);

/**
 * A poll is true, false or INCONCLUSIVE: the map could not be looked at, a named layer does not exist, the query is
 * ambiguous where one feature is required. Only a conclusive result ends a retrying matcher early; an inconclusive one at
 * the deadline fails BOTH polarities and says why — exactly toHaveView's rule for a map that never came to rest.
 */
test.describe('a verdict needs a map it could look at', () => {
  test('.not on an unregistered mapId fails instead of passing', async ({ map, page }) => {
    void map;
    const e = await rejects(expect(geowright(page, { mapId: 'nope' })).not.toHaveFeature({ layer: 'alerts' }, { timeout: FAIL_FAST_MS }));
    expect(e, 'the .not assertion passed although the map could never be queried').not.toBeNull();
    expect(e?.message).toContain('no map registered as "nope"');
  });

  test('.not on a mistyped layer fails, and says the layer does not exist', async ({ map }) => {
    const e = await rejects(expect(map).not.toHaveFeature({ layer: 'alert' }, { timeout: FAIL_FAST_MS }));
    expect(e, '.not.toHaveFeature passed for a layer that does not exist').not.toBeNull();
    expect(e?.message).toContain('layer "alert" does not exist. Layers:');
    const count = await rejects(expect(map.features({ layer: 'alert' })).toHaveFeatureCount(0, { timeout: FAIL_FAST_MS }));
    expect(count, 'toHaveFeatureCount(0) passed for a layer that does not exist').not.toBeNull();
    // a positive assertion fails for the same reason, and names it
    const pos = await rejects(expect(map).toHaveFeature({ layer: 'alert' }, { timeout: FAIL_FAST_MS }));
    expect(pos?.message).toContain('layer "alert" does not exist');
  });

  test('.not.toHaveGeometry on a feature that is not on the map fails', async ({ map }) => {
    const e = await rejects(expect(map.feature({ layer: 'alerts', id: 999 })).not.toHaveGeometry({ type: 'Point', coordinates: [0, 0] }, { timeout: FAIL_FAST_MS }));
    expect(e, '.not.toHaveGeometry passed for a feature that is not on the map').not.toBeNull();
    expect(e?.message).toContain('no rendered feature matches');
    // ...while a real difference is a verdict
    await expect(map.feature({ layer: 'alerts', id: 1 })).not.toHaveGeometry({ type: 'Point', coordinates: [0, 0] }, { timeout: 800 });
  });
});

/**
 * a `.not` or count verdict is taken only from a map that has settled (idle, or diagnosed as never idle) — a
 * half-loaded map is not evidence of absence. The data here arrives late from a slow server (a delayed route answer).
 */
test.describe('a negative verdict waits for the map to settle', () => {
  const late = async (page: import('@playwright/test').Page, id: string, delayMs: number) => {
    await page.route(`**/${id}.geojson`, async (r) => {
      await new Promise((res) => setTimeout(res, delayMs)); // the server is slow; the test does not sleep
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [34.78, 32.08] } }] }) });
    });
    await page.evaluate((id) => {
      const m = (window as any).__geowright_maps.main;
      m.addSource(id, { type: 'geojson', data: `${location.origin}/${id}.geojson` });
      m.addLayer({ id, type: 'circle', source: id, paint: { 'circle-radius': 10, 'circle-color': '#f0f' } });
    }, id);
  };

  const matchers = {
    '.not.toHaveFeature': (map: MapHandle, layer: string, timeout: number) => expect(map).not.toHaveFeature({ layer }, { timeout }),
    'toHaveFeatureCount(0)': (map: MapHandle, layer: string, timeout: number) => expect(map.features({ layer })).toHaveFeatureCount(0, { timeout }),
    '.not.toBeVisibleOnMap': (map: MapHandle, layer: string, timeout: number) => expect(map.feature({ layer })).not.toBeVisibleOnMap({ timeout }),
  };

  for (const [name, assertion] of Object.entries(matchers)) {
    test(`${name} does not pass while a source is still loading (2.5 s)`, async ({ map, page }) => {
      await late(page, 'late', 2500);
      const t0 = Date.now();
      const e = await rejects(assertion(map, 'late', 4000));
      const took = Date.now() - t0;
      await expect(map).toHaveFeature({ layer: 'late' }); // the feature does arrive
      expect(e, `${name} passed after ${took} ms, while the map was still loading the source`).not.toBeNull();
    });
  }

  for (const name of ['.not.toHaveFeature', '.not.toBeVisibleOnMap'] as const) {
    test(`${name} fails for a feature that appears 300 ms after the call starts`, async ({ map, page }) => {
      await late(page, 'soon', 300);
      const e = await rejects(matchers[name](map, 'soon', 2000));
      expect(e, `${name} passed although the feature appeared 300 ms later`).not.toBeNull();
    });
  }

  // Only absence needs a settled map: a POSITIVE assertion that finds nothing on a loading map simply has not found it
  // yet, and says so — not "no verdict … absence could not be concluded".
  for (const [name, assertion] of Object.entries({
    toHaveFeature: (map: MapHandle, timeout: number) => expect(map).toHaveFeature({ layer: 'slow' }, { timeout }),
    toBeVisibleOnMap: (map: MapHandle, timeout: number) => expect(map.feature({ layer: 'slow' })).toBeVisibleOnMap({ timeout }),
  })) {
    test(`a positive ${name} on a still-loading source fails as "not found", not as "no verdict"`, async ({ map, page }) => {
      await late(page, 'slow', 5000);
      const e = await rejects(assertion(map, 1000));
      expect(e?.message).not.toMatch(/no verdict/);
    });
  }
});

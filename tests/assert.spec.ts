import { test, expect } from './fixtures';
import { geowright, type MapHandle } from '../src/playwright';
import { vectorTileHandler } from '../src/playwright/tiles';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * ASSERT gap: an action in the regular DOM UI must be verifiable ON THE MAP.
 * The demo's save/remove are async with a random 100–400ms delay, like a real backend call.
 */
test.describe('assert gap', () => {
  test('initial map content', async ({ map }) => {
    await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
    await expect(map).toHaveFeature({ layer: 'parcels', id: 105 });
    await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3); // alert 4 exists but is off-screen
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

  // toHaveGeometry compares in pixels, within tolerancePx (default 2). Every other negative toHaveGeometry in the suite
  // is off by many times its tolerance, so a comparison three times as lenient passed all of them, for a vertex list
  // and for the circle form alike. These hold the tolerance near its limit: each shape is built from pixel offsets
  // around the view centre, 4 px from what is expected.
  test('toHaveGeometry: tolerancePx is held near its limit, a vertex 4 px off fails at 2 and 3 and passes at 5', async ({ map, page }) => {
    const { line, off } = await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.project(m.getCenter());
      const at = (dx: number, dy: number) => m.unproject([c.x + dx, c.y + dy]).toArray();
      const line = [at(-60, 0), at(0, 0), at(60, 0)];
      m.addSource('tol', { type: 'geojson', data: { type: 'Feature', properties: { name: 'tol' }, geometry: { type: 'LineString', coordinates: line } } });
      m.addLayer({ id: 'tol', type: 'line', source: 'tol', paint: { 'line-width': 4, 'line-color': '#333' } });
      return { line, off: [at(-60, 0), at(0, 4), at(60, 0)] }; // the middle vertex 4 px south
    });
    const tol = map.feature({ layer: 'tol' });
    await expect(tol, 'the premise: the line is where it was put').toHaveGeometry({ type: 'LineString', coordinates: line });
    await expect(tol).not.toHaveGeometry({ type: 'LineString', coordinates: off });
    await expect(tol).not.toHaveGeometry({ type: 'LineString', coordinates: off }, { tolerancePx: 3 });
    await expect(tol).toHaveGeometry({ type: 'LineString', coordinates: off }, { tolerancePx: 5 });
  });

  test('toHaveGeometry({ circle }): tolerancePx is held near its limit, a circle 4 px wider fails at 2 and 3 and passes at 5', async ({ map, page }) => {
    const { centre, edge60, edge64 } = await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.project(m.getCenter());
      const ll = (dx: number, dy: number) => m.unproject([c.x + dx, c.y + dy]);
      // a 36-gon of radius 60 px; the expected circle below has radius 64 px, so every vertex is 4 px off it
      const ring = Array.from({ length: 37 }, (_, i) => ll(60 * Math.cos((i * Math.PI) / 18), 60 * Math.sin((i * Math.PI) / 18)).toArray());
      ring[36] = ring[0];
      m.addSource('disc', { type: 'geojson', data: { type: 'Feature', properties: { name: 'disc' }, geometry: { type: 'Polygon', coordinates: [ring] } } });
      m.addLayer({ id: 'disc', type: 'line', source: 'disc', paint: { 'line-width': 3, 'line-color': '#333' } });
      const lngLat = (v: { lng: number; lat: number }) => ({ lng: v.lng, lat: v.lat });
      return { centre: lngLat(ll(0, 0)), edge60: lngLat(ll(60, 0)), edge64: lngLat(ll(64, 0)) };
    });
    const disc = map.feature({ layer: 'disc' });
    await expect(disc, 'the premise: the 36-gon lies on the 60 px circle').toHaveGeometry({ circle: { center: centre, edge: edge60 } });
    await expect(disc).not.toHaveGeometry({ circle: { center: centre, edge: edge64 } });
    await expect(disc).not.toHaveGeometry({ circle: { center: centre, edge: edge64 } }, { tolerancePx: 3 });
    await expect(disc).toHaveGeometry({ circle: { center: centre, edge: edge64 } }, { tolerancePx: 5 });
  });

  // toHaveGeometry counts parts and vertices, both ways. No other spec has a multi-part geometry, and the one count
  // mismatch asserted (draw.spec) has MORE vertices on the map than expected, so a part count that let an extra part on
  // the map through, or a vertex count that let a line or ring a vertex short through, passed every spec. Each
  // expectation below is the feature's own shape with a part or vertex added or taken away at the end, so only the
  // count can reject it; the reason is asserted too.
  test('toHaveGeometry counts the parts: a part more on the map, or a part fewer, fails', async ({ map, page }) => {
    const parts = await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.project(m.getCenter());
      const at = (dx: number, dy: number) => m.unproject([c.x + dx, c.y + dy]).toArray();
      const parts = [[at(-60, -30), at(60, -30)], [at(-60, 30), at(60, 30)], [at(-60, 90), at(60, 90)]];
      // the map's feature has the first two parts only
      m.addSource('two', { type: 'geojson', data: { type: 'Feature', properties: { name: 'two' }, geometry: { type: 'MultiLineString', coordinates: parts.slice(0, 2) } } });
      m.addLayer({ id: 'two', type: 'line', source: 'two', paint: { 'line-width': 3, 'line-color': '#333' } });
      return parts as number[][][];
    });
    const two = map.feature({ layer: 'two' });
    await expect(two, 'the premise: both parts are where they were put').toHaveGeometry({ type: 'MultiLineString', coordinates: parts.slice(0, 2) });
    // a part more on the map than expected
    await expect(two).not.toHaveGeometry({ type: 'MultiLineString', coordinates: parts.slice(0, 1) });
    const more = await rejects(expect(two).toHaveGeometry({ type: 'MultiLineString', coordinates: parts.slice(0, 1) }, { timeout: FAIL_FAST_MS }));
    expect(more?.message).toContain('Received: 2 part(s), expected 1');
    // a part fewer on the map than expected
    await expect(two).not.toHaveGeometry({ type: 'MultiLineString', coordinates: parts });
    const fewer = await rejects(expect(two).toHaveGeometry({ type: 'MultiLineString', coordinates: parts }, { timeout: FAIL_FAST_MS }));
    expect(fewer?.message).toContain('Received: 2 part(s), expected 3');
  });

  test('toHaveGeometry counts the vertices: a line or a polygon ring a vertex short on the map fails', async ({ map, page }) => {
    const { line, tail, ring, bulge } = await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.project(m.getCenter());
      const at = (dx: number, dy: number) => m.unproject([c.x + dx, c.y + dy]).toArray();
      const add = (id: string, geometry: object) => {
        m.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: { name: id }, geometry } });
        m.addLayer({ id, type: 'line', source: id, paint: { 'line-width': 3, 'line-color': '#333' } });
      };
      const line = [at(-60, -60), at(0, -60), at(60, -60)];
      const ring = [at(-40, 0), at(40, 0), at(40, 80), at(-40, 80), at(-40, 0)]; // a square, closed
      add('line3', { type: 'LineString', coordinates: line });
      add('square', { type: 'Polygon', coordinates: [ring] });
      // tail: a fourth vertex after the line's end; bulge: a fifth corner 40 px out from the square's closing (left) edge
      return { line, tail: at(60, 20), ring, bulge: at(-80, 40) };
    });
    const line3 = map.feature({ layer: 'line3' });
    await expect(line3, 'the premise: the line is where it was put').toHaveGeometry({ type: 'LineString', coordinates: line });
    await expect(line3).not.toHaveGeometry({ type: 'LineString', coordinates: [...line, tail] });
    const shortLine = await rejects(expect(line3).toHaveGeometry({ type: 'LineString', coordinates: [...line, tail] }, { timeout: FAIL_FAST_MS }));
    expect(shortLine?.message).toContain('Received: part 0: 3 vertices, expected 4');
    // a ring is compared from any start vertex and either winding: the map's four corners are the expected ring's first four
    const square = map.feature({ layer: 'square' });
    const pentagon = [[...ring.slice(0, 4), bulge, ring[0]]];
    await expect(square, 'the premise: the square is where it was put').toHaveGeometry({ type: 'Polygon', coordinates: [ring] });
    await expect(square).not.toHaveGeometry({ type: 'Polygon', coordinates: pentagon });
    const shortRing = await rejects(expect(square).toHaveGeometry({ type: 'Polygon', coordinates: pentagon }, { timeout: FAIL_FAST_MS }));
    expect(shortRing?.message).toContain('Received: part 0: 4 vertices, expected 5');
  });

  // toHaveGeometry compares the feature's full geometry: a polygon's holes too, not only its outer ring. No other spec
  // has a polygon with a hole, so a comparison of the outer ring alone (the ring counts still checked) passed every
  // spec. Here only the hole moves, 80 px east inside the same outer ring, so only the comparison of the hole can
  // reject it.
  test('toHaveGeometry compares the holes of a polygon: the same donut with its hole elsewhere fails', async ({ map, page }) => {
    const { outer, hole, moved } = await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.project(m.getCenter());
      const at = (dx: number, dy: number) => m.unproject([c.x + dx, c.y + dy]).toArray();
      const square = (x: number, y: number, r: number) => [at(x - r, y - r), at(x + r, y - r), at(x + r, y + r), at(x - r, y + r), at(x - r, y - r)];
      const outer = square(0, 0, 100);
      const hole = square(-40, 0, 30);
      m.addSource('donut', { type: 'geojson', data: { type: 'Feature', properties: { name: 'donut' }, geometry: { type: 'Polygon', coordinates: [outer, hole] } } });
      m.addLayer({ id: 'donut', type: 'fill', source: 'donut', paint: { 'fill-color': '#08f', 'fill-opacity': 0.3 } });
      return { outer, hole, moved: square(40, 0, 30) };
    });
    const donut = map.feature({ layer: 'donut' });
    await expect(donut, 'the premise: the donut and its hole are where they were put').toHaveGeometry({ type: 'Polygon', coordinates: [outer, hole] });
    await expect(donut).not.toHaveGeometry({ type: 'Polygon', coordinates: [outer, moved] });
    const e = await rejects(expect(donut).toHaveGeometry({ type: 'Polygon', coordinates: [outer, moved] }, { timeout: FAIL_FAST_MS }));
    expect(e, 'toHaveGeometry passed with the hole 80 px from where it is').not.toBeNull();
    expect(e?.message).toMatch(/Received: part 0: a vertex is [\d.]+px from where it was expected \(tolerance 2px\)/);
  });

  // toHaveGeometry compares the GeoJSON type too. A one-part MultiPolygon and the Polygon with the same ring have the same
  // parts, rings and vertices, so only the type tells them apart. No other spec compares two different types, so a
  // comparison without the type check passed every spec.
  // Both features are in GeoJSON sources, given as data: the geometry compared is the source's own.
  test('toHaveGeometry compares the geometry type: a one-part MultiPolygon is not the Polygon with the same ring', async ({ map, page }) => {
    const { left, right } = await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.project(m.getCenter());
      const at = (dx: number, dy: number) => m.unproject([c.x + dx, c.y + dy]).toArray();
      const square = (x: number) => [at(x - 40, -40), at(x + 40, -40), at(x + 40, 40), at(x - 40, 40), at(x - 40, -40)];
      const add = (id: string, geometry: object) => {
        m.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: { name: id }, geometry } });
        m.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': '#f80', 'fill-opacity': 0.3 } });
      };
      const left = square(-80), right = square(80);
      add('multi', { type: 'MultiPolygon', coordinates: [[left]] });
      add('single', { type: 'Polygon', coordinates: [right] });
      return { left, right };
    });
    const multi = map.feature({ layer: 'multi' });
    await expect(multi, 'the premise: the one-part MultiPolygon is where it was put').toHaveGeometry({ type: 'MultiPolygon', coordinates: [[left]] });
    await expect(multi).not.toHaveGeometry({ type: 'Polygon', coordinates: [left] });
    const asPolygon = await rejects(expect(multi).toHaveGeometry({ type: 'Polygon', coordinates: [left] }, { timeout: FAIL_FAST_MS }));
    expect(asPolygon, 'toHaveGeometry passed a one-part MultiPolygon as a Polygon').not.toBeNull();
    expect(asPolygon?.message).toContain('Received: geometry type is MultiPolygon, expected Polygon');
    const single = map.feature({ layer: 'single' });
    await expect(single, 'the premise: the Polygon is where it was put').toHaveGeometry({ type: 'Polygon', coordinates: [right] });
    await expect(single).not.toHaveGeometry({ type: 'MultiPolygon', coordinates: [[right]] });
    const asMulti = await rejects(expect(single).toHaveGeometry({ type: 'MultiPolygon', coordinates: [[right]] }, { timeout: FAIL_FAST_MS }));
    expect(asMulti, 'toHaveGeometry passed a Polygon as a one-part MultiPolygon').not.toBeNull();
    expect(asMulti?.message).toContain('Received: geometry type is Polygon, expected MultiPolygon');
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

  // toHaveView used to swallow the error of every poll and blame "the map never came to rest (last seen: undefined)".
  test('toHaveView on an unregistered mapId says so, in both polarities', async ({ map, page }) => {
    void map;
    const other = geowright(page, { mapId: 'nope' });
    for (const e of [
      await rejects(expect(other).toHaveView({ zoom: 12 }, { timeout: FAIL_FAST_MS })),
      await rejects(expect(other).not.toHaveView({ zoom: 12 }, { timeout: FAIL_FAST_MS })),
    ]) {
      expect(e, 'toHaveView passed on a map that could never be asked').not.toBeNull();
      expect(e?.message).toContain('no map registered as "nope"');
      expect(e?.message).toContain('nothing seen');
      expect(e?.message).not.toContain('never came to rest');
      expect(e?.message).not.toContain('undefined');
    }
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
    await expect(map.feature({ layer: 'alerts', id: 1 })).not.toHaveGeometry({ type: 'Point', coordinates: [0, 0] });
  });
});

/**
 * a `.not` or count verdict is taken only from a map that has settled (idle, or diagnosed as never idle) — a
 * half-loaded map is not evidence of absence. The data here arrives late from a slow server (a delayed route answer).
 */
test.describe('a negative verdict waits for the map to settle', () => {
  const LATE = { lng: 34.78, lat: 32.08 }; // where the late feature is drawn
  const late = async (page: import('@playwright/test').Page, id: string, delayMs: number) => {
    await page.route(`**/${id}.geojson`, async (r) => {
      await new Promise((res) => setTimeout(res, delayMs)); // the server is slow; the test does not sleep
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [LATE.lng, LATE.lat] } }] }) });
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
    // A count above 0 is a verdict about what is not there too: the demo draws three alerts, and the late feature is a
    // fourth match. 3 is true only until it arrives.
    'toHaveFeatureCount(N > 0)': (map: MapHandle, layer: string, timeout: number) => expect(map.features({ layer: ['alerts', layer] })).toHaveFeatureCount(3, { timeout }),
    '.not.toBeVisibleOnMap': (map: MapHandle, layer: string, timeout: number) => expect(map.feature({ layer })).not.toBeVisibleOnMap({ timeout }),
    // The layer's source is still loading, so the layer adds no pixels YET.
    '.not.toHaveLayerPixels': (map: MapHandle, layer: string, timeout: number) => expect(map).not.toHaveLayerPixels(layer, { at: LATE, timeout }),
  };

  // A map that never becomes idle (an animated canvas source; a feed the app re-sets in a loop) is "settled" only when
  // nothing ELSE is still loading: never-idle is no evidence of absence from a source that has not arrived.
  const neverIdle = {
    '': async () => {},
    ' (an animated canvas source elsewhere)': (page: import('@playwright/test').Page) =>
      page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const g = c.getContext('2d')!;
        let t = 0;
        const paint = () => {
          g.fillStyle = `hsl(${t++ % 360},80%,50%)`;
          g.fillRect(0, 0, 16, 16);
          requestAnimationFrame(paint);
        };
        paint();
        const b = m.getBounds();
        const [w, n] = [b.getWest(), b.getNorth()];
        m.addSource('anim', { type: 'canvas', canvas: c, animate: true, coordinates: [[w, n], [w + 0.01, n], [w + 0.01, n - 0.01], [w, n - 0.01]] });
        m.addLayer({ id: 'anim', type: 'raster', source: 'anim' });
      }),
    ' (a feed re-set every 300 ms elsewhere)': (page: import('@playwright/test').Page) =>
      page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('feed', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'feed', type: 'circle', source: 'feed', paint: { 'circle-radius': 4, 'circle-color': '#000' } });
        let i = 0;
        setInterval(() => m.getSource('feed').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { i: i++ }, geometry: { type: 'Point', coordinates: [34.7 + (i % 10) * 0.001, 32.05] } }] }), 300);
      }),
  };

  for (const [name, assertion] of Object.entries(matchers)) {
    for (const [also, start] of Object.entries(neverIdle)) {
      test(`${name} does not pass while a source is still loading (2.5 s)${also}`, async ({ map, page }) => {
        await start(page);
        await late(page, 'late', 2500);
        const t0 = Date.now();
        const e = await rejects(assertion(map, 'late', 4000));
        const took = Date.now() - t0;
        await expect(map).toHaveFeature({ layer: 'late' }); // the feature does arrive
        expect(e, `${name} passed after ${took} ms, while the map was still loading the source`).not.toBeNull();
      });
    }
  }

  for (const name of ['.not.toHaveFeature', '.not.toBeVisibleOnMap', '.not.toHaveLayerPixels'] as const) {
    test(`${name} fails for a feature that appears 300 ms after the call starts`, async ({ map, page }) => {
      await late(page, 'soon', 300);
      const e = await rejects(matchers[name](map, 'soon', 2000));
      expect(e, `${name} passed although the feature appeared 300 ms later`).not.toBeNull();
    });
  }

  // "Not that geometry" is a verdict of absence too: it is taken only from a settled map. toHaveGeometry used to wait
  // for idle and ignore the answer. Where the geometry is read from what is DRAWN (a vector-tile source; a GeoJSON URL
  // source on MapLibre 2/3 and Mapbox GL 1.13), the `.not` then compared against the old drawing while the new data was
  // still loading, and passed half a second in. The app here moves a point by switching its vector tiles to a new
  // version (setTiles); the old tiles stay drawn while the new ones load.
  test('.not.toHaveGeometry does not pass while the source is still loading the new data', async ({ map, page }) => {
    const P0 = [34.79, 32.07];
    const P1 = [34.805, 32.075];
    const at = (coordinates: number[]) => ({ type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, id: 1, properties: { name: 'S' }, geometry: { type: 'Point' as const, coordinates } }] });
    await page.route('**/vt/moving-v1/**', vectorTileHandler({ shapes: at(P0) }));
    const v2 = vectorTileHandler({ shapes: at(P1) });
    let release!: () => void;
    const answer = new Promise<void>((r) => (release = r));
    await page.route('**/vt/moving-v2/**', async (r) => {
      await answer; // the server answers once the assertion is over; the test does not sleep
      await v2(r);
    });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('moving', { type: 'vector', tiles: [`${location.origin}/vt/moving-v1/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14 });
      m.addLayer({ id: 'moving', type: 'circle', source: 'moving', 'source-layer': 'shapes', paint: { 'circle-radius': 8, 'circle-color': '#f0f' } });
    });
    const shape = map.feature({ layer: 'moving' });
    await expect(shape, 'the premise: the point is drawn at P0').toHaveGeometry({ type: 'Point', coordinates: P0 });
    await page.evaluate(() => {
      (window as any).__geowright_maps.main.getSource('moving').setTiles([`${location.origin}/vt/moving-v2/{z}/{x}/{y}.pbf`]);
    });
    const t0 = Date.now();
    const e = await rejects(expect(shape).not.toHaveGeometry({ type: 'Point', coordinates: P1 }, { timeout: FAIL_FAST_MS }));
    const took = Date.now() - t0;
    release();
    await expect(shape, 'the premise: the point moves to P1 once the new tiles are in').toHaveGeometry({ type: 'Point', coordinates: P1 });
    expect(e?.message ?? `.not.toHaveGeometry(P1) passed after ${took} ms, while the tiles with P1 were still loading`).toContain('the map had not settled');
  });

  // Data from a server, replaced two or more times in one settle wait, is a load, not a setData loop (only data re-set
  // inline is). A paged or progressive loader (setData(the next part's URL) as soon as a part has loaded), "clear, then
  // load" (setData(empty), then setData(url)) and two URLs one after the other (the second asked for while the first is
  // loading) do that, while MapLibre is still loading the data, and the map becomes idle once it is in. Such a map was
  // called "never idle", and a .not or a count passed half a second into the load. The data with X comes from a slow
  // server. MapLibre 5 and 6 put a URL's data into the source once it has loaded (and start a URL asked for meanwhile
  // only then): when the wait ended, the source held an object, as if the app had set it inline, and two URLs were taken
  // for a loop. Tiles and an image re-pointed twice are held in 'a map that is loading, moving or slow is not "never
  // idle"' below.
  test.describe('data replaced while MapLibre loads it is not a setData loop', () => {
    const PARTS = 8; // parts 1..8 from a fast server (150 ms each), then part 9 (the eight and X) from a slow one (3 s)
    const dot = (name: string, i: number) => ({ type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: [34.765 + i * 0.003, 32.08] } });
    const body = (n: number, withX: boolean) => ({ type: 'FeatureCollection', features: [...Array.from({ length: n }, (_, i) => dot(`P${i + 1}`, i)), ...(withX ? [dot('X', n)] : [])] });
    const X = { layer: 'results', where: { name: 'X' } };
    type Load = 'data in parts' | 'clear, then load' | 'a URL, then another' | 'one load, the control';
    const start = async (page: import('@playwright/test').Page, map: MapHandle, how: Load) => {
      for (let k = 1; k <= PARTS + 1; k++) {
        const slow = k === PARTS + 1;
        await page.route(`**/settle-part-${k}.geojson`, async (r) => {
          await new Promise((res) => setTimeout(res, slow ? 3000 : 150)); // the server's latency; the test does not sleep
          await r.fulfill({ contentType: 'application/json', body: JSON.stringify(slow ? body(PARTS, true) : body(k, false)) });
        });
      }
      await page.evaluate((old) => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('results', { type: 'geojson', data: old });
        m.addLayer({ id: 'results', type: 'circle', source: 'results', paint: { 'circle-radius': 8, 'circle-color': '#f0f' } });
      }, body(3, false));
      await expect(map.features({ layer: 'results' })).toHaveFeatureCount(3); // the old results are drawn; the map is idle
      await page.evaluate(([how, last]) => {
        const m = (window as any).__geowright_maps.main;
        const src = m.getSource('results');
        const url = (k: number) => `${location.origin}/settle-part-${k}.geojson`;
        if (how === 'data in parts') {
          let k = 1;
          // the next part as soon as one has loaded ('metadata': the source has its data)
          m.on('sourcedata', (e: any) => e.sourceId === 'results' && e.sourceDataType === 'metadata' && k < last && src.setData(url(++k)));
          src.setData(url(1));
        } else if (how === 'a URL, then another') {
          // two effects of one click, on the next frame: each asks for results, the second while the first is loading
          m.once('render', () => {
            src.setData(url(1));
            src.setData(url(last));
          });
        } else if (how === 'clear, then load') {
          // the app clears its old results and asks for new ones on the next frame: the one the assertion's wait asks for
          m.once('render', () => {
            src.setData({ type: 'FeatureCollection', features: [] });
            src.setData(url(last));
          });
        } else src.setData(url(last));
      }, [how, PARTS + 1] as const);
    };

    for (const how of ['data in parts', 'clear, then load', 'a URL, then another', 'one load, the control'] as const) {
      test(`.not.toHaveFeature does not pass while the data is loading (${how})`, async ({ map, page }) => {
        await start(page, map, how);
        const t0 = Date.now();
        const e = await rejects(expect(map).not.toHaveFeature(X, { timeout: 6000 }));
        const took = Date.now() - t0;
        await expect(map, 'the premise: X does arrive').toHaveFeature(X);
        expect(e, `.not.toHaveFeature(X) passed after ${took} ms, while MapLibre was still loading the data with X`).not.toBeNull();
      });
    }

    for (const how of ['data in parts', 'clear, then load', 'a URL, then another'] as const) {
      test(`.not.toHaveFeatureCount does not pass while the data is loading (${how})`, async ({ map, page }) => {
        await start(page, map, how);
        const results = map.features({ layer: 'results' });
        const t0 = Date.now();
        const e = await rejects(expect(results).not.toHaveFeatureCount(PARTS + 1, { timeout: 6000 }));
        const took = Date.now() - t0;
        await expect(results, 'the premise: all of the data does arrive').toHaveFeatureCount(PARTS + 1);
        expect(e, `.not.toHaveFeatureCount(${PARTS + 1}) passed after ${took} ms, on a source MapLibre was still loading`).not.toBeNull();
      });
    }
  });

  // A style that is still loading has no sources yet, so none of them is "pending". The app replaces its style
  // (setStyle(url, { diff: false }): the old style is gone at once, and the new one comes from the server), and
  // MapLibre 3-6 render frame after frame meanwhile (the new placement's symbol fade, 300 ms by default). The map was
  // called "never idle", and an absence query that names no layer passed half a second into the load. The server
  // answers once the assertion is over.
  test.describe('a new style that is still loading', () => {
    const next = {
      version: 8,
      sources: { dots: { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { name: 'dot' }, geometry: { type: 'Point', coordinates: [34.8, 32.08] } }] } } },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#fff8e1' } },
        { id: 'dots', type: 'circle', source: 'dots', paint: { 'circle-radius': 10, 'circle-color': '#e91e63' } },
      ],
    };
    const DOT = { where: { name: 'dot' } };
    const absent = {
      '.not.toHaveFeature': (map: MapHandle, timeout: number) => expect(map).not.toHaveFeature(DOT, { timeout }),
      'toHaveFeatureCount(0)': (map: MapHandle, timeout: number) => expect(map.features(DOT)).toHaveFeatureCount(0, { timeout }),
      '.not.toBeVisibleOnMap': (map: MapHandle, timeout: number) => expect(map.feature(DOT)).not.toBeVisibleOnMap({ timeout }),
    };
    for (const [name, assertion] of Object.entries(absent)) {
      test(`${name} without a named layer does not pass`, async ({ map, page }) => {
        let release!: () => void;
        const answer = new Promise<void>((r) => (release = r));
        await page.route('**/next-style.json', async (r) => {
          await answer; // the server answers once the assertion is over; the test does not sleep
          await r.fulfill({ contentType: 'application/json', body: JSON.stringify(next) });
        });
        await page.evaluate(() => (window as any).__geowright_maps.main.setStyle(`${location.origin}/next-style.json`, { diff: false }));
        const t0 = Date.now();
        const e = await rejects(assertion(map, FAIL_FAST_MS));
        const took = Date.now() - t0;
        release();
        await expect(map, 'the premise: the new style, with the dot, does load').toHaveFeature(DOT);
        const message = e?.message ?? `${name} passed after ${took} ms, while the new style was still loading`;
        expect(message).toContain('the map had not settled');
        expect(message).toContain('the style has not finished loading');
      });
    }
  });

  // "Never idle" is a verdict about a map that animates by design: an animated source, data re-set in a loop, a paint
  // loop. Only then may a .not or a count take its verdict from a map that is not idle. A map that is LOADING, MOVING or
  // merely SLOW becomes idle once it is done, and the verdict must wait for it (the diagnosis is never "still loading",
  // "moving" or "slow"). Each case below holds one rule of that diagnosis. With any of them taken out, the .not passed
  // half a second in, and no other spec noticed.
  // The app acts on the next frame, the first one the assertion's settle wait renders, so that what it starts falls
  // inside that wait. The server answers once the assertion is over; the tests do not sleep.
  test.describe('a map that is loading, moving or slow is not "never idle"', () => {
    const held = () => {
      let release!: () => void;
      const answer = new Promise<void>((r) => (release = r));
      return { answer, release };
    };

    // One load is a load: data that starts loading again and again in one wait is the app re-setting it in a loop, and
    // starting once is not. Nor is starting twice, when the data comes from a server (GeoJSON from a URL, tiles, an
    // image): only data the app has in hand, re-set inline, is a loop. The app here adds an image, or adds one and points
    // it at another at once (two loads in one wait). Two loads used to be taken for a loop unless the source was GeoJSON
    // from a URL, and the .not passed half a second in.
    for (const repointed of [false, true]) {
      const how = repointed ? 'adds and at once re-points (updateImage) is two loads' : 'adds once is a load';
      test(`an image the app ${how}, not a loop: .not.toHaveLayerPixels has no verdict while it loads`, async ({ map, page }) => {
        const server = held();
        const png = await page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = c.height = 16;
          const g = c.getContext('2d')!;
          g.fillStyle = '#e91e63';
          g.fillRect(0, 0, 16, 16);
          return c.toDataURL('image/png').split(',')[1];
        });
        await page.route('**/overlay-*.png', async (r) => {
          await server.answer;
          await r.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
        });
        const at = await page.evaluate((repointed) => {
          const m = (window as any).__geowright_maps.main;
          const c = m.getCenter();
          const d = 0.01;
          m.once('render', () => {
            m.addSource('overlay', { type: 'image', url: `${location.origin}/overlay-1.png`, coordinates: [[c.lng - d, c.lat + d], [c.lng + d, c.lat + d], [c.lng + d, c.lat - d], [c.lng - d, c.lat - d]] });
            m.addLayer({ id: 'overlay', type: 'raster', source: 'overlay', paint: { 'raster-fade-duration': 0 } });
            if (repointed) m.getSource('overlay').updateImage({ url: `${location.origin}/overlay-2.png` });
          });
          return { lng: c.lng, lat: c.lat };
        }, repointed);
        const t0 = Date.now();
        const e = await rejects(expect(map).not.toHaveLayerPixels('overlay', { at, timeout: FAIL_FAST_MS }));
        const took = Date.now() - t0;
        server.release();
        await expect(map, 'the premise: the image does arrive').toHaveLayerPixels('overlay', { at });
        // (no verdict: the map had not settled, or a probe at the deadline found no time to render)
        expect(e?.message ?? `.not.toHaveLayerPixels passed after ${took} ms, while the image was still loading`).toContain('no verdict');
      });
    }

    // Inline GeoJSON that the app adds once is a load too: its data starts loading once, and MapLibre then announces each
    // of its tiles with a 'sourcedataloading' event of its own, which is not a new start. Its label needs a glyph range
    // that the server answers once the assertion is over, so its tiles are still loading when the wait ends. That is a
    // load, not a loop, and the map is not "never idle". With one start counted as a loop, or a tile counted as a start,
    // it was, and no other spec noticed.
    test('inline GeoJSON the app adds once is a load, not a loop, while its tiles are still loading', async ({ map, page }) => {
      await map.waitForIdle();
      const server = held();
      let asked = false;
      await page.route('**/glyphs/*/256-511.pbf', async (r) => {
        asked = true;
        await server.answer;
        await r.fulfill({ contentType: 'application/x-protobuf', body: Buffer.alloc(0) });
      });
      const settled = await page.evaluate(async () => {
        const m = (window as any).__geowright_maps.main;
        let tiles = 0;
        m.on('sourcedataloading', (e: any) => e.sourceId === 'once' && e.tile && tiles++);
        m.once('render', () => {
          const c = m.getCenter();
          // U+0100: in the glyph range 256-511, which nothing on the map has asked for yet
          m.addSource('once', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Ā' }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } }] } });
          m.addLayer({ id: 'once', type: 'symbol', source: 'once', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'] } });
        });
        const answer = await (window as any).__geowright.settle('main', 1000);
        return { ...answer, tiles, loaded: m.isSourceLoaded('once') };
      });
      server.release();
      expect(asked, 'the premise: the label asked for its glyphs').toBe(true);
      expect(settled.tiles, 'the premise: the source asked for its tiles during the wait').toBeGreaterThan(0);
      expect(settled.loaded, 'the premise: its tiles were still loading when the wait ended').toBe(false);
      expect(settled.why ?? '').not.toMatch(/keeps replacing the data/);
      expect(settled.never, `called never idle: ${settled.why}`).toBe(false);
    });

    // The same for tiles: two effects of one click, each pointing a vector source at the newest tiles (setTiles), start
    // two loads in one wait, and the newest tiles are still on their way. Taken for a loop, the map was "never idle" and
    // the .not passed half a second in.
    test('vector tiles the app re-points twice are a load, not a loop: .not.toHaveFeature has no verdict until they are in', async ({ map, page }) => {
      const server = held();
      const version = (v: number) => ({ shapes: { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, id: 1, properties: { v }, geometry: { type: 'Point' as const, coordinates: [34.8, 32.08] } }] } });
      await page.route('**/vt/version-1/**', vectorTileHandler(version(1)));
      await page.route('**/vt/version-2/**', vectorTileHandler(version(2)));
      const v3 = vectorTileHandler(version(3));
      await page.route('**/vt/version-3/**', async (r) => {
        await server.answer;
        await v3(r);
      });
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('versions', { type: 'vector', tiles: [`${location.origin}/vt/version-1/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14 });
        m.addLayer({ id: 'versions', type: 'circle', source: 'versions', 'source-layer': 'shapes', paint: { 'circle-radius': 8, 'circle-color': '#f0f' } });
      });
      await expect(map, 'the premise: version 1 is drawn').toHaveFeature({ layer: 'versions', where: { v: 1 } });
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const tiles = (v: number) => [`${location.origin}/vt/version-${v}/{z}/{x}/{y}.pbf`];
        m.once('render', () => {
          m.getSource('versions').setTiles(tiles(2));
          m.getSource('versions').setTiles(tiles(3));
        });
      });
      const newest = { layer: 'versions', where: { v: 3 } };
      const t0 = Date.now();
      const e = await rejects(expect(map).not.toHaveFeature(newest, { timeout: FAIL_FAST_MS }));
      const took = Date.now() - t0;
      server.release();
      await expect(map, 'the premise: version 3 does arrive').toHaveFeature(newest);
      const message = e?.message ?? `.not.toHaveFeature passed after ${took} ms, while the tiles of version 3 were still loading`;
      expect(message).toContain('the map had not settled');
      expect(message).toMatch(/tiles of source\(s\) [\w, -]*\bversions\b[\w, -]* are still loading/);
    });

    // Tiles are not data replacements, though MapLibre announces each new tile with a 'sourcedataloading' event of its
    // own; and a tiled source whose tiles are still loading is loading.
    test('the tiles of a new view: .not.toHaveFeature has no verdict until they are in', async ({ map, page }) => {
      await expect(map.features({ layer: 'buildings' }), 'the premise: the first view is in').toHaveFeatureCount(25);
      const server = held();
      await page.route('**/vt/buildings/**', async (r) => {
        await server.answer;
        await r.fallback(); // the fixture's tile server
      });
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.once('render', () => m.jumpTo({ center: [35.2, 32.093] })); // the six buildings far to the east (ids 1026-1031)
      });
      const building = { layer: 'buildings', id: 1026 };
      const t0 = Date.now();
      const e = await rejects(expect(map).not.toHaveFeature(building, { timeout: FAIL_FAST_MS }));
      const took = Date.now() - t0;
      server.release();
      await expect(map, 'the premise: the building arrives with its tile').toHaveFeature(building);
      const message = e?.message ?? `.not.toHaveFeature passed after ${took} ms, while the tiles were still loading`;
      expect(message).toContain('the map had not settled');
      expect(message).toMatch(/tiles of source\(s\) [\w, -]*\bbuildings\b[\w, -]* are still loading/);
    });

    // A camera animation renders frame after frame with nothing loading, like an app that animates. The tiled layers are
    // hidden, so that no tile load stands in for the camera as the reason the map is not idle.
    test('a camera animation: .not.toHaveFeature has no verdict while the camera moves toward the feature', async ({ map, page }) => {
      const dest = await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        for (const l of ['basemap', 'buildings']) m.setLayoutProperty(l, 'visibility', 'none');
        const b = m.getBounds();
        const lng = m.getCenter().lng + 1.5 * (b.getEast() - b.getWest()); // one view width beyond the east edge
        const lat = m.getCenter().lat;
        m.addSource('dest', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } } });
        m.addLayer({ id: 'dest', type: 'circle', source: 'dest', paint: { 'circle-radius': 8, 'circle-color': '#f0f' } });
        return [lng, lat];
      });
      const point = { layer: 'dest' };
      await expect(map, 'the premise: out of view before the move').not.toHaveFeature(point);
      await page.evaluate((center) => (window as any).__geowright_maps.main.easeTo({ center, duration: 60_000, easing: (t: number) => t }), dest);
      const t0 = Date.now();
      const e = await rejects(expect(map).not.toHaveFeature(point, { timeout: FAIL_FAST_MS }));
      const took = Date.now() - t0;
      await page.evaluate((center) => (window as any).__geowright_maps.main.jumpTo({ center }), dest); // (stops the animation)
      await expect(map, 'the premise: the point is where the camera was going').toHaveFeature(point);
      const message = e?.message ?? `.not.toHaveFeature passed after ${took} ms, while the camera was moving toward the feature`;
      expect(message).toContain('the map had not settled');
      expect(message).toContain('the camera is moving');
    });

    // A slow page (software GL on a starved CI machine) renders a few frames a second, and few frames prove nothing: it
    // looks the same as an app that repaints the map for ever. Here every frame costs 400 ms while a paint transition keeps
    // the map rendering, with the camera at rest and nothing loading.
    test('a slow page that is still rendering: .not.toHaveFeature has no verdict', async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.on('render', () => {
          const until = performance.now() + 400;
          while (performance.now() < until) {
            /* a slow frame */
          }
        });
        m.setPaintProperty('parcels', 'fill-color-transition', { duration: 60_000, delay: 0 });
        m.setPaintProperty('parcels', 'fill-color', '#123456');
      });
      const t0 = Date.now();
      const e = await rejects(expect(map).not.toHaveFeature({ layer: 'parcels', where: { zoning: 'industrial' } }, { timeout: 3 * FAIL_FAST_MS }));
      const took = Date.now() - t0;
      expect(e?.message ?? `.not.toHaveFeature passed after ${took} ms, on a slow page that was still rendering`).toContain('the map had not settled');
    });

    // The same slow page, whose app replaces the data of a source twice during the wait, from a fast server: it points a
    // vector source at new tiles twice, or loads GeoJSON from a URL in two parts (the second part's URL once the first
    // has its data). The data is in by the end of the wait. Data from a server, replaced twice, is not a loop either: the
    // map is slow, not "never idle". It was called a setData loop, never idle, once the source had loaded: first with
    // tiles, then (MapLibre 5 and 6 keep a URL's data in the source once it has loaded) with GeoJSON from a URL.
    for (const how of ['vector tiles re-pointed twice', 'GeoJSON from a URL, in two parts'] as const) {
      test(`a slow page whose source got new data twice during the wait is slow, not a setData loop (${how})`, async ({ map, page }) => {
        const version = (v: number) => ({ shapes: { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, id: 1, properties: { v }, geometry: { type: 'Point' as const, coordinates: [34.8, 32.08] } }] } });
        for (const v of [1, 2, 3]) await page.route(`**/vt/version-${v}/**`, vectorTileHandler(version(v)));
        for (const v of [2, 3]) await page.route(`**/version-${v}.geojson`, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(version(v).shapes) }));
        await page.evaluate((how) => {
          const m = (window as any).__geowright_maps.main;
          if (how === 'vector tiles re-pointed twice') m.addSource('versions', { type: 'vector', tiles: [`${location.origin}/vt/version-1/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14 });
          else m.addSource('versions', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { v: 1 }, geometry: { type: 'Point', coordinates: [34.8, 32.08] } }] } });
          m.addLayer({ id: 'versions', type: 'circle', source: 'versions', ...(how === 'vector tiles re-pointed twice' && { 'source-layer': 'shapes' }), paint: { 'circle-radius': 8, 'circle-color': '#f0f' } });
        }, how);
        await expect(map, 'the premise: version 1 is drawn').toHaveFeature({ layer: 'versions', where: { v: 1 } });
        const settled = await page.evaluate(async (how) => {
          const m = (window as any).__geowright_maps.main;
          m.on('render', () => {
            const until = performance.now() + 400;
            while (performance.now() < until) {
              /* a slow frame */
            }
          });
          m.setPaintProperty('parcels', 'fill-color-transition', { duration: 60_000, delay: 0 });
          m.setPaintProperty('parcels', 'fill-color', '#123456');
          const src = m.getSource('versions');
          if (how === 'vector tiles re-pointed twice') {
            const tiles = (v: number) => [`${location.origin}/vt/version-${v}/{z}/{x}/{y}.pbf`];
            m.once('render', () => {
              src.setTiles(tiles(2));
              src.setTiles(tiles(3));
            });
          } else {
            const url = (v: number) => `${location.origin}/version-${v}.geojson`;
            let v = 2;
            m.on('sourcedata', (e: any) => e.sourceId === 'versions' && e.sourceDataType === 'metadata' && v < 3 && src.setData(url(++v)));
            m.once('render', () => src.setData(url(2)));
          }
          const answer = await (window as any).__geowright.settle('main', 4000);
          return { ...answer, loaded: m.isSourceLoaded('versions') }; // (read before any other task runs: as the wait ended)
        }, how);
        expect(settled.idle, 'the premise: the slow page keeps rendering through the wait').toBe(false);
        expect(settled.why ?? '').not.toMatch(/keeps replacing the data/);
        expect(settled.never, `called never idle: ${settled.why} (the newest data ${settled.loaded ? 'was' : 'was not yet'} in)`).toBe(false);
      });
    }
  });

  // The other side of the rule: a map that never becomes idle BY DESIGN still gets a verdict of absence. Waiting for its
  // idle cannot help, and an assertion that waited for it would fail on every such map (README: a .not or a count needs
  // the map "idle, or seen to be never idle"). Two kinds of such maps are held here; the third, an animated canvas source,
  // is held by the .not.toHaveLayerPixels in tests/wild/canvas-source.spec.ts. With the diagnosis of a source re-set in a
  // loop, or of continuous repainting, turned into "not settled", its two assertions below failed at their deadline, and
  // no other spec noticed.
  test.describe('a map that never becomes idle by design still gets a verdict', () => {
    const loops = {
      'the app re-sets a source on every frame': async (page: import('@playwright/test').Page, map: MapHandle) => {
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
        await expect(map, 'the premise: the moving point is drawn').toHaveFeature({ layer: 'loop' });
      },
      'the app repaints the map on every frame (a paint property in a requestAnimationFrame loop)': async (page: import('@playwright/test').Page) => {
        await page.evaluate(() => {
          const m = (window as any).__geowright_maps.main;
          const tick = (t: number) => {
            m.setPaintProperty('parcels', 'fill-color', `hsl(${Math.round(t / 20) % 360}, 60%, 50%)`);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
    };
    const NO_SUCH_ALERT = { layer: 'alerts', id: 999 };
    const absent = {
      '.not.toHaveFeature': (map: MapHandle, timeout: number) => expect(map).not.toHaveFeature(NO_SUCH_ALERT, { timeout }),
      'toHaveFeatureCount(0)': (map: MapHandle, timeout: number) => expect(map.features(NO_SUCH_ALERT)).toHaveFeatureCount(0, { timeout }),
    };
    for (const [how, start] of Object.entries(loops)) {
      for (const [name, assertion] of Object.entries(absent)) {
        test(`${name} passes when ${how}`, async ({ map, page }) => {
          await start(page, map);
          await assertion(map, 5 * FAIL_FAST_MS);
        });
      }
    }
  });

  // How long each poll waits for the map to settle. While a verdict of absence is what the assertion waits for, the wait
  // grows (0.5, 1, then 2 s): a slow page that repaints continuously gets enough frames in one wait to be recognised as
  // never idle (the adapter needs 10 frames at 4 fps or more: 20 fps in a 0.5 s wait, 5 fps in a 2 s one). A positive
  // assertion, and an absence on a map already seen to be never idle, wait 0.5 s on every poll: waiting longer cannot help
  // them (docs/DESIGN.md). No slow page is needed to hold this: the page's settle is replaced by one that records the
  // wait each poll asks for and answers "not settled" (or "never idle") for three polls; then the 'pin' source is set to
  // its final data and the page's own settle answers. With the wait fixed at 0.5 s, every other spec still passed.
  test.describe('the settle wait grows only for a verdict of absence', () => {
    const PIN = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [LATE.lng, LATE.lat] } }] };
    const NONE = { type: 'FeatureCollection', features: [] };
    const HELD = 3;
    const holdSettle = async (page: import('@playwright/test').Page, map: MapHandle, o: { never?: boolean; before: object; after: object }) => {
      await page.evaluate((before) => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('pin', { type: 'geojson', data: before });
        m.addLayer({ id: 'pin', type: 'circle', source: 'pin', paint: { 'circle-radius': 10, 'circle-color': '#f0f' } });
      }, o.before);
      await map.waitForIdle();
      await page.evaluate(([o, held]) => {
        const m = (window as any).__geowright_maps.main;
        const api = (window as any).__geowright;
        const settle = api.settle;
        const waits: number[] = ((window as any).__settleWaits = []);
        api.settle = (mapId: string, timeoutMs: number) => {
          waits.push(timeoutMs);
          if (waits.length <= held) return { idle: false, never: !!o.never, why: 'held by the test' };
          if (waits.length === held + 1) m.getSource('pin').setData(o.after);
          return settle(mapId, timeoutMs);
        };
      }, [o, HELD] as const);
    };
    const waits = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__settleWaits as number[]);

    for (const [name, assertion, o, expected] of [
      ['.not.toHaveFeature', (map: MapHandle, timeout: number) => expect(map).not.toHaveFeature({ layer: 'pin' }, { timeout }), { before: NONE, after: NONE }, [500, 1000, 2000, 2000]],
      ['toHaveFeatureCount(0)', (map: MapHandle, timeout: number) => expect(map.features({ layer: 'pin' })).toHaveFeatureCount(0, { timeout }), { before: NONE, after: NONE }, [500, 1000, 2000, 2000]],
      ['a positive toHaveFeature', (map: MapHandle, timeout: number) => expect(map).toHaveFeature({ layer: 'pin' }, { timeout }), { before: NONE, after: PIN }, [500, 500, 500, 500]],
      ['.not.toHaveFeature on a map seen to be never idle', (map: MapHandle, timeout: number) => expect(map).not.toHaveFeature({ layer: 'pin' }, { timeout }), { never: true, before: PIN, after: NONE }, [500, 500, 500, 500]],
    ] as const) {
      test(`${name} waits ${expected.map((ms) => ms / 1000).join(', ')} s on its first four polls`, async ({ map, page }) => {
        await holdSettle(page, map, o);
        await assertion(map, 5 * FAIL_FAST_MS); // it passes once the page's own settle answers: the fourth poll, or a later one
        expect((await waits(page)).slice(0, 4), 'the settle wait each poll asked the page for, in ms').toEqual(expected);
      });
    }
  });

  // Only absence needs a settled map: a POSITIVE assertion that finds nothing on a loading map simply has not found it
  // yet, and says so — not "no verdict … absence could not be concluded".
  // (The source answers well after the assertion's timeout; the timeout is FAIL_FAST_MS, so that the page's first answer
  // fits in it on a loaded machine: without an answer the honest message IS "no verdict: the page did not answer".)
  for (const [name, assertion, notFound] of [
    ['toHaveFeature', (map: MapHandle, timeout: number) => expect(map).toHaveFeature({ layer: 'slow' }, { timeout }), 'Received: 0 match(es)'],
    ['toBeVisibleOnMap', (map: MapHandle, timeout: number) => expect(map.feature({ layer: 'slow' })).toBeVisibleOnMap({ timeout }), 'no rendered feature matches'],
  ] as const) {
    test(`a positive ${name} on a still-loading source fails as "not found", not as "no verdict"`, async ({ map, page }) => {
      await late(page, 'slow', 3 * FAIL_FAST_MS);
      const e = await rejects(assertion(map, FAIL_FAST_MS));
      expect(e?.message).toContain(notFound);
      expect(e?.message).not.toMatch(/no verdict/);
    });
  }
});

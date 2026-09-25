import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';

test.describe('map snapshot (agent layer)', () => {
  test('prints view, layers, entities with clickable client pixels, and what is off-screen', async ({ map, page }) => {
    const snap = await map.snapshot();
    console.log('\n' + snap + '\n');
    expect(snap).toContain('view: center 34.78,32.08 zoom 12');
    expect(snap).toMatch(/\[alerts\] 3 circle entities \(also drawn by: alerts-labels\)/);
    // the colour the style evaluates to FOR THAT FEATURE: "the red one" needs no screenshot
    expect(snap).toMatch(/#1 Point @\(\d+,\d+\) drawn red\(#d32f2f\) id=1 name="Gas leak" severity="high"/);
    expect(snap).toContain('circle-color is data-driven: red(#d32f2f)×1, orange(#f9a825)×1, blue(#1976d2)×1');
    expect(snap).toMatch(/\[roads\] 2 line entities, all drawn grey\(#6d6d6d\)/); // constant colour: said once per layer
    expect(snap).toContain('[source alerts] 1 feature(s) OUTSIDE the viewport (pan to see them; directions are geographic): #4 to the east at 35.2,32.08');
    expect(snap).toMatch(/\[source stations\] \d+ feature\(s\) are inside the view but not drawn individually/);
    expect(snap).toMatch(/\[parcels\] 6 fill entities \(also drawn by: parcels-outline\)/);
    expect(snap).toMatch(/visible but empty in this view: .*td-polygon/);
    expect(snap).toContain('[source stations] 28 feature(s) are inside the view but not drawn individually');
    expect(snap).not.toContain('[alerts-labels]'); // labels are folded into their entity

    // the pixel in the snapshot is directly clickable with plain page.mouse — what an agent would do
    const [, x, y] = snap.match(/#1 Point @\((\d+),(\d+)\)/)!;
    await page.mouse.click(+x, +y);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
  });

  test('skipLayers leaves those layers out of the snapshot', async ({ map }) => {
    expect(await map.snapshot()).toMatch(/\[parcels\] 6 fill entities \(also drawn by: parcels-outline\)/);
    const skipped = await map.snapshot({ skipLayers: ['parcels', 'parcels-outline'] });
    expect(skipped).not.toMatch(/\[parcels(-outline)?\]/);
    expect(skipped).not.toMatch(/#105 Polygon/);
    expect(skipped).toMatch(/\[alerts\] 3 circle entities/);
    // a layer that was not looked at is not "empty": it is simply not in the snapshot (it used to be listed as empty)
    expect(skipped).not.toMatch(/visible but empty in this view: .*parcels/);
    const only = await map.snapshot({ layers: ['alerts'] });
    expect(only).toMatch(/\[alerts\] 3 circle entities/);
    expect(only).not.toMatch(/visible but empty in this view: .*(parcels|roads)/);
  });

  // Identity is id + properties; id-less look-alikes are told apart by where they are drawn. Two id-less data features
  // with the same properties, one drawn and one far outside the view, used to both count as drawn.
  test('an id-less look-alike outside the view is listed as outside, although its twin is drawn', async ({ map, page }) => {
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const pt = (lng: number, lat: number) => ({ type: 'Feature', properties: { kind: 'twin' }, geometry: { type: 'Point', coordinates: [lng, lat] } });
      m.addSource('twins', { type: 'geojson', data: { type: 'FeatureCollection', features: [pt(34.77, 32.075), pt(35.3, 32.075)] } });
      m.addLayer({ id: 'twins', type: 'circle', source: 'twins', paint: { 'circle-radius': 6, 'circle-color': '#000' } });
    });
    await map.waitForIdle();
    const snap = await map.snapshot();
    expect(snap).toMatch(/\[twins\] 1 circle entity/);
    expect(snap).toContain('[source twins] 1 feature(s) OUTSIDE the viewport');
    expect(snap).not.toContain('[source twins] 1 feature(s) are inside the view but not drawn individually');
  });

  test('the calls agent/MAP_SKILL.md tells an agent to make work as written', async ({ map, page }) => {
    const skill = readFileSync(new URL('../agent/MAP_SKILL.md', import.meta.url), 'utf8');
    const calls = skill.split('\n').filter((l) => /^ {2}async \(\) =>/.test(l)).map((l) => l.trim());
    expect(calls, 'the two browser_evaluate functions in MAP_SKILL.md').toHaveLength(2);
    await map.waitForIdle();
    const snap = await page.evaluate<string>(`(${calls[0]})()`);
    expect(snap).toContain('view: center 34.78,32.08 zoom 12');
    expect(snap).toMatch(/#1 Point @\(\d+,\d+\) drawn red\(#d32f2f\) id=1 name="Gas leak"/);
    // the filter call, with the skill's example layer and property swapped for the demo's
    expect(calls[1]).toContain("filter: { layer: 'assets', where: { serial: 'SN-12345' } }");
    const filtered = await page.evaluate<string>(`(${calls[1].replace("layer: 'assets'", "layer: 'alerts'").replace("serial: 'SN-12345'", "severity: 'high'")})()`);
    expect(filtered).toContain('name="Gas leak"');
    expect(filtered).not.toContain('name="Road closure"');
  });

  test('string-id features that are drawn are not also counted as "not drawn individually"', async ({ map, page }) => {
    // terra-draw gives its features UUID ids; MapLibre renders them with a coerced (numeric) id
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon([{ lng: 34.825, lat: 32.04 }, { lng: 34.85, lat: 32.04 }, { lng: 34.85, lat: 32.055 }, { lng: 34.825, lat: 32.055 }], { finish: 'click-first' });
    await expect(page.getByTestId('draw-count')).toHaveText('1');
    await expect(map.features({ layer: 'td-polygon' })).toHaveFeatureCount(1);
    const source = (await map.layers()).find((l) => l.id === 'td-polygon')!.source!;
    const snap = await map.snapshot();
    expect(snap).toMatch(/\[td-polygon\] 1 fill entity/);
    expect(snap).not.toContain(`[source ${source}] 1 feature(s) are inside the view but not drawn individually`);
    expect(snap).toContain('[source stations] 28 feature(s) are inside the view but not drawn individually'); // the true ones stay
  });

  test('filter.at lists only the entities drawn at that location', async ({ map }) => {
    const at = await map.feature({ layer: 'alerts', id: 1 }).lngLat();
    const snap = await map.snapshot({ filter: { layer: 'alerts', at } });
    expect(snap).toMatch(/\[alerts\] 1 circle entity/);
    expect(snap).toMatch(/#1 Point @\(\d+,\d+\) .*name="Gas leak"/);
  });

  // A RegExp `where` value is sent to the page as a pattern, as every other query does; it used to reach the page as a
  // RegExp object and throw "a where operator object has no operator in it".
  test('filter takes a RegExp where value, like every other query', async ({ map }) => {
    const snap = await map.snapshot({ filter: { layer: 'alerts', where: { name: /^gas/i } } });
    expect(snap).toMatch(/\[alerts\] 1 circle entity/);
    expect(snap).toContain('name="Gas leak"');
    expect(snap).not.toContain('name="Road closure"');
  });

  test('is bounded: per-layer cap with a summary of the remainder', async ({ map }) => {
    const snap = await map.snapshot({ perLayer: 2 });
    expect(snap).toMatch(/\[parcels\] 6 fill entities/);
    expect(snap).toMatch(/… 4 more not listed \(nearest to the view centre are listed\)\. Summary of all \d+ — .*zoning: /);
    expect(snap.split('\n').length).toBeLessThan(50);
  });
});

import { brightBasemap } from './basemap';
import { example, expect, test } from './harness';

/**
 * Basemap LABELS competing with an app's features. The sparse synthetic basemap (~25 layers, a few labels) never
 * exercised this; the dense one — the default since an earlier change — is 79 layers with 24 symbol layers and hundreds of labels
 * in view (label density per zoom: basemap-density.spec.ts). MapLibre's 3D-buildings
 * example inserts its layer BELOW the first label layer — recommended practice — so house numbers, POI names, street
 * names and neighbourhood labels are drawn ON TOP of the buildings a test wants to click.
 */
const NYC = brightBasemap([-74.0066, 40.7135], { dense: true });

test.describe('wild: dense, label-heavy basemap', () => {
  test('the dense style is production-sized: 60+ layers, 20+ label layers, hundreds of labels in view', async ({ wild }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes: NYC });
    const layers = await map.layers();
    expect(layers.length).toBeGreaterThanOrEqual(60);
    expect(layers.filter((l) => l.type === 'symbol').length).toBeGreaterThanOrEqual(20);
    expect(await map.features({ layerType: 'symbol' }).count()).toBeGreaterThan(250);
  });

  test('buildings under labels: a label on the best pixel is skipped, never clicked through; every click lands on the asked building', async ({ wild, page }) => {
    test.slow();
    const map = await wild.open(example('display-buildings-in-3d'), { routes: NYC });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.on('click', (e: any) => ((window as any).__top = m.queryRenderedFeatures(e.point).map((f: any) => `${f.layer.id}#${f.id}`)[0]));
    });
    const buildings = (await map.features({ layer: '3d-buildings' }).all()).slice(0, 30);
    const skippedUnder = new Set<string>();
    let clicked = 0;
    for (const b of buildings) {
      const r = await map._call<{ ok: boolean; why?: string; reason?: string; message?: string }>('actionPoint', { layer: '3d-buildings', id: b.id }, {});
      if (!r.ok) {
        // honest refusals only: fully covered, or (at the viewport edge) only a sliver in view
        expect(`${r.reason}: ${r.message}`).toMatch(/^(occluded|offscreen): /);
        continue;
      }
      const under = /under another feature \(([\w-]+?)(#|\))/.exec(r.why ?? '')?.[1];
      if (under) skippedUnder.add(under);
      await map.feature({ layer: '3d-buildings', id: b.id }).click();
      // the TOPMOST thing at the clicked pixel is the building itself — not a label with the building underneath
      expect(await page.evaluate(() => (window as any).__top)).toBe(`3d-buildings#${b.id}`);
      clicked++;
    }
    expect(clicked).toBeGreaterThanOrEqual(25);
    // and labels really were in the way: for some buildings the best pixel was under a basemap label
    expect([...skippedUnder].some((l) => /housenumber|poi_|highway-name|label_/.test(l))).toBe(true);
  });

  test('{ ignoreLayers } says "labels are not in the way": the first candidate is used even under a label', async ({ wild }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes: NYC });
    const labelLayers = (await map.layers()).filter((l) => l.type === 'symbol').map((l) => l.id);
    const buildings = (await map.features({ layer: '3d-buildings' }).all()).slice(0, 30);
    let changed = 0;
    for (const b of buildings) {
      const strict = await map._call<{ ok: boolean; why?: string }>('actionPoint', { layer: '3d-buildings', id: b.id }, {});
      if (!strict.ok || !/under another feature \((housenumber|poi_|highway-name|label_)/.test(strict.why ?? '')) continue;
      const relaxed = await map._call<{ ok: boolean; why?: string }>('actionPoint', { layer: '3d-buildings', id: b.id }, { ignoreLayers: labelLayers });
      expect(relaxed.ok).toBe(true);
      expect(relaxed.why).not.toMatch(/under another feature \((housenumber|poi_|highway-name|label_)/);
      changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });

  test("an app's own symbols on top of a dense basemap: all nine places stay visible and clickable", async ({ wild }) => {
    const routes = brightBasemap([-77.04, 38.907], { icons: ['art-gallery', 'rocket'], dense: true });
    const map = await wild.open(example('display-a-popup-on-click'), { routes });
    await expect(map.features({ layer: 'places' })).toHaveFeatureCount(9);
    const rocket = { layer: 'places', where: { description: /Capital Pride Parade/ } };
    await map.feature(rocket).click();
    await expect(map).toHavePopup({ feature: rocket, text: 'Capital Pride Parade' });
  });

  test('snapshot of an app on a production-sized basemap: the app layer keeps its rows within the default budget', async ({ wild }) => {
    // Was a known library bug (an earlier change): on this basemap the app layer kept 1 row of 374. 3d-buildings is on the
    // basemap's own source; it counts as the app's because it is the only fill-extrusion layer there.
    const map = await wild.open(example('display-buildings-in-3d'), { routes: NYC });
    const snap = await map.snapshot();
    expect(snap.length).toBeLessThanOrEqual(8000);
    expect(snap).toMatch(/\[3d-buildings\] \d+ fill-extrusion entities/);
    expect(snap.match(/^  #\d+ Polygon @\(\d+,\d+\).* render_height=/gm)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  // Was a KNOWN LIBRARY BUG (an earlier change), found by the dense default basemap (an earlier change): snapshot() kept every basemap
  // layer's section (count, histogram, "to list specific ones" hint) and every basemap layer id in the header, and to
  // fit the budget shrank the APP's own rows to zero and then cut the text: with 25+ basemap layers in view, their
  // row-less sections alone exceeded the budget. The REAL OpenFreeMap style did the same (display-buildings-in-3d: 0 of
  // 1,025 building rows). Now the basemap is condensed in stages first (engine.ts, snapshot budget).
  test("snapshot budget: an app's 9 symbols on a production-sized basemap are all listed within the default budget", async ({ wild }) => {
    const map = await wild.open(example('display-a-popup-on-click'), { routes: brightBasemap([-77.04, 38.907], { icons: ['art-gallery', 'rocket'] }) });
    const snap = await map.snapshot();
    expect(snap).toContain('[places] 9 symbol entities');
    expect(snap.match(/^  - Point @\(\d+,\d+\).* description=/gm)?.length ?? 0).toBe(9);
  });

  test('snapshot under an explicit tight budget: the app keeps every row; the basemap shrinks to one line per source that still says what it is and how to ask for more', async ({ wild }) => {
    const map = await wild.open(example('display-a-popup-on-click'), { routes: brightBasemap([-77.04, 38.907], { icons: ['art-gallery', 'rocket'] }) });
    for (const maxChars of [3000, 2200]) {
      const snap = await map.snapshot({ maxChars });
      expect(snap.length).toBeLessThanOrEqual(maxChars);
      expect(snap).not.toContain('cut to fit');
      // every one of the app's places keeps its row: a clickable pixel and its properties
      expect(snap).toContain('[places] 9 symbol entities');
      expect(snap.match(/^  - Point @\(\d+,\d+\).* description=/gm)?.length ?? 0).toBe(9);
      // the basemap is still visibly there, counted where it sits in the stack and summarised by kind …
      expect(snap).toMatch(/^layers with content, top to bottom: places\(symbol,geojson\) \(\d+ basemap layers on openmaptiles\)$/m);
      expect(snap).toMatch(/^\[basemap source openmaptiles\] \d+ entities on \d+ layers, none listed — .*symbol.*line.*fill/m);
      // … with no per-layer basemap sections left, and one note on how to list a layer
      expect(snap).not.toMatch(/^\[highway-minor\]/m);
      expect(snap).toContain("snapshot('<mapId>', { layers: ['<layer id>'] })");
      // at 3000 characters there is room to name the basemap's layers, with their entity counts
      if (maxChars === 3000) expect(snap).toMatch(/line: [^;]*\bhighway-minor \d+/);
    }
    // asking for a basemap layer by name, as the note says, lists its rows again under the same budget
    const one = await map.snapshot({ layers: ['highway-minor'], maxChars: 2200 });
    expect(one).toMatch(/^\[highway-minor\] \d+ line entities/m);
    expect(one.match(/^  #\d+ LineString @\(\d+,\d+\)/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

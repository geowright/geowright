import { brightBasemap } from './basemap';
import { example, test } from './harness';

/**
 * The gate's cost, measured before the gated pixel probe (decision 0022) was built — NOT part of the suite: runs only with GEOWRIGHT_MEASURE=1.
 *   uptime && GEOWRIGHT_MEASURE=1 npx playwright test tests/wild/gate-measure.spec.ts --workers=1
 * The cost of the gate ("does a visible pixel-only layer drawn above the target cover the aimed pixel?") on the largest
 * style in the repository: the dense synthetic basemap, 79 layers. A PROTOTYPE of the gate, from the design comment's
 * table, public API only; the target is the lowest layer, so every other layer is above it (the worst case).
 */
test.describe('measure: the pixel-only-layer gate', () => {
  test.skip(!process.env.GEOWRIGHT_MEASURE, 'set GEOWRIGHT_MEASURE=1');

  test('dense basemap, 79 layers', async ({ wild, page }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes: brightBasemap([-74.0066, 40.7135], { dense: true }) });
    await map.waitForIdle();
    const rows = await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const OPACITY: Record<string, string | null> = { raster: 'raster-opacity', hillshade: null, 'color-relief': 'color-relief-opacity', background: 'background-opacity', custom: null, heatmap: 'heatmap-opacity' };
      const merc = ([lng, lat]: number[]) => [(lng + 180) / 360, (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360];
      const inside = (p: number[], poly: number[][]) => {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          if (poly[i][1] > p[1] !== poly[j][1] > p[1] && p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
        }
        return c;
      };
      const gate = (target: string, at: { x: number; y: number }, viaStyle: boolean) => {
        const ids: string[] = !viaStyle && m.getLayersOrder ? m.getLayersOrder() : m.getStyle().layers.map((l: { id: string }) => l.id);
        const z = m.getZoom();
        let ll: { lng: number; lat: number } | undefined;
        const out: string[] = [];
        for (let i = ids.indexOf(target) + 1; i < ids.length; i++) {
          const id = ids[i];
          const l = m.getLayer(id);
          if (!(l.type in OPACITY)) continue;
          if (m.getLayoutProperty(id, 'visibility') === 'none') continue;
          if ((l.minzoom && z < l.minzoom) || (l.maxzoom && z >= l.maxzoom)) continue;
          const op = OPACITY[l.type];
          if (op && m.getPaintProperty(id, op) === 0) continue;
          const src = l.source ? m.getSource(l.source) : undefined;
          if (src?.coordinates) {
            ll ??= m.unproject([at.x, at.y]);
            if (!inside(merc([ll!.lng, ll!.lat]), src.coordinates.map(merc))) continue;
          }
          out.push(id);
        }
        return out;
      };
      const ids: string[] = m.getLayersOrder();
      const target = ids.find((id) => m.getLayer(id).type !== 'background')!;
      const at = { x: m.getCanvas().clientWidth / 2, y: m.getCanvas().clientHeight / 2 };
      const time = (fn: () => unknown, n = 200) => {
        for (let i = 0; i < 20; i++) fn();
        const t: number[] = [];
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          fn();
          t.push(performance.now() - t0);
        }
        t.sort((a, b) => a - b);
        return { medianMs: +t[n >> 1].toFixed(3), p95Ms: +t[Math.floor(n * 0.95)].toFixed(3) };
      };
      const out: Record<string, unknown> = { layers: ids.length, target, above: ids.length - 1 - ids.indexOf(target) };
      out['no overlay: getLayersOrder()'] = { found: gate(target, at, false), ...time(() => gate(target, at, false)) };
      out['no overlay: getStyle() (MapLibre 2, Mapbox GL 1)'] = { found: gate(target, at, true), ...time(() => gate(target, at, true), 50) };
      const b = m.getBounds();
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      m.addSource('veil', { type: 'image', url: c.toDataURL(), coordinates: [[b.getWest(), b.getNorth()], [b.getEast(), b.getNorth()], [b.getEast(), b.getSouth()], [b.getWest(), b.getSouth()]] });
      m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': 0.5 } });
      out['image veil on top: getLayersOrder()'] = { found: gate(target, at, false), ...time(() => gate(target, at, false)) };
      return out;
    });
    console.log('\nGATE-MEASURE ' + JSON.stringify(rows, null, 1));
  });
});

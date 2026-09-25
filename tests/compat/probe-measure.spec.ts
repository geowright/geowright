import { test } from '@playwright/test';
import { geowright } from '../../src/playwright';
import { routeVectorTiles } from '../../src/playwright/tiles';
import { cpuSlowdown, throttleFromEnv } from '../slow-machine';
import { LIBS } from './libs';

/**
 * Measurements for an earlier issue option B, step 1 — NOT part of the matrix: runs only with GEOWRIGHT_MEASURE=1, one worker.
 *   uptime && GEOWRIGHT_MEASURE=1 npx playwright test -c playwright.compat.config.ts probe-measure --workers=1
 * (and again with GEOWRIGHT_CPU_THROTTLE=4). Check `uptime` first.
 *
 * For each probe: its cost, whether the probed layer's source reloaded ('sourcedataloading', isSourceLoaded right
 * after), and — frame by frame for a while after — whether the target still hit-tests at the probed pixel. The
 * "visibility" route is forced by making the layer's opacity data-driven with the same value.
 */
const PARCELS = {
  type: 'FeatureCollection' as const,
  features: [0, 1, 2].map((i) => ({
    type: 'Feature' as const,
    id: 500 + i,
    properties: { parcel: `P${i}` },
    geometry: { type: 'Polygon' as const, coordinates: [[[34.74 + i * 0.03, 32.125], [34.76 + i * 0.03, 32.125], [34.76 + i * 0.03, 32.135], [34.74 + i * 0.03, 32.135], [34.74 + i * 0.03, 32.125]]] },
  })),
};

const TARGETS = [
  { layer: 'zones', source: 'zones', what: 'GeoJSON fill', at: { lng: 34.72, lat: 32.035 }, opacity: 'fill-opacity' },
  { layer: 'places', source: 'places', what: 'GeoJSON circle', at: { lng: 34.76, lat: 32.06 }, opacity: 'circle-opacity' },
  { layer: 'parcels', source: 'parcels', what: 'vector-tile fill', at: { lng: 34.75, lat: 32.13 }, opacity: 'fill-opacity' },
];
const TRIALS = 5;

test.describe('measure: the pixel probe and the probed source', () => {
  test.skip(!process.env.GEOWRIGHT_MEASURE, 'set GEOWRIGHT_MEASURE=1');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000 * cpuSlowdown());

  for (const lib of LIBS.filter((l) => ['maplibre-gl', 'maplibre-gl-2', 'mapbox-gl-1'].includes(l.alias))) {
    test(lib.label, async ({ page }) => {
      await page.route(/^https?:\/\//, (route) => (route.request().url().includes('localhost') ? route.fallback() : route.abort()));
      await routeVectorTiles(page, '**/vt/parcels/**', { parcels: PARCELS });
      await page.goto(`/?lib=${lib.alias}`);
      const map = geowright(page);
      await map.waitForIdle();
      await map.features({ layer: 'places' }).count(); // inject + warm up
      await throttleFromEnv(page);
      const rows: Record<string, unknown>[] = [];
      for (const route of ['as the probe chooses', 'visibility (forced)'] as const) {
        for (const t of TARGETS) {
          if (route === 'visibility (forced)') {
            await page.evaluate(({ layer, opacity }) => {
              const m = (window as any).__geowright_maps.main;
              const v = m.getPaintProperty(layer, opacity) ?? 1;
              m.setPaintProperty(layer, opacity, ['coalesce', ['get', '__gw_none'], v]);
            }, t);
          }
          for (let i = 0; i < TRIALS; i++) {
            await map.waitForIdle();
            const r = await page.evaluate(
              async ({ layer, source, at, slow }) => {
                const m = (window as any).__geowright_maps.main;
                const api = (window as any).__geowright;
                const c = m.project([at.lng, at.lat]);
                const hit = () => m.queryRenderedFeatures([c.x, c.y], { layers: [layer] }).length > 0;
                let reloads = 0;
                const onLoading = (e: { sourceId?: string }) => void (e.sourceId === source && reloads++);
                m.on('sourcedataloading', onLoading);
                const hitBefore = hit();
                const t0 = performance.now();
                const p = await api.layerPixels('main', layer, at, 2, 5000 * slow);
                const probeMs = performance.now() - t0;
                const loadedRightAfter = m.isSourceLoaded(source);
                const hitRightAfter = hit();
                // follow the frames: until 1.5 s after the last miss (and the source loaded), at most 4 s
                let frames = 0, misses = 0, firstMissMs: number | null = hitRightAfter ? null : 0, backMs: number | null = null, missFrames = hitRightAfter ? 0 : 1;
                const t1 = performance.now();
                let quietSince = hitRightAfter ? 0 : Infinity;
                await new Promise<void>((done) => {
                  const step = () => {
                    frames++;
                    const now = performance.now() - t1;
                    if (!hit()) {
                      misses++;
                      missFrames++;
                      firstMissMs ??= now;
                      quietSince = Infinity;
                    } else if (quietSince === Infinity) {
                      quietSince = now;
                      if (firstMissMs !== null) backMs = now;
                    }
                    if (now > 4000 * slow || (m.isSourceLoaded(source) && now - quietSince > 1500 * slow)) return done();
                    requestAnimationFrame(step);
                  };
                  requestAnimationFrame(step);
                });
                m.off('sourcedataloading', onLoading);
                return { diff: p.diff, probeMs: Math.round(probeMs * 10) / 10, reloads, hitBefore, loadedRightAfter, hitRightAfter, missFrames, firstMissMs: firstMissMs && Math.round(firstMissMs), backMs: backMs && Math.round(backMs), frames };
              },
              { layer: t.layer, source: t.source, at: t.at, slow: cpuSlowdown() },
            );
            rows.push({ lib: lib.alias, route, target: t.what, trial: i, ...r });
          }
        }
      }
      console.log(`\nPROBE-MEASURE ${lib.alias} throttle=${cpuSlowdown()}\n` + rows.map((r) => JSON.stringify(r)).join('\n'));
    });
  }
});

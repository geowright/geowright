import { test } from './fixtures';
import { cpuSlowdown } from './slow-machine';

/**
 * Measurement for FAIL_FAST_MS (the timeout of an action a spec EXPECTS to fail) since every action probes a pixel-only
 * layer above its target (decision 0022; a verdict serves one action) — NOT part of the suite: runs only with
 * GEOWRIGHT_MEASURE=1, one worker, and again with GEOWRIGHT_CPU_THROTTLE=4. Check `uptime` first.
 *   uptime && GEOWRIGHT_MEASURE=1 npx playwright test tests/action-probe-measure.spec.ts --workers=1
 *
 * One `actionPoint` round trip is what an expected-failure action must get an answer to within its timeout, or it says
 * "the page did not answer" instead of the reason the spec asserts. Measured: the round trip (test side) and the time
 * in the page, for an opaque veil (the aim probes up to three candidates, then refuses) and a translucent one (one probe).
 */
const TRIALS = 12;
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
  return `median ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${Math.round(s[s.length - 1])} ms`;
};

test.describe('measure: an action round trip with a pixel probe', () => {
  test.skip(!process.env.GEOWRIGHT_MEASURE, 'set GEOWRIGHT_MEASURE=1');
  test.setTimeout(180_000 * cpuSlowdown());

  for (const opacity of [1, 0.5]) {
    test(`a veil at opacity ${opacity} over alert 1`, async ({ map, page }) => {
      await page.evaluate((opacity) => {
        const m = (window as any).__geowright_maps.main;
        const b = m.getBounds();
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d')!;
        g.fillStyle = '#888';
        g.fillRect(0, 0, 64, 64);
        m.addSource('veil', { type: 'image', url: c.toDataURL(), coordinates: [[b.getWest(), b.getNorth()], [b.getEast(), b.getNorth()], [b.getEast(), b.getSouth()], [b.getWest(), b.getSouth()]] });
        m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } });
      }, opacity);
      await map.waitForIdle();
      await map.layers(); // the engine is injected
      const trip: number[] = [], inPage: number[] = [];
      const outcomes = new Set<string>();
      for (let i = 0; i < TRIALS; i++) {
        const t0 = Date.now();
        const r = await page.evaluate(async () => {
          const s = performance.now();
          const r = await (window as any).__geowright.actionPoint('main', { layer: 'alerts', id: 1 }, { budgetMs: 60_000, action: `measure-${Math.random()}` });
          return { ms: performance.now() - s, outcome: r.ok ? 'ok' : r.reason };
        });
        trip.push(Date.now() - t0);
        inPage.push(r.ms);
        outcomes.add(r.outcome);
      }
      const line = `veil ${opacity} (throttle ${cpuSlowdown()}): outcomes ${[...outcomes].join(',')}; round trip ${stats(trip)}; in the page ${stats(inPage)}`;
      console.log(line);
      test.info().annotations.push({ type: 'measure', description: line });
    });
  }
});

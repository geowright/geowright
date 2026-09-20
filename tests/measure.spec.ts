import { test } from './fixtures';
import { geowright } from '../src/playwright';

/**
 * Timings for docs/DESIGN.md — NOT part of the suite: runs only with GEOWRIGHT_MEASURE=1, one worker.
 *   uptime && GEOWRIGHT_MEASURE=1 npx playwright test tests/measure.spec.ts --workers=1
 * Check `uptime` first: every an earlier phase number was taken at load 60–300 and was an upper bound.
 */
test.describe('measurements', () => {
  test.skip(!process.env.GEOWRIGHT_MEASURE, 'set GEOWRIGHT_MEASURE=1');
  test.describe.configure({ mode: 'serial' });

  test('dense map: in-page costs (median of 5)', async ({ page }) => {
    await page.goto('/dense.html');
    const map = geowright(page);
    await map.waitForIdle();
    await map.features({ layer: 'assets' }).count(); // inject + warm up
    const rows = await page.evaluate(async () => {
      const api = (window as any).__geowright;
      const median = async (fn: () => unknown) => {
        const t: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await fn();
          t.push(performance.now() - t0);
        }
        return Math.round(t.sort((a, b) => a - b)[2]);
      };
      return {
        'find 3,240 points': await median(() => api.find('main', { layer: 'assets' })),
        'find 415 polygons': await median(() => api.find('main', { layer: 'lots' })),
        'find + where (20 matches)': await median(() => api.find('main', { layer: 'assets', where: { status: 'fault', kind: 'pump' } })),
        "find + visible:'any' (no paint evaluation)": await median(() => api.find('main', { layer: 'assets', visible: 'any' })),
        'actionPoint (incl. two-frame wait)': await median(() => api.actionPoint('main', { layer: 'assets', id: 12231 }, {})),
        'snapshot()': await median(() => api.snapshot('main', {})),
        'entities() max 80': await median(() => api.entities('main', { max: 80 })),
      };
    });
    console.log('\nDENSE ' + JSON.stringify(rows, null, 1));
  });

  test('pixel probe (toBeVisibleOnMap) — first and warm', async ({ map, page }) => {
    await page.getByTestId('toggle-sensors').check();
    await map.waitForIdle();
    const times = await page.evaluate(async () => {
      const api = (window as any).__geowright;
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await api.pixelProbe('main', { layer: 'sensors', id: 501 });
        out.push(Math.round(performance.now() - t0));
      }
      return out;
    });
    console.log('\nPIXEL PROBE ms (first, then warm): ' + times.join(', '));
  });

  test('globe: whole-world view, time per step', async ({ map, page }) => {
    const t = (label: string, t0: number) => console.log(`GLOBE ${label}: ${Date.now() - t0} ms`);
    let t0 = Date.now();
    await page.getByTestId('camera-preset').selectOption('globe-2');
    await map.waitForIdle();
    t('select globe-2 (whole world) + waitForIdle', t0);
    t0 = Date.now();
    await map.clickAt({ lng: 34.78, lat: 32.08 });
    t('clickAt near side', t0);
    t0 = Date.now();
    await map.clickAt({ lng: -145, lat: -32 }, { timeout: 1000 }).catch(() => {});
    t('clickAt far side (refusal, 1000 ms timeout)', t0);
    t0 = Date.now();
    await map.snapshot();
    t('snapshot', t0);
  });
});

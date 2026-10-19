import { test, expect, type Page } from '@playwright/test';
import { DEAD_WORKER_AFTER_MS, deadWorkerDiagnosis, type PendingSource } from '../../src/inpage/maplibre-adapter';
import { expect as geowrightExpect, MapHandle } from '../../src/playwright/index';

const inline = (id: string, forMs: number): PendingSource => ({ id, type: 'geojson', inline: true, forMs });

test.describe('waitForIdle diagnosis: a dead web worker', () => {
  test('inline GeoJSON pending for seconds and no worker-backed source loaded: says DEAD WORKER, names the sources', () => {
    const why = deadWorkerDiagnosis([inline('lots', 7200), inline('assets', 7100)], 0);
    expect(why).toContain('source(s) lots, assets hold inline GeoJSON');
    expect(why).toContain('have not loaded for 7s');
    expect(why).toContain('DEAD WORKER');
    expect(why).toContain("optimizeDeps: { exclude: ['maplibre-gl'] }");
  });

  test('one loaded GeoJSON or vector source proves the workers run: no accusation', () => {
    expect(deadWorkerDiagnosis([inline('lots', 60_000)], 1)).toBeUndefined();
  });

  test('not yet: under the threshold a slow parse is still plausible', () => {
    expect(deadWorkerDiagnosis([inline('lots', DEAD_WORKER_AFTER_MS - 1)], 0)).toBeUndefined();
  });

  test('GeoJSON from a URL, and tiled sources, may be waiting for the network: not this diagnosis', () => {
    expect(deadWorkerDiagnosis([{ id: 'places', type: 'geojson', inline: false, forMs: 60_000 }], 0)).toBeUndefined();
    expect(deadWorkerDiagnosis([{ id: 'basemap', type: 'vector', inline: false, forMs: 60_000 }], 0)).toBeUndefined();
  });
});

test.describe('waitForIdle failure: the verdict "never idle" is not replaced by a shorter look that saw less', () => {
  // A scripted page that never becomes idle. Each look's diagnosis is the next in `looks`; the last one repeats.
  const page = (looks: { why?: string; never: boolean }[]) =>
    ({
      evaluate: async (_fn: unknown, [method, , args]: [string, string, unknown[]]) => {
        if (method === 'waitForIdle') {
          await new Promise((r) => setTimeout(r, Math.min(args[0] as number, 300)));
          return { missing: false, value: false };
        }
        return { missing: false, value: looks.length > 1 ? looks.shift() : looks[0] };
      },
    }) as unknown as Page;
  const LOOP = 'the app keeps replacing the data of source(s) point (14 times in 2000ms) — setData in a requestAnimationFrame loop or a timer. Such a map NEVER becomes idle';

  test('the error names the setData loop a longer look saw, not the last short look\'s frame count', async () => {
    const map = new MapHandle(page([{ why: LOOP, never: true }, { why: 'the map rendered 1 frames in 120ms (8.3 per second) with the camera at rest and no source loading', never: false }]));
    await expect(map.waitForIdle({ timeout: 1500 })).rejects.toThrow(`did not become idle (still moving, loading tiles, or repainting) — ${LOOP}`);
  });

  test('without such a verdict the last diagnosis is reported, as before', async () => {
    const map = new MapHandle(page([{ why: 'tiles of source(s) a are still loading', never: false }, { why: 'source(s) b have not finished loading', never: false }]));
    await expect(map.waitForIdle({ timeout: 1500 })).rejects.toThrow('did not become idle (still moving, loading tiles, or repainting) — source(s) b have not finished loading');
  });
});

test('a negative feature matcher grows its settle window again after a short recheck misses the never-idle signal', async () => {
  const calls: { method: string; budget?: number }[] = [];
  const settles = [
    { idle: false, never: true }, // enough frames for the first loop diagnosis
    { idle: false, never: false }, // the 500ms recheck saw too few frames on a slow renderer
    { idle: true, never: false }, // the longer look can conclude absence safely
  ];
  let findCalls = 0;
  const scriptedPage = {
    evaluate: async (_fn: unknown, [method, , args]: [string, string, unknown[]]) => {
      if (method === 'settle') {
        const budget = args[0] as number;
        calls.push({ method, budget });
        return { missing: false, value: settles.shift() };
      }
      if (method === 'findChecked') {
        calls.push({ method });
        // A missing layer makes the first poll inconclusive despite the initial loop diagnosis.
        findCalls++;
        const value = findCalls === 1 ? { found: [], missingLayer: 'layer "missing" does not exist. Layers: (none)' } : { found: [] };
        return { missing: false, value };
      }
      throw new Error(`unexpected page call: ${method}`);
    },
  } as unknown as Page;
  const map = new MapHandle(scriptedPage);

  await geowrightExpect(map).not.toHaveFeature({ layer: 'missing' }, { timeout: 10_000 });

  expect(calls.filter((call) => call.method === 'settle').map((call) => call.budget)).toEqual([500, 500, 2000]);
  expect(calls.map((call) => call.method)).toEqual(['settle', 'findChecked', 'settle', 'findChecked', 'settle', 'findChecked']);
});

test('waitForIdle sizes its resent in-page wait from the time left after engine injection', async () => {
  const realNow = Date.now;
  let now = 10_000;
  const budgets: number[] = [];
  Date.now = () => now;
  try {
    const scriptedPage = {
      evaluate: async (fnOrSource: unknown, payload?: [string, string, unknown[]]) => {
        if (typeof fnOrSource === 'string') {
          now += 5_500; // The engine injection consumed most of the original timeout.
          return undefined;
        }
        const [method, , args] = payload!;
        if (method !== 'waitForIdle') throw new Error(`unexpected page call: ${method}`);
        budgets.push(args[0] as number);
        if (budgets.length === 1) {
          now += 1_000; // The page's missing-engine probe also took time.
          return { missing: true };
        }
        return { missing: false, value: true };
      },
    } as unknown as Page;

    await new MapHandle(scriptedPage).waitForIdle({ timeout: 8_000 });

    expect(budgets).toEqual([2_000, 750]);
  } finally {
    Date.now = realNow;
  }
});
